"""Python mirror of the TypeScript safety kernel.

This is a deliberate, tightly-scoped duplication. The bridge process is the
Robot Host in bridge and Raspberry Pi modes -- it is the machine physically
attached to the robot -- so it has to make the safety decisions itself rather
than trusting an operator client across a link that may have stalled.

The reference implementation is packages/safety-kernel/src/kernel.ts. This file
must behave identically, and that is enforced rather than hoped for: both replay
the committed golden vectors in packages/safety-kernel/vectors/. If you change
behavior here, change it there, regenerate the vectors, and make sure both
suites still pass.

Like the reference, this is pure: no IO, no timers, no clock reads. The caller
injects ``now_ms`` from a *monotonic* source.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Any, Literal

TTL_MIN_MS = 150
TTL_DEFAULT_MS = 600
TTL_MAX_MS = 10_000

# Largest step the ramp integrator honors, so a long pause cannot become one
# huge jump.
MAX_DT_MS = 1000


@dataclass(frozen=True)
class SafetyConfig:
    max_power: float
    command_timeout_ms: int
    accel_ramp_per_sec: float | None
    latency_warn_ms: int | None
    latency_stop_ms: int | None

    @staticmethod
    def from_json(raw: dict[str, Any]) -> "SafetyConfig":
        return SafetyConfig(
            max_power=float(raw["maxPower"]),
            command_timeout_ms=int(raw["commandTimeoutMs"]),
            accel_ramp_per_sec=_opt_float(raw.get("accelRampPerSec")),
            latency_warn_ms=_opt_int(raw.get("latencyWarnMs")),
            latency_stop_ms=_opt_int(raw.get("latencyStopMs")),
        )


def _opt_float(value: Any) -> float | None:
    return None if value is None else float(value)


def _opt_int(value: Any) -> int | None:
    return None if value is None else int(value)


@dataclass(frozen=True)
class Lease:
    lease_id: str
    owner_id: str
    session_id: str


@dataclass(frozen=True)
class Vec2:
    left: float = 0.0
    right: float = 0.0


@dataclass(frozen=True)
class KernelState:
    profile_id: str
    config: SafetyConfig
    estop_latched: bool = False
    lease: Lease | None = None
    last_sequence: int = -1
    last_command_mono: float | None = None
    rearm_required: bool = False
    requested: Vec2 = field(default_factory=Vec2)
    applied: Vec2 = field(default_factory=Vec2)
    last_step_mono: float = 0.0
    transport_up: bool = True
    latency_ms: float | None = None
    latency_stopped: bool = False


Action = dict[str, Any]
StepResult = tuple[KernelState, list[Action]]

RejectReason = Literal[
    "malformed",
    "no_lease",
    "not_owner",
    "wrong_session",
    "stale_sequence",
    "estop_latched",
    "rearm_required",
    "transport_down",
    "latency_stopped",
    "bad_ttl",
    "unknown_lease",
]


def create_initial_state(
    config: SafetyConfig, profile_id: str, now_ms: float = 0.0
) -> KernelState:
    return KernelState(
        profile_id=profile_id,
        config=normalize_config(config),
        last_step_mono=now_ms,
    )


def normalize_config(config: SafetyConfig) -> SafetyConfig:
    """Force a config into the range the kernel will honor.

    Expert Mode may relax the soft limits; it can never widen these bounds,
    because they are the limits themselves rather than a policy on top.
    """
    ramp = config.accel_ramp_per_sec
    if ramp is None or not math.isfinite(ramp):
        normalized_ramp = None
    else:
        normalized_ramp = max(0.01, ramp)

    return SafetyConfig(
        max_power=_clamp(config.max_power, 0.01, 1.0),
        command_timeout_ms=int(
            round(_clamp(float(config.command_timeout_ms), TTL_MIN_MS, TTL_MAX_MS))
        ),
        accel_ramp_per_sec=normalized_ramp,
        latency_warn_ms=_positive_or_none(config.latency_warn_ms),
        latency_stop_ms=_positive_or_none(config.latency_stop_ms),
    )


def _positive_or_none(value: int | None) -> int | None:
    if value is None:
        return None
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        return None
    return int(round(number))


def _clamp(value: float, lo: float, hi: float) -> float:
    if not math.isfinite(value):
        return lo
    return max(lo, min(hi, value))


def _norm_zero(value: float) -> float:
    """Collapse negative zero so serialization matches the reference exactly."""
    return 0.0 if value == 0 else value


def _sanitize_intent(value: Any) -> float:
    """Operator intent is normalized power by contract.

    Anything else is a protocol violation, and the safe reading of a violation
    is the nearest legal value. Sanitizing at intake also keeps kernel state
    JSON-representable, which vector replay depends on.
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return _norm_zero(max(-1.0, min(1.0, number)))


def _hard_stop_reason(state: KernelState) -> str | None:
    """Any condition under which motors must be at zero, whatever the operator wants."""
    if state.estop_latched:
        return "emergency_stop"
    if not state.transport_up:
        return "transport_down"
    if state.latency_stopped:
        return "latency_exceeded"
    if state.rearm_required:
        return "lease_expired"
    if state.lease is None:
        return "control_released"
    return None


class _Draft:
    """Mutable working copy, frozen back into a KernelState at the end of a step."""

    __slots__ = (
        "profile_id",
        "config",
        "estop_latched",
        "lease",
        "last_sequence",
        "last_command_mono",
        "rearm_required",
        "requested",
        "applied",
        "last_step_mono",
        "transport_up",
        "latency_ms",
        "latency_stopped",
    )

    def __init__(self, state: KernelState) -> None:
        self.profile_id = state.profile_id
        self.config = state.config
        self.estop_latched = state.estop_latched
        self.lease = state.lease
        self.last_sequence = state.last_sequence
        self.last_command_mono = state.last_command_mono
        self.rearm_required = state.rearm_required
        self.requested = state.requested
        self.applied = state.applied
        self.last_step_mono = state.last_step_mono
        self.transport_up = state.transport_up
        self.latency_ms = state.latency_ms
        self.latency_stopped = state.latency_stopped

    def freeze(self) -> KernelState:
        return KernelState(
            profile_id=self.profile_id,
            config=self.config,
            estop_latched=self.estop_latched,
            lease=self.lease,
            last_sequence=self.last_sequence,
            last_command_mono=self.last_command_mono,
            rearm_required=self.rearm_required,
            requested=self.requested,
            applied=self.applied,
            last_step_mono=self.last_step_mono,
            transport_up=self.transport_up,
            latency_ms=self.latency_ms,
            latency_stopped=self.latency_stopped,
        )


def step(prev: KernelState, event: dict[str, Any], now_ms: float) -> StepResult:
    actions: list[Action] = []
    draft = _Draft(prev)

    _apply_event(draft, event, now_ms, actions)
    _enforce_lease_expiry(draft, now_ms)
    _resolve_motors(draft, now_ms, actions)

    draft.last_step_mono = now_ms
    return draft.freeze(), actions


def _apply_event(
    draft: _Draft, event: dict[str, Any], now_ms: float, actions: list[Action]
) -> None:
    kind = event.get("kind")

    if kind == "tick":
        return

    if kind == "malformed":
        actions.append({"kind": "reject", "reason": "malformed"})
        return

    if kind == "transport":
        up = bool(event.get("up"))
        if up == draft.transport_up:
            return
        draft.transport_up = up
        if not up:
            draft.requested = Vec2()
            # A lease cannot outlive the link that carries it.
            draft.rearm_required = draft.lease is not None
        return

    if kind == "latency":
        round_trip = float(event.get("roundTripMs", 0))
        draft.latency_ms = round_trip
        stop_ms = draft.config.latency_stop_ms
        warn_ms = draft.config.latency_warn_ms
        if stop_ms is not None and round_trip > stop_ms:
            if not draft.latency_stopped:
                draft.latency_stopped = True
                draft.requested = Vec2()
        elif draft.latency_stopped:
            draft.latency_stopped = False
            actions.append({"kind": "warn", "code": "latency_recovered"})
        if warn_ms is not None and round_trip > warn_ms and not draft.latency_stopped:
            actions.append({"kind": "warn", "code": "latency_high"})
        return

    if kind == "command":
        _apply_command(draft, event["command"], now_ms, actions)


def _apply_command(
    draft: _Draft, command: dict[str, Any], now_ms: float, actions: list[Action]
) -> None:
    kind = command.get("type")

    if kind == "emergency_stop":
        if not draft.estop_latched:
            draft.estop_latched = True
            draft.requested = Vec2()
            actions.append({"kind": "latchEstop", "reason": command.get("reason", "")})
        return

    if kind == "emergency_reset":
        if not draft.estop_latched:
            return
        draft.estop_latched = False
        draft.requested = Vec2()
        # Coming out of a latch always costs a re-arm.
        draft.rearm_required = draft.lease is not None
        actions.append({"kind": "clearEstop"})
        return

    if kind == "control_grant":
        if draft.estop_latched:
            actions.append({"kind": "reject", "reason": "estop_latched"})
            return
        if not draft.transport_up:
            actions.append({"kind": "reject", "reason": "transport_down"})
            return
        # A fresh grant supersedes the previous holder. One driver, always.
        draft.lease = Lease(
            lease_id=command["leaseId"],
            owner_id=command["senderId"],
            session_id=command["sessionId"],
        )
        draft.last_sequence = int(command["sequence"])
        draft.last_command_mono = now_ms
        draft.rearm_required = False
        draft.requested = Vec2()
        return

    if kind == "control_release":
        if not _owns_lease(draft, command, actions):
            return
        draft.lease = None
        draft.requested = Vec2()
        draft.last_command_mono = None
        draft.last_sequence = -1
        draft.rearm_required = False
        return

    if kind == "safety_config":
        draft.config = normalize_config(SafetyConfig.from_json(command["config"]))
        draft.profile_id = command["profileId"]
        draft.requested = Vec2()
        return

    if kind == "stop":
        if not _owns_lease(draft, command, actions):
            return
        if not _accept_sequence(draft, int(command["sequence"]), actions):
            return
        draft.last_command_mono = now_ms
        draft.requested = Vec2()
        # A deliberate stop is a valid re-arm: intent is unambiguously zero.
        draft.rearm_required = False
        return

    if kind == "drive":
        if draft.estop_latched:
            actions.append({"kind": "reject", "reason": "estop_latched"})
            return
        if not draft.transport_up:
            actions.append({"kind": "reject", "reason": "transport_down"})
            return
        ttl_ms = int(command["ttlMs"])
        if ttl_ms < TTL_MIN_MS or ttl_ms > TTL_MAX_MS:
            actions.append({"kind": "reject", "reason": "bad_ttl"})
            return
        if not _owns_lease(draft, command, actions):
            return
        if not _accept_sequence(draft, int(command["sequence"]), actions):
            return

        left = _sanitize_intent(command["left"])
        right = _sanitize_intent(command["right"])
        is_zero = command["left"] == 0 and command["right"] == 0

        if draft.rearm_required:
            if not is_zero:
                actions.append({"kind": "reject", "reason": "rearm_required"})
                return
            draft.rearm_required = False
        if draft.latency_stopped:
            actions.append({"kind": "reject", "reason": "latency_stopped"})
            return

        draft.last_command_mono = now_ms
        draft.requested = Vec2(left=left, right=right)


def _owns_lease(draft: _Draft, command: dict[str, Any], actions: list[Action]) -> bool:
    lease = draft.lease
    if lease is None:
        actions.append({"kind": "reject", "reason": "no_lease"})
        return False
    if lease.session_id != command["sessionId"]:
        actions.append({"kind": "reject", "reason": "wrong_session"})
        return False
    if lease.lease_id != command["leaseId"]:
        actions.append({"kind": "reject", "reason": "unknown_lease"})
        return False
    if lease.owner_id != command["senderId"]:
        actions.append({"kind": "reject", "reason": "not_owner"})
        return False
    return True


def _accept_sequence(draft: _Draft, sequence: int, actions: list[Action]) -> bool:
    if sequence <= draft.last_sequence:
        actions.append({"kind": "reject", "reason": "stale_sequence"})
        return False
    draft.last_sequence = sequence
    return True


def _enforce_lease_expiry(draft: _Draft, now_ms: float) -> None:
    if draft.rearm_required or draft.lease is None or draft.last_command_mono is None:
        return
    if now_ms - draft.last_command_mono <= draft.config.command_timeout_ms:
        return
    draft.rearm_required = True
    draft.requested = Vec2()


def _resolve_motors(draft: _Draft, now_ms: float, actions: list[Action]) -> None:
    stop = _hard_stop_reason(draft)
    if stop is not None:
        # Safety stops never ramp. Zero is immediate.
        if draft.applied.left != 0 or draft.applied.right != 0:
            draft.applied = Vec2()
            actions.append({"kind": "stopMotors", "reason": stop})
        return

    max_power = draft.config.max_power
    target = Vec2(
        left=_limit(draft.requested.left, max_power),
        right=_limit(draft.requested.right, max_power),
    )

    dt_ms = _clamp(now_ms - draft.last_step_mono, 0, MAX_DT_MS)
    ramp = draft.config.accel_ramp_per_sec
    if ramp is None:
        nxt = target
    else:
        nxt = Vec2(
            left=_ramp_toward(draft.applied.left, target.left, ramp, dt_ms),
            right=_ramp_toward(draft.applied.right, target.right, ramp, dt_ms),
        )

    if nxt.left == draft.applied.left and nxt.right == draft.applied.right:
        return

    draft.applied = nxt
    if nxt.left == 0 and nxt.right == 0:
        actions.append({"kind": "stopMotors", "reason": "input_released"})
    else:
        actions.append({"kind": "applyMotor", "left": nxt.left, "right": nxt.right})


def _limit(value: float, max_power: float) -> float:
    """Scale intent by the profile ceiling, then hard-clamp to hardware range.

    The clamp is the non-disableable half: no configuration, expert or
    otherwise, can produce |power| > 1.
    """
    if not math.isfinite(value):
        return 0.0
    return _norm_zero(max(-1.0, min(1.0, value * max_power)))


def _ramp_toward(current: float, target: float, rate_per_sec: float, dt_ms: float) -> float:
    max_delta = rate_per_sec * (dt_ms / 1000.0)
    delta = target - current
    if abs(delta) <= max_delta:
        return _norm_zero(target)
    sign = 1.0 if delta > 0 else -1.0
    return _norm_zero(current + sign * max_delta)


def observable(state: KernelState) -> dict[str, Any]:
    """The subset of state asserted by the golden vectors.

    Internal bookkeeping may differ between the two implementations; anything a
    robot can observe must match exactly.
    """
    return {
        "estopLatched": state.estop_latched,
        "leaseId": None if state.lease is None else state.lease.lease_id,
        "ownerId": None if state.lease is None else state.lease.owner_id,
        "lastSequence": state.last_sequence,
        "rearmRequired": state.rearm_required,
        "transportUp": state.transport_up,
        "latencyStopped": state.latency_stopped,
        "requested": {
            "left": round_power(state.requested.left),
            "right": round_power(state.requested.right),
        },
        "applied": {
            "left": round_power(state.applied.left),
            "right": round_power(state.applied.right),
        },
    }


def round_power(value: float) -> float:
    """Match the reference's six-decimal rounding.

    Uses explicit floor-based rounding rather than Python's round(), which is
    banker's rounding and disagrees with JavaScript's Math.round on exact
    halves.
    """
    scaled = value * 1e6
    rounded = math.floor(scaled + 0.5) if scaled >= 0 else -math.floor(-scaled + 0.5)
    result = rounded / 1e6
    return 0.0 if result == 0 else result


def canonical_actions(actions: list[Action]) -> list[Action]:
    out: list[Action] = []
    for action in actions:
        if action["kind"] == "applyMotor":
            out.append(
                {
                    "kind": "applyMotor",
                    "left": round_power(action["left"]),
                    "right": round_power(action["right"]),
                }
            )
        else:
            out.append(action)
    return out


__all__ = [
    "SafetyConfig",
    "KernelState",
    "Lease",
    "Vec2",
    "create_initial_state",
    "normalize_config",
    "step",
    "observable",
    "canonical_actions",
    "round_power",
    "TTL_MIN_MS",
    "TTL_DEFAULT_MS",
    "TTL_MAX_MS",
]
