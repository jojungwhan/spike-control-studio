/**
 * The Robot Host safety kernel.
 *
 * A pure reducer: `step(state, event, nowMs) -> { state, actions }`. No IO, no
 * timers, no clock reads inside — the host injects `nowMs` from a *monotonic*
 * source. That purity is what lets the Python mirror in the bridge be proven
 * equivalent by replaying committed golden vectors.
 *
 * Whoever runs this reducer is the Robot Host and is authoritative: in direct
 * Web Bluetooth mode that is the browser, in bridge/Pi mode it is the bridge
 * process. A remote client may request motion; only this file decides.
 */
import {
  TTL_MAX_MS,
  TTL_MIN_MS,
  type HostCommand,
  type SafetyConfig,
} from "@spike/protocol";

export interface Vec2 {
  left: number;
  right: number;
}

const ZERO: Vec2 = { left: 0, right: 0 };

export type KernelEvent =
  | { kind: "command"; command: HostCommand }
  /** A message that failed schema validation. Recorded, never acted on. */
  | { kind: "malformed"; detail?: string }
  | { kind: "tick" }
  | { kind: "transport"; up: boolean }
  | { kind: "latency"; roundTripMs: number };

export type KernelAction =
  | { kind: "applyMotor"; left: number; right: number }
  | { kind: "stopMotors"; reason: StopReason }
  | { kind: "latchEstop"; reason: string }
  | { kind: "clearEstop" }
  | { kind: "reject"; reason: RejectReason }
  | { kind: "warn"; code: WarnCode };

export type StopReason =
  | "lease_expired"
  | "input_released"
  | "emergency_stop"
  | "transport_down"
  | "latency_exceeded"
  | "control_released"
  | "config_changed";

export type RejectReason =
  | "malformed"
  | "no_lease"
  | "not_owner"
  | "wrong_session"
  | "stale_sequence"
  | "estop_latched"
  | "rearm_required"
  | "transport_down"
  | "latency_stopped"
  | "bad_ttl"
  | "unknown_lease";

export type WarnCode = "latency_high" | "latency_recovered";

export interface Lease {
  leaseId: string;
  ownerId: string;
  sessionId: string;
}

export interface KernelState {
  profileId: string;
  config: SafetyConfig;
  estopLatched: boolean;
  lease: Lease | null;
  /** Highest sequence accepted on the current lease. Resets when a lease is granted. */
  lastSequence: number;
  /** Monotonic receipt time of the last accepted command, or null. */
  lastCommandMono: number | null;
  /**
   * True once a lease has gone quiet for longer than its TTL. Motion stays
   * refused until the operator re-arms — either by sending a zero command or by
   * taking a fresh lease. This is what stops a burst of commands that queued up
   * behind a stalled link from driving an unattended robot.
   */
  rearmRequired: boolean;
  /** Last accepted operator intent, before profile limits. */
  requested: Vec2;
  /** What the motors are actually being told to do, after limits and ramping. */
  applied: Vec2;
  lastStepMono: number;
  transportUp: boolean;
  latencyMs: number | null;
  latencyStopped: boolean;
}

export interface StepResult {
  state: KernelState;
  actions: KernelAction[];
}

/** Largest step the ramp integrator will honor, so a long pause cannot become one huge jump. */
const MAX_DT_MS = 1000;

export function createInitialState(
  config: SafetyConfig,
  profileId: string,
  nowMs = 0,
): KernelState {
  return {
    profileId,
    config: normalizeConfig(config),
    estopLatched: false,
    lease: null,
    lastSequence: -1,
    lastCommandMono: null,
    rearmRequired: false,
    requested: { ...ZERO },
    applied: { ...ZERO },
    lastStepMono: nowMs,
    transportUp: true,
    latencyMs: null,
    latencyStopped: false,
  };
}

/**
 * Force a config into the range the kernel will honor. Expert Mode may relax
 * the soft limits; it can never widen these bounds, because they are the
 * limits themselves rather than a policy layered on top.
 */
export function normalizeConfig(config: SafetyConfig): SafetyConfig {
  return {
    maxPower: clamp(config.maxPower, 0.01, 1),
    commandTimeoutMs: Math.round(clamp(config.commandTimeoutMs, TTL_MIN_MS, TTL_MAX_MS)),
    accelRampPerSec:
      config.accelRampPerSec === null || !Number.isFinite(config.accelRampPerSec)
        ? null
        : Math.max(0.01, config.accelRampPerSec),
    latencyWarnMs: positiveOrNull(config.latencyWarnMs),
    latencyStopMs: positiveOrNull(config.latencyStopMs),
  };
}

function positiveOrNull(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

/** Any condition under which motors must be at zero, regardless of operator intent. */
function hardStopReason(state: KernelState): StopReason | null {
  if (state.estopLatched) return "emergency_stop";
  if (!state.transportUp) return "transport_down";
  if (state.latencyStopped) return "latency_exceeded";
  if (state.rearmRequired) return "lease_expired";
  if (state.lease === null) return "control_released";
  return null;
}

export function step(prev: KernelState, event: KernelEvent, nowMs: number): StepResult {
  const actions: KernelAction[] = [];
  const state: KernelState = {
    ...prev,
    config: prev.config,
    lease: prev.lease === null ? null : { ...prev.lease },
    requested: { ...prev.requested },
    applied: { ...prev.applied },
  };

  applyEvent(state, event, nowMs, actions);
  enforceLeaseExpiry(state, nowMs, actions);
  resolveMotors(state, nowMs, actions);

  state.lastStepMono = nowMs;
  return { state, actions };
}

function applyEvent(
  state: KernelState,
  event: KernelEvent,
  nowMs: number,
  actions: KernelAction[],
): void {
  switch (event.kind) {
    case "tick":
      return;

    case "malformed":
      actions.push({ kind: "reject", reason: "malformed" });
      return;

    case "transport": {
      if (event.up === state.transportUp) return;
      state.transportUp = event.up;
      if (!event.up) {
        state.requested = { ...ZERO };
        // A lease cannot outlive the link that carries it.
        state.rearmRequired = state.lease !== null;
      }
      return;
    }

    case "latency": {
      state.latencyMs = event.roundTripMs;
      const { latencyWarnMs, latencyStopMs } = state.config;
      if (latencyStopMs !== null && event.roundTripMs > latencyStopMs) {
        if (!state.latencyStopped) {
          state.latencyStopped = true;
          state.requested = { ...ZERO };
        }
      } else if (state.latencyStopped) {
        state.latencyStopped = false;
        actions.push({ kind: "warn", code: "latency_recovered" });
      }
      if (latencyWarnMs !== null && event.roundTripMs > latencyWarnMs && !state.latencyStopped) {
        actions.push({ kind: "warn", code: "latency_high" });
      }
      return;
    }

    case "command":
      applyCommand(state, event.command, nowMs, actions);
      return;
  }
}

function applyCommand(
  state: KernelState,
  command: HostCommand,
  nowMs: number,
  actions: KernelAction[],
): void {
  switch (command.type) {
    case "emergency_stop": {
      if (!state.estopLatched) {
        state.estopLatched = true;
        state.requested = { ...ZERO };
        actions.push({ kind: "latchEstop", reason: command.reason });
      }
      return;
    }

    case "emergency_reset": {
      if (!state.estopLatched) return;
      state.estopLatched = false;
      state.requested = { ...ZERO };
      // Coming out of a latch always costs a re-arm: the operator must show
      // current intent before anything moves again.
      state.rearmRequired = state.lease !== null;
      actions.push({ kind: "clearEstop" });
      return;
    }

    case "control_grant": {
      if (state.estopLatched) {
        actions.push({ kind: "reject", reason: "estop_latched" });
        return;
      }
      if (!state.transportUp) {
        actions.push({ kind: "reject", reason: "transport_down" });
        return;
      }
      // A fresh grant supersedes the previous holder. One driver, always.
      state.lease = {
        leaseId: command.leaseId,
        ownerId: command.senderId,
        sessionId: command.sessionId,
      };
      state.lastSequence = command.sequence;
      state.lastCommandMono = nowMs;
      state.rearmRequired = false;
      state.requested = { ...ZERO };
      return;
    }

    case "control_release": {
      if (!ownsLease(state, command.leaseId, command.senderId, command.sessionId, actions)) return;
      state.lease = null;
      state.requested = { ...ZERO };
      state.lastCommandMono = null;
      state.lastSequence = -1;
      state.rearmRequired = false;
      return;
    }

    case "safety_config": {
      state.config = normalizeConfig(command.config);
      state.profileId = command.profileId;
      // Limits changed underneath a moving robot: drop intent to zero and let
      // the operator's next command re-establish it under the new ceiling.
      state.requested = { ...ZERO };
      return;
    }

    case "stop": {
      if (!ownsLease(state, command.leaseId, command.senderId, command.sessionId, actions)) return;
      if (!acceptSequence(state, command.sequence, actions)) return;
      state.lastCommandMono = nowMs;
      state.requested = { ...ZERO };
      // A deliberate stop is also a valid re-arm: intent is unambiguously zero.
      state.rearmRequired = false;
      return;
    }

    case "drive": {
      if (state.estopLatched) {
        actions.push({ kind: "reject", reason: "estop_latched" });
        return;
      }
      if (!state.transportUp) {
        actions.push({ kind: "reject", reason: "transport_down" });
        return;
      }
      if (command.ttlMs < TTL_MIN_MS || command.ttlMs > TTL_MAX_MS) {
        actions.push({ kind: "reject", reason: "bad_ttl" });
        return;
      }
      if (!ownsLease(state, command.leaseId, command.senderId, command.sessionId, actions)) return;
      if (!acceptSequence(state, command.sequence, actions)) return;

      const isZero = command.left === 0 && command.right === 0;
      if (state.rearmRequired) {
        if (!isZero) {
          actions.push({ kind: "reject", reason: "rearm_required" });
          return;
        }
        state.rearmRequired = false;
      }
      if (state.latencyStopped) {
        actions.push({ kind: "reject", reason: "latency_stopped" });
        return;
      }

      state.lastCommandMono = nowMs;
      // Sanitize at intake so kernel state is always finite and in-contract.
      // Storing a raw NaN or Infinity would leave state that cannot be
      // serialized, which breaks golden-vector replay against the Python mirror
      // and would smuggle a non-finite value into the ramp integrator.
      state.requested = {
        left: sanitizeIntent(command.left),
        right: sanitizeIntent(command.right),
      };
      return;
    }
  }
}

function ownsLease(
  state: KernelState,
  leaseId: string,
  senderId: string,
  sessionId: string,
  actions: KernelAction[],
): boolean {
  const lease = state.lease;
  if (lease === null) {
    actions.push({ kind: "reject", reason: "no_lease" });
    return false;
  }
  if (lease.sessionId !== sessionId) {
    actions.push({ kind: "reject", reason: "wrong_session" });
    return false;
  }
  if (lease.leaseId !== leaseId) {
    actions.push({ kind: "reject", reason: "unknown_lease" });
    return false;
  }
  if (lease.ownerId !== senderId) {
    actions.push({ kind: "reject", reason: "not_owner" });
    return false;
  }
  return true;
}

function acceptSequence(state: KernelState, sequence: number, actions: KernelAction[]): boolean {
  if (sequence <= state.lastSequence) {
    actions.push({ kind: "reject", reason: "stale_sequence" });
    return false;
  }
  state.lastSequence = sequence;
  return true;
}

function enforceLeaseExpiry(state: KernelState, nowMs: number, actions: KernelAction[]): void {
  if (state.rearmRequired || state.lease === null || state.lastCommandMono === null) return;
  const age = nowMs - state.lastCommandMono;
  if (age <= state.config.commandTimeoutMs) return;
  state.rearmRequired = true;
  state.requested = { ...ZERO };
  void actions;
}

function resolveMotors(state: KernelState, nowMs: number, actions: KernelAction[]): void {
  const stop = hardStopReason(state);
  if (stop !== null) {
    // Safety stops never ramp. Zero is immediate.
    if (state.applied.left !== 0 || state.applied.right !== 0) {
      state.applied = { ...ZERO };
      actions.push({ kind: "stopMotors", reason: stop });
    }
    return;
  }

  const target: Vec2 = {
    left: limit(state.requested.left, state.config.maxPower),
    right: limit(state.requested.right, state.config.maxPower),
  };

  const dtMs = clamp(nowMs - state.lastStepMono, 0, MAX_DT_MS);
  const next = state.config.accelRampPerSec === null
    ? target
    : {
        left: rampToward(state.applied.left, target.left, state.config.accelRampPerSec, dtMs),
        right: rampToward(state.applied.right, target.right, state.config.accelRampPerSec, dtMs),
      };

  if (next.left === state.applied.left && next.right === state.applied.right) return;

  state.applied = next;
  if (next.left === 0 && next.right === 0) {
    actions.push({ kind: "stopMotors", reason: "input_released" });
  } else {
    actions.push({ kind: "applyMotor", left: next.left, right: next.right });
  }
}

/**
 * Collapse negative zero. -0 and 0 drive a motor identically, but they are
 * distinct values to `Object.is` and serialize differently, which would show up
 * as a phantom mismatch between the TypeScript kernel and its Python mirror
 * when replaying golden vectors.
 */
function normZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * Operator intent is normalized power by contract. Anything else is a protocol
 * violation, and the safe reading of a violation is the nearest legal value.
 */
function sanitizeIntent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return normZero(Math.max(-1, Math.min(1, value)));
}

/**
 * Scale operator intent by the profile ceiling, then hard-clamp to the hardware
 * range. The clamp is the non-disableable half: no configuration, expert or
 * otherwise, can produce |power| > 1.
 */
function limit(value: number, maxPower: number): number {
  if (!Number.isFinite(value)) return 0;
  const scaled = value * maxPower;
  return normZero(Math.max(-1, Math.min(1, scaled)));
}

function rampToward(current: number, target: number, ratePerSec: number, dtMs: number): number {
  const maxDelta = ratePerSec * (dtMs / 1000);
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return normZero(target);
  return normZero(current + Math.sign(delta) * maxDelta);
}
