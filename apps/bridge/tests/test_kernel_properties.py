"""Hypothesis mirrors of the fast-check invariants in the TypeScript kernel.

Vector replay proves the two kernels agree on the scenarios we thought to write
down. These properties prove the Python side is independently safe on inputs
nobody wrote down. Both matter: agreement with a wrong reference would still be
wrong.

Kept in step with packages/safety-kernel/src/kernel.test.ts -- if you add an
invariant there, add it here.
"""

from __future__ import annotations

import json
import math
from typing import Any

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from spike_bridge.kernel import (
    TTL_MAX_MS,
    TTL_MIN_MS,
    SafetyConfig,
    create_initial_state,
    normalize_config,
    observable,
    step,
)

SESSION = "session_1"
OWNER = "user_owner"
LEASE = "lease_1"

HOST_VERSION = 1


def grant(sequence: int, sender: str = OWNER, lease: str = LEASE) -> dict[str, Any]:
    return {
        "version": HOST_VERSION,
        "type": "control_grant",
        "sessionId": SESSION,
        "sequence": sequence,
        "sentAt": 0,
        "leaseId": lease,
        "senderId": sender,
    }


def drive(
    sequence: int,
    left: float,
    right: float,
    sender: str = OWNER,
    lease: str = LEASE,
    session: str = SESSION,
    ttl_ms: int = 600,
) -> dict[str, Any]:
    return {
        "version": HOST_VERSION,
        "type": "drive",
        "sessionId": session,
        "sequence": sequence,
        "sentAt": 0,
        "leaseId": lease,
        "senderId": sender,
        "ttlMs": ttl_ms,
        "mode": "manual",
        "left": left,
        "right": right,
    }


def estop(sequence: int) -> dict[str, Any]:
    return {
        "version": HOST_VERSION,
        "type": "emergency_stop",
        "sessionId": SESSION,
        "sequence": sequence,
        "sentAt": 0,
        "eventId": f"estop_{sequence}",
        "senderId": OWNER,
        "reason": "operator_pressed",
    }


def reset(sequence: int) -> dict[str, Any]:
    return {
        "version": HOST_VERSION,
        "type": "emergency_reset",
        "sessionId": SESSION,
        "sequence": sequence,
        "sentAt": 0,
        "eventId": f"reset_{sequence}",
        "senderId": OWNER,
    }


configs = st.builds(
    SafetyConfig,
    max_power=st.one_of(
        st.floats(min_value=-10, max_value=10, allow_nan=False, allow_infinity=False),
        st.just(1e9),
    ),
    command_timeout_ms=st.one_of(
        st.integers(min_value=TTL_MIN_MS, max_value=2000),
        st.integers(min_value=-1000, max_value=100_000),
    ),
    accel_ramp_per_sec=st.one_of(
        st.none(),
        st.floats(min_value=-5, max_value=50, allow_nan=False, allow_infinity=False),
    ),
    latency_warn_ms=st.one_of(st.none(), st.integers(min_value=-100, max_value=5000)),
    latency_stop_ms=st.one_of(st.none(), st.integers(min_value=-100, max_value=5000)),
)

senders = st.sampled_from([OWNER, OWNER, OWNER, OWNER, "user_intruder", "user_third"])
leases = st.sampled_from([LEASE, LEASE, LEASE, LEASE, "lease_other"])
sessions = st.sampled_from([SESSION, SESSION, SESSION, SESSION, "session_other"])
powers = st.one_of(
    st.floats(min_value=-1, max_value=1, allow_nan=False, allow_infinity=False),
    st.floats(min_value=-1000, max_value=1000, allow_nan=False, allow_infinity=False),
    st.sampled_from([math.inf, -math.inf, math.nan]),
)

drafts = st.one_of(
    st.tuples(
        st.just("drive"), senders, leases, sessions, powers, powers,
        st.integers(min_value=0, max_value=20_000),
    ),
    st.just(("tick",)),
    st.tuples(st.just("grant"), senders, leases),
    st.just(("estop",)),
    st.just(("reset",)),
    st.just(("malformed",)),
    st.tuples(st.just("transport"), st.booleans()),
    st.tuples(st.just("latency"), st.integers(min_value=0, max_value=10_000)),
)

scripts = st.lists(
    st.tuples(drafts, st.integers(min_value=0, max_value=400)),
    min_size=1,
    max_size=40,
)


def build_timeline(script: list[tuple[Any, int]]) -> list[tuple[dict[str, Any], int]]:
    """Turn drafts into concrete events, opening with a valid lease.

    Seeding the lease matters: without it nearly every generated drive is
    rejected with `no_lease` and the properties never reach the states they are
    meant to constrain. The TypeScript suite has an explicit coverage guard for
    the same reason.
    """
    out: list[tuple[dict[str, Any], int]] = [({"kind": "command", "command": grant(0)}, 0)]
    now = 0
    seq = 0
    for draft, gap in script:
        now += gap
        seq += 1
        tag = draft[0]
        if tag == "tick":
            out.append(({"kind": "tick"}, now))
        elif tag == "malformed":
            out.append(({"kind": "malformed"}, now))
        elif tag == "transport":
            out.append(({"kind": "transport", "up": draft[1]}, now))
        elif tag == "latency":
            out.append(({"kind": "latency", "roundTripMs": draft[1]}, now))
        elif tag == "estop":
            out.append(({"kind": "command", "command": estop(seq)}, now))
        elif tag == "reset":
            out.append(({"kind": "command", "command": reset(seq)}, now))
        elif tag == "grant":
            out.append(
                ({"kind": "command", "command": grant(seq, draft[1], draft[2])}, now)
            )
        elif tag == "drive":
            _, sender, lease, session, left, right, ttl = draft
            out.append(
                (
                    {
                        "kind": "command",
                        "command": drive(seq, left, right, sender, lease, session, ttl),
                    },
                    now,
                )
            )
    return out


PROPERTY_SETTINGS = settings(
    max_examples=200,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)


@given(configs, scripts)
@PROPERTY_SETTINGS
def test_never_commands_a_motor_beyond_hardware_range(config, script) -> None:
    state = create_initial_state(config, "fuzz", 0)
    for event, now in build_timeline(script):
        state, actions = step(state, event, now)
        for action in actions:
            if action["kind"] == "applyMotor":
                assert abs(action["left"]) <= 1
                assert abs(action["right"]) <= 1
                assert math.isfinite(action["left"])
                assert math.isfinite(action["right"])


@given(configs, scripts)
@PROPERTY_SETTINGS
def test_never_exceeds_the_effective_profile_ceiling(config, script) -> None:
    effective = normalize_config(config)
    state = create_initial_state(config, "fuzz", 0)
    for event, now in build_timeline(script):
        state, actions = step(state, event, now)
        for action in actions:
            if action["kind"] == "applyMotor":
                assert abs(action["left"]) <= effective.max_power + 1e-9
                assert abs(action["right"]) <= effective.max_power + 1e-9


@given(configs, scripts)
@PROPERTY_SETTINGS
def test_never_moves_without_a_live_lease(config, script) -> None:
    state = create_initial_state(config, "fuzz", 0)
    for event, now in build_timeline(script):
        state, actions = step(state, event, now)
        if any(action["kind"] == "applyMotor" for action in actions):
            assert state.lease is not None
            assert not state.rearm_required
            assert not state.estop_latched
            assert state.transport_up


@given(configs, scripts)
@PROPERTY_SETTINGS
def test_never_moves_while_emergency_stopped(config, script) -> None:
    state = create_initial_state(config, "fuzz", 0)
    for event, now in build_timeline(script):
        state, actions = step(state, event, now)
        if state.estop_latched:
            assert state.applied.left == 0 and state.applied.right == 0
            assert not any(action["kind"] == "applyMotor" for action in actions)


@given(configs, scripts)
@PROPERTY_SETTINGS
def test_latch_clears_only_on_explicit_reset(config, script) -> None:
    state = create_initial_state(config, "fuzz", 0)
    for event, now in build_timeline(script):
        was_latched = state.estop_latched
        state, _ = step(state, event, now)
        if was_latched and not state.estop_latched:
            assert event["kind"] == "command"
            assert event["command"]["type"] == "emergency_reset"


@given(configs, scripts)
@PROPERTY_SETTINGS
def test_silence_past_the_timeout_always_stops_the_motors(config, script) -> None:
    effective = normalize_config(config)
    timeline = build_timeline(script)
    state = create_initial_state(config, "fuzz", 0)
    for event, now in timeline:
        state, _ = step(state, event, now)
    last_time = timeline[-1][1]
    state, _ = step(state, {"kind": "tick"}, last_time + effective.command_timeout_ms + 1)
    assert state.applied.left == 0 and state.applied.right == 0


@given(configs)
@PROPERTY_SETTINGS
def test_no_config_can_disable_core_protections(config) -> None:
    effective = normalize_config(config)
    assert effective.max_power > 0
    assert effective.max_power <= 1
    assert effective.command_timeout_ms >= TTL_MIN_MS
    assert effective.command_timeout_ms <= TTL_MAX_MS
    if effective.accel_ramp_per_sec is not None:
        assert effective.accel_ramp_per_sec > 0


@given(configs, scripts)
@PROPERTY_SETTINGS
def test_a_rejected_command_never_becomes_operator_intent(config, script) -> None:
    state = create_initial_state(config, "fuzz", 0)
    for event, now in build_timeline(script):
        before = state.requested
        state, actions = step(state, event, now)
        if any(action["kind"] == "reject" for action in actions):
            assert abs(state.requested.left) <= abs(before.left) + 1e-9
            assert abs(state.requested.right) <= abs(before.right) + 1e-9


@given(configs, scripts)
@PROPERTY_SETTINGS
def test_state_always_survives_a_json_round_trip(config, script) -> None:
    state = create_initial_state(config, "fuzz", 0)
    for event, now in build_timeline(script):
        state, _ = step(state, event, now)
        for value in (
            state.requested.left,
            state.requested.right,
            state.applied.left,
            state.applied.right,
        ):
            assert math.isfinite(value)
            assert abs(value) <= 1
        snapshot = observable(state)
        # allow_nan=False makes a non-representable value raise rather than
        # emit the invalid JSON that json.dumps would otherwise produce.
        assert json.loads(json.dumps(snapshot, allow_nan=False)) == snapshot
