/**
 * The kernel's safety invariants, stated as properties.
 *
 * Every property here is mirrored by a Hypothesis test against the Python
 * kernel in apps/bridge/tests/. If you add one, add it there too — the two
 * implementations are only as equivalent as their shared proofs.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  HOST_PROTOCOL_VERSION,
  TTL_DEFAULT_MS,
  TTL_MAX_MS,
  TTL_MIN_MS,
  type HostCommand,
  type SafetyConfig,
} from "@spike/protocol";
import {
  createInitialState,
  normalizeConfig,
  step,
  type KernelAction,
  type KernelEvent,
  type KernelState,
  type RejectReason,
} from "./kernel.js";
import { BALANCED_CONFIG, DEMO_CONFIG, PERFORMANCE_CONFIG } from "./profiles.js";
import { observable } from "./vectors.js";

const SESSION = "session_1";
const OWNER = "user_owner";
const LEASE = "lease_1";

function grant(sequence = 0): HostCommand {
  return {
    version: HOST_PROTOCOL_VERSION,
    type: "control_grant",
    sessionId: SESSION,
    sequence,
    sentAt: 0,
    leaseId: LEASE,
    senderId: OWNER,
  };
}

function drive(
  sequence: number,
  left: number,
  right: number,
  over: Partial<{ leaseId: string; senderId: string; sessionId: string; ttlMs: number }> = {},
): HostCommand {
  return {
    version: HOST_PROTOCOL_VERSION,
    type: "drive",
    sessionId: over.sessionId ?? SESSION,
    sequence,
    sentAt: 0,
    leaseId: over.leaseId ?? LEASE,
    senderId: over.senderId ?? OWNER,
    ttlMs: over.ttlMs ?? TTL_DEFAULT_MS,
    mode: "manual",
    left,
    right,
  };
}

function estop(sequence: number): HostCommand {
  return {
    version: HOST_PROTOCOL_VERSION,
    type: "emergency_stop",
    sessionId: SESSION,
    sequence,
    sentAt: 0,
    eventId: `estop_${sequence}`,
    senderId: OWNER,
    reason: "operator_pressed",
  };
}

function reset(sequence: number): HostCommand {
  return {
    version: HOST_PROTOCOL_VERSION,
    type: "emergency_reset",
    sessionId: SESSION,
    sequence,
    sentAt: 0,
    eventId: `reset_${sequence}`,
    senderId: OWNER,
  };
}

/** Run a scripted sequence of (event, time) pairs and collect everything emitted. */
function run(
  initial: KernelState,
  script: ReadonlyArray<readonly [KernelEvent, number]>,
): { state: KernelState; actions: KernelAction[]; perStep: KernelAction[][] } {
  let state = initial;
  const actions: KernelAction[] = [];
  const perStep: KernelAction[][] = [];
  for (const [event, now] of script) {
    const result = step(state, event, now);
    state = result.state;
    actions.push(...result.actions);
    perStep.push(result.actions);
  }
  return { state, actions, perStep };
}

function motorActions(actions: readonly KernelAction[]) {
  return actions.filter((a): a is Extract<KernelAction, { kind: "applyMotor" }> =>
    a.kind === "applyMotor",
  );
}

/** A driving robot: lease granted, one drive accepted, ramp settled. */
function driving(config: SafetyConfig = PERFORMANCE_CONFIG) {
  const start = createInitialState(config, "test", 0);
  return run(start, [
    [{ kind: "command", command: grant(0) }, 0],
    [{ kind: "command", command: drive(1, 1, 1) }, 10],
    [{ kind: "tick" }, 20],
  ]);
}

describe("scripted behavior", () => {
  it("drives once a lease is granted", () => {
    const { state } = driving();
    expect(state.applied.left).toBeGreaterThan(0);
    expect(state.applied.right).toBeGreaterThan(0);
  });

  it("refuses to move without a lease", () => {
    const start = createInitialState(PERFORMANCE_CONFIG, "test", 0);
    const { actions, state } = run(start, [
      [{ kind: "command", command: drive(1, 1, 1) }, 10],
      [{ kind: "tick" }, 20],
    ]);
    expect(motorActions(actions)).toHaveLength(0);
    expect(state.applied).toEqual({ left: 0, right: 0 });
    expect(actions.some((a) => a.kind === "reject" && a.reason === "no_lease")).toBe(true);
  });

  it("scales operator intent by the profile ceiling", () => {
    const { state } = driving(DEMO_CONFIG);
    // Demo caps at 35 %; a full-deflection stick must not exceed it.
    expect(state.applied.left).toBeLessThanOrEqual(DEMO_CONFIG.maxPower);
  });

  it("stops when the lease goes quiet for longer than its timeout", () => {
    const start = createInitialState(PERFORMANCE_CONFIG, "test", 0);
    const timeout = PERFORMANCE_CONFIG.commandTimeoutMs;
    const { state, perStep } = run(start, [
      [{ kind: "command", command: grant(0) }, 0],
      [{ kind: "command", command: drive(1, 1, 1) }, 10],
      [{ kind: "tick" }, 20],
      [{ kind: "tick" }, 20 + timeout + 1],
    ]);
    expect(state.applied).toEqual({ left: 0, right: 0 });
    expect(state.rearmRequired).toBe(true);
    const last = perStep[perStep.length - 1] ?? [];
    expect(last.some((a) => a.kind === "stopMotors" && a.reason === "lease_expired")).toBe(true);
  });

  it("refuses a burst of queued motion after the lease expired, until re-armed", () => {
    const start = createInitialState(PERFORMANCE_CONFIG, "test", 0);
    const timeout = PERFORMANCE_CONFIG.commandTimeoutMs;
    // The operator's link stalls, the lease expires, then everything the client
    // buffered arrives at once. None of it may move the robot.
    const { state, actions } = run(start, [
      [{ kind: "command", command: grant(0) }, 0],
      [{ kind: "command", command: drive(1, 1, 1) }, 10],
      [{ kind: "tick" }, 20 + timeout + 1],
      [{ kind: "command", command: drive(2, 1, 1) }, 20 + timeout + 2],
      [{ kind: "command", command: drive(3, 1, 1) }, 20 + timeout + 3],
      [{ kind: "tick" }, 20 + timeout + 4],
    ]);
    expect(state.applied).toEqual({ left: 0, right: 0 });
    expect(actions.filter((a) => a.kind === "reject" && a.reason === "rearm_required")).toHaveLength(
      2,
    );
  });

  it("re-arms on a zero command and drives again", () => {
    const start = createInitialState(PERFORMANCE_CONFIG, "test", 0);
    const timeout = PERFORMANCE_CONFIG.commandTimeoutMs;
    const { state } = run(start, [
      [{ kind: "command", command: grant(0) }, 0],
      [{ kind: "command", command: drive(1, 1, 1) }, 10],
      [{ kind: "tick" }, 20 + timeout + 1],
      [{ kind: "command", command: drive(2, 0, 0) }, 20 + timeout + 2],
      [{ kind: "command", command: drive(3, 0.5, 0.5) }, 20 + timeout + 3],
      [{ kind: "tick" }, 20 + timeout + 20],
    ]);
    expect(state.applied.left).toBeCloseTo(0.5, 5);
  });

  it("latches emergency stop until an explicit reset", () => {
    const start = createInitialState(PERFORMANCE_CONFIG, "test", 0);
    const { state, actions } = run(start, [
      [{ kind: "command", command: grant(0) }, 0],
      [{ kind: "command", command: drive(1, 1, 1) }, 10],
      [{ kind: "tick" }, 20],
      [{ kind: "command", command: estop(2) }, 30],
      [{ kind: "command", command: drive(3, 1, 1) }, 40],
      [{ kind: "tick" }, 50],
    ]);
    expect(state.estopLatched).toBe(true);
    expect(state.applied).toEqual({ left: 0, right: 0 });
    expect(actions.some((a) => a.kind === "latchEstop")).toBe(true);
    expect(actions.some((a) => a.kind === "reject" && a.reason === "estop_latched")).toBe(true);
  });

  it("still requires a re-arm after an emergency reset", () => {
    const start = createInitialState(PERFORMANCE_CONFIG, "test", 0);
    const { state, actions } = run(start, [
      [{ kind: "command", command: grant(0) }, 0],
      [{ kind: "command", command: drive(1, 1, 1) }, 10],
      [{ kind: "command", command: estop(2) }, 20],
      [{ kind: "command", command: reset(3) }, 30],
      [{ kind: "command", command: drive(4, 1, 1) }, 40],
      [{ kind: "tick" }, 50],
    ]);
    expect(state.estopLatched).toBe(false);
    expect(state.applied).toEqual({ left: 0, right: 0 });
    expect(actions.some((a) => a.kind === "reject" && a.reason === "rearm_required")).toBe(true);
  });

  it("rejects a command from someone who is not the lease owner", () => {
    const start = createInitialState(PERFORMANCE_CONFIG, "test", 0);
    const { state, actions } = run(start, [
      [{ kind: "command", command: grant(0) }, 0],
      [{ kind: "command", command: drive(1, 1, 1, { senderId: "user_intruder" }) }, 10],
      [{ kind: "tick" }, 20],
    ]);
    expect(state.applied).toEqual({ left: 0, right: 0 });
    expect(actions.some((a) => a.kind === "reject" && a.reason === "not_owner")).toBe(true);
  });

  it("rejects a replayed sequence number", () => {
    const start = createInitialState(PERFORMANCE_CONFIG, "test", 0);
    const { actions } = run(start, [
      [{ kind: "command", command: grant(0) }, 0],
      [{ kind: "command", command: drive(5, 0.5, 0.5) }, 10],
      [{ kind: "command", command: drive(3, 1, 1) }, 20],
      [{ kind: "tick" }, 30],
    ]);
    expect(actions.some((a) => a.kind === "reject" && a.reason === "stale_sequence")).toBe(true);
  });

  it("stops when the transport drops", () => {
    const start = createInitialState(PERFORMANCE_CONFIG, "test", 0);
    const { state, perStep } = run(start, [
      [{ kind: "command", command: grant(0) }, 0],
      [{ kind: "command", command: drive(1, 1, 1) }, 10],
      [{ kind: "tick" }, 20],
      [{ kind: "transport", up: false }, 30],
    ]);
    expect(state.applied).toEqual({ left: 0, right: 0 });
    const last = perStep[perStep.length - 1] ?? [];
    expect(last.some((a) => a.kind === "stopMotors" && a.reason === "transport_down")).toBe(true);
  });

  it("ramps rather than stepping when the profile asks for it", () => {
    const start = createInitialState(BALANCED_CONFIG, "test", 0);
    const { state } = run(start, [
      [{ kind: "command", command: grant(0) }, 0],
      [{ kind: "command", command: drive(1, 1, 1) }, 0],
      [{ kind: "tick" }, 50],
    ]);
    // 3.0/s for 50 ms is 0.15, well short of the 0.65 ceiling.
    expect(state.applied.left).toBeCloseTo(0.15, 5);
  });

  it("zeroes instantly on a safety stop even mid-ramp", () => {
    const start = createInitialState(BALANCED_CONFIG, "test", 0);
    const { state } = run(start, [
      [{ kind: "command", command: grant(0) }, 0],
      [{ kind: "command", command: drive(1, 1, 1) }, 0],
      [{ kind: "tick" }, 100],
      [{ kind: "command", command: estop(2) }, 101],
    ]);
    expect(state.applied).toEqual({ left: 0, right: 0 });
  });

  it("stops on latency above the profile threshold and refuses to drive through it", () => {
    const start = createInitialState(BALANCED_CONFIG, "test", 0);
    const { state, actions } = run(start, [
      [{ kind: "command", command: grant(0) }, 0],
      [{ kind: "command", command: drive(1, 1, 1) }, 10],
      [{ kind: "tick" }, 100],
      [{ kind: "latency", roundTripMs: 5000 }, 110],
      [{ kind: "command", command: drive(2, 1, 1) }, 120],
      [{ kind: "tick" }, 130],
    ]);
    expect(state.applied).toEqual({ left: 0, right: 0 });
    expect(actions.some((a) => a.kind === "reject" && a.reason === "latency_stopped")).toBe(true);
  });

  it("never acts on a malformed message", () => {
    const start = createInitialState(PERFORMANCE_CONFIG, "test", 0);
    const { state, actions } = run(start, [
      [{ kind: "command", command: grant(0) }, 0],
      [{ kind: "malformed", detail: "not json" }, 10],
      [{ kind: "tick" }, 20],
    ]);
    expect(motorActions(actions)).toHaveLength(0);
    expect(state.applied).toEqual({ left: 0, right: 0 });
    expect(actions.some((a) => a.kind === "reject" && a.reason === "malformed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/**
 * The generator models a real control session with adversarial noise mixed in,
 * rather than uniform random garbage. A uniform generator spends nearly all of
 * its time emergency-stopped with mismatched lease identity, so it never
 * reaches the states the invariants are about — see the vacuity guard below.
 */
const arbConfig: fc.Arbitrary<SafetyConfig> = fc.record({
  // Deliberately unreasonable inputs: an Expert profile must not be able to
  // widen the bounds by asking nicely.
  maxPower: fc.oneof(fc.double({ min: -10, max: 10, noNaN: true }), fc.constant(1e9)),
  commandTimeoutMs: fc.oneof(
    // Weighted toward timeouts short enough that expiry is actually reachable
    // within a generated script, while still covering absurd requests.
    { weight: 6, arbitrary: fc.integer({ min: TTL_MIN_MS, max: 2000 }) },
    { weight: 2, arbitrary: fc.integer({ min: -1000, max: 100_000 }) },
    { weight: 1, arbitrary: fc.constant(Number.MAX_SAFE_INTEGER) },
  ),
  accelRampPerSec: fc.option(fc.double({ min: -5, max: 50, noNaN: true }), { nil: null }),
  latencyWarnMs: fc.option(fc.integer({ min: -100, max: 5000 }), { nil: null }),
  latencyStopMs: fc.option(fc.integer({ min: -100, max: 5000 }), { nil: null }),
});

/** Mostly the legitimate value, occasionally an impostor. */
const arbSender = fc.oneof(
  { weight: 8, arbitrary: fc.constant(OWNER) },
  { weight: 1, arbitrary: fc.constant("user_intruder") },
  { weight: 1, arbitrary: fc.constant("user_third") },
);
const arbLeaseId = fc.oneof(
  { weight: 8, arbitrary: fc.constant(LEASE) },
  { weight: 1, arbitrary: fc.constant("lease_other") },
);
const arbSessionId = fc.oneof(
  { weight: 8, arbitrary: fc.constant(SESSION) },
  { weight: 1, arbitrary: fc.constant("session_other") },
);
const arbTtl = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: TTL_MIN_MS, max: TTL_MAX_MS }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 20_000 }) },
);
const arbPower = fc.oneof(
  { weight: 6, arbitrary: fc.double({ min: -1, max: 1, noNaN: true }) },
  // Out-of-contract values, to prove the clamp is structural rather than a
  // consequence of upstream validation.
  { weight: 1, arbitrary: fc.double({ min: -1000, max: 1000, noNaN: true }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
  },
);
/** Sequence numbers mostly advance by one; sometimes they stall or regress. */
const arbSeqDelta = fc.oneof(
  { weight: 8, arbitrary: fc.constant(1) },
  { weight: 2, arbitrary: fc.integer({ min: -3, max: 3 }) },
);
/** Realistic 20 Hz cadence, with occasional hiccups and full stalls. */
const arbGap = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0, max: 60 }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 400 }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 3000 }) },
);

type Draft =
  | { t: "grant"; sender: string; lease: string; seqDelta: number }
  | {
      t: "drive";
      sender: string;
      lease: string;
      session: string;
      seqDelta: number;
      left: number;
      right: number;
      ttlMs: number;
    }
  | { t: "stop"; sender: string; lease: string; session: string; seqDelta: number }
  | { t: "estop"; seqDelta: number }
  | { t: "reset"; seqDelta: number }
  | { t: "tick" }
  | { t: "malformed" }
  | { t: "transport"; up: boolean }
  | { t: "latency"; ms: number };

const arbDraft: fc.Arbitrary<Draft> = fc.oneof(
  {
    weight: 12,
    arbitrary: fc.record({
      t: fc.constant("drive" as const),
      sender: arbSender,
      lease: arbLeaseId,
      session: arbSessionId,
      seqDelta: arbSeqDelta,
      left: arbPower,
      right: arbPower,
      ttlMs: arbTtl,
    }),
  },
  { weight: 6, arbitrary: fc.constant({ t: "tick" as const }) },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("grant" as const),
      sender: arbSender,
      lease: arbLeaseId,
      seqDelta: arbSeqDelta,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("stop" as const),
      sender: arbSender,
      lease: arbLeaseId,
      session: arbSessionId,
      seqDelta: arbSeqDelta,
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("estop" as const), seqDelta: arbSeqDelta }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("reset" as const), seqDelta: arbSeqDelta }) },
  { weight: 1, arbitrary: fc.constant({ t: "malformed" as const }) },
  {
    weight: 2,
    arbitrary: fc
      .oneof(
        { weight: 2, arbitrary: fc.constant(true) },
        { weight: 1, arbitrary: fc.constant(false) },
      )
      .map((up) => ({ t: "transport" as const, up })),
  },
  {
    weight: 1,
    arbitrary: fc
      .integer({ min: 0, max: 10_000 })
      .map((ms) => ({ t: "latency" as const, ms })),
  },
);

/**
 * A generated session. `seeded` opens with a valid lease most of the time —
 * without it, fast-check's bias toward short arrays means most scripts contain
 * no `control_grant` at all, every drive is rejected with `no_lease`, and the
 * properties never reach the states they are meant to constrain.
 */
const arbScript = fc.record({
  seeded: fc.oneof(
    { weight: 6, arbitrary: fc.constant(true) },
    { weight: 1, arbitrary: fc.constant(false) },
  ),
  drafts: fc.array(fc.tuple(arbDraft, arbGap), { minLength: 4, maxLength: 60 }),
});

type Script = { seeded: boolean; drafts: ReadonlyArray<readonly [Draft, number]> };

/**
 * Turn drafts into a concrete timeline: relative gaps become monotonic absolute
 * times, and sequence deltas accumulate into real sequence numbers.
 */
function timeline(script: Script): ReadonlyArray<readonly [KernelEvent, number]> {
  let now = 0;
  let seq = 0;
  const out: Array<readonly [KernelEvent, number]> = [];
  if (script.seeded) out.push([{ kind: "command", command: grant(seq) }, now]);
  for (const [draft, gap] of script.drafts) {
    now += gap;
    if ("seqDelta" in draft) seq = Math.max(0, seq + draft.seqDelta);
    switch (draft.t) {
      case "tick":
        out.push([{ kind: "tick" }, now]);
        break;
      case "malformed":
        out.push([{ kind: "malformed" }, now]);
        break;
      case "transport":
        out.push([{ kind: "transport", up: draft.up }, now]);
        break;
      case "latency":
        out.push([{ kind: "latency", roundTripMs: draft.ms }, now]);
        break;
      case "estop":
        out.push([{ kind: "command", command: estop(seq) }, now]);
        break;
      case "reset":
        out.push([{ kind: "command", command: reset(seq) }, now]);
        break;
      case "grant":
        out.push([
          {
            kind: "command",
            command: {
              version: HOST_PROTOCOL_VERSION,
              type: "control_grant",
              sessionId: SESSION,
              sequence: seq,
              sentAt: 0,
              leaseId: draft.lease,
              senderId: draft.sender,
            },
          },
          now,
        ]);
        break;
      case "stop":
        out.push([
          {
            kind: "command",
            command: {
              version: HOST_PROTOCOL_VERSION,
              type: "stop",
              sessionId: draft.session,
              sequence: seq,
              sentAt: 0,
              leaseId: draft.lease,
              senderId: draft.sender,
              reason: "input_released",
            },
          },
          now,
        ]);
        break;
      case "drive":
        out.push([
          {
            kind: "command",
            command: {
              version: HOST_PROTOCOL_VERSION,
              type: "drive",
              sessionId: draft.session,
              sequence: seq,
              sentAt: 0,
              leaseId: draft.lease,
              senderId: draft.sender,
              ttlMs: draft.ttlMs,
              mode: "manual",
              left: draft.left,
              right: draft.right,
            },
          },
          now,
        ]);
        break;
    }
  }
  return out;
}

describe("invariants", () => {
  it("1. never commands a motor beyond hardware range", () => {
    fc.assert(
      fc.property(arbConfig, arbScript, (config, script) => {
        const start = createInitialState(config, "fuzz", 0);
        const { actions, state } = run(start, timeline(script));
        for (const action of motorActions(actions)) {
          expect(Math.abs(action.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(action.right)).toBeLessThanOrEqual(1);
          expect(Number.isFinite(action.left)).toBe(true);
          expect(Number.isFinite(action.right)).toBe(true);
        }
        expect(Math.abs(state.applied.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(state.applied.right)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 400 },
    );
  });

  it("2. never exceeds the effective profile ceiling", () => {
    fc.assert(
      fc.property(arbConfig, arbScript, (config, script) => {
        const effective = normalizeConfig(config);
        const start = createInitialState(config, "fuzz", 0);
        const { actions } = run(start, timeline(script));
        for (const action of motorActions(actions)) {
          expect(Math.abs(action.left)).toBeLessThanOrEqual(effective.maxPower + 1e-9);
          expect(Math.abs(action.right)).toBeLessThanOrEqual(effective.maxPower + 1e-9);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("3. never moves without a live lease held by the sender", () => {
    fc.assert(
      fc.property(arbConfig, arbScript, (config, script) => {
        let state = createInitialState(config, "fuzz", 0);
        for (const [event, now] of timeline(script)) {
          const result = step(state, event, now);
          if (motorActions(result.actions).length > 0) {
            expect(result.state.lease).not.toBeNull();
            expect(result.state.rearmRequired).toBe(false);
            expect(result.state.estopLatched).toBe(false);
            expect(result.state.transportUp).toBe(true);
          }
          state = result.state;
        }
      }),
      { numRuns: 400 },
    );
  });

  it("4. never moves while an emergency stop is latched", () => {
    fc.assert(
      fc.property(arbConfig, arbScript, (config, script) => {
        let state = createInitialState(config, "fuzz", 0);
        for (const [event, now] of timeline(script)) {
          const result = step(state, event, now);
          if (result.state.estopLatched) {
            expect(result.state.applied).toEqual({ left: 0, right: 0 });
            expect(motorActions(result.actions)).toHaveLength(0);
          }
          state = result.state;
        }
      }),
      { numRuns: 400 },
    );
  });

  it("5. a latched stop is only ever cleared by an explicit reset", () => {
    fc.assert(
      fc.property(arbConfig, arbScript, (config, script) => {
        let state = createInitialState(config, "fuzz", 0);
        for (const [event, now] of timeline(script)) {
          const wasLatched = state.estopLatched;
          const result = step(state, event, now);
          if (wasLatched && !result.state.estopLatched) {
            expect(event.kind).toBe("command");
            expect(event.kind === "command" && event.command.type).toBe("emergency_reset");
          }
          state = result.state;
        }
      }),
      { numRuns: 400 },
    );
  });

  it("6. silence longer than the timeout always brings motors to zero", () => {
    fc.assert(
      fc.property(arbConfig, arbScript, (config, script) => {
        const effective = normalizeConfig(config);
        const start = createInitialState(config, "fuzz", 0);
        const scripted = timeline(script);
        const lastTime = scripted[scripted.length - 1]?.[1] ?? 0;
        const { state } = run(start, [
          ...scripted,
          // One tick well past any possible timeout, with nothing in between.
          [{ kind: "tick" }, lastTime + effective.commandTimeoutMs + 1],
        ]);
        expect(state.applied).toEqual({ left: 0, right: 0 });
      }),
      { numRuns: 400 },
    );
  });

  it("7. no configuration can disable expiration, ownership, or clamping", () => {
    fc.assert(
      fc.property(arbConfig, (config) => {
        const effective = normalizeConfig(config);
        expect(effective.maxPower).toBeGreaterThan(0);
        expect(effective.maxPower).toBeLessThanOrEqual(1);
        expect(effective.commandTimeoutMs).toBeGreaterThanOrEqual(TTL_MIN_MS);
        expect(effective.commandTimeoutMs).toBeLessThanOrEqual(TTL_MAX_MS);
        if (effective.accelRampPerSec !== null) {
          expect(effective.accelRampPerSec).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("0. the fuzzer actually reaches motion (guards against vacuous properties)", () => {
    // Every invariant below is of the form "when moving, X holds". If the
    // generated scripts never moved the robot, they would all pass while
    // proving nothing. This asserts the generator is doing real work.
    const reached = { motion: 0, estop: 0, expiry: 0, transportDown: 0, latencyStop: 0, scripts: 0 };
    const rejectCounts: Record<string, number> = {};
    const stopCounts: Record<string, number> = {};
    fc.assert(
      fc.property(arbConfig, arbScript, (config, script) => {
        let state = createInitialState(config, "fuzz", 0);
        const hit = { motion: false, estop: false, expiry: false, down: false, latency: false };
        for (const [event, now] of timeline(script)) {
          const result = step(state, event, now);
          for (const a of result.actions) {
            if (a.kind === "reject") rejectCounts[a.reason] = (rejectCounts[a.reason] ?? 0) + 1;
            if (a.kind === "stopMotors") stopCounts[a.reason] = (stopCounts[a.reason] ?? 0) + 1;
          }
          if (motorActions(result.actions).length > 0) hit.motion = true;
          if (result.state.estopLatched) hit.estop = true;
          if (result.state.rearmRequired) hit.expiry = true;
          if (!result.state.transportUp) hit.down = true;
          if (result.state.latencyStopped) hit.latency = true;
          state = result.state;
        }
        reached.scripts += 1;
        if (hit.motion) reached.motion += 1;
        if (hit.estop) reached.estop += 1;
        if (hit.expiry) reached.expiry += 1;
        if (hit.down) reached.transportDown += 1;
        if (hit.latency) reached.latencyStop += 1;
      }),
      // Fixed seed: this test asserts generator coverage, so it must not vary
      // run to run. The invariant properties below stay seed-random.
      { numRuns: 400, seed: 20260815 },
    );
    // Thresholds sit roughly half-way below what the generator actually
    // achieves, so they catch a generator regression without being brittle.
    // Measured at this seed: motion 214, estop 132, expiry 196, down 88, latency 81.
    const atLeast = (fraction: number) => Math.floor(reached.scripts * fraction);
    expect(reached.motion).toBeGreaterThan(atLeast(0.4));
    expect(reached.estop).toBeGreaterThan(atLeast(0.2));
    expect(reached.expiry).toBeGreaterThan(atLeast(0.25));
    expect(reached.transportDown).toBeGreaterThan(atLeast(0.1));
    expect(reached.latencyStop).toBeGreaterThan(atLeast(0.1));

    // Every defensive branch must actually be reached. A reason that stops
    // appearing means the generator drifted away from the case it guards.
    const allReasons: RejectReason[] = [
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
    ];
    for (const reason of allReasons) {
      expect(rejectCounts[reason] ?? 0, `reject reason never exercised: ${reason}`).toBeGreaterThan(
        0,
      );
    }
    for (const reason of ["input_released", "emergency_stop", "lease_expired", "transport_down", "latency_exceeded"]) {
      expect(stopCounts[reason] ?? 0, `stop reason never exercised: ${reason}`).toBeGreaterThan(0);
    }
  });

  it("9. kernel state always survives a JSON round trip", () => {
    // The Python mirror is kept honest by replaying JSON vectors, so any state
    // the kernel can reach must be representable in JSON. A stored NaN or
    // Infinity would serialize to null and silently diverge on replay.
    fc.assert(
      fc.property(arbConfig, arbScript, (config, script) => {
        let state = createInitialState(config, "fuzz", 0);
        for (const [event, now] of timeline(script)) {
          state = step(state, event, now).state;
          for (const value of [
            state.requested.left,
            state.requested.right,
            state.applied.left,
            state.applied.right,
          ]) {
            expect(Number.isFinite(value)).toBe(true);
            expect(Math.abs(value)).toBeLessThanOrEqual(1);
          }
          const snapshot = observable(state);
          expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("8. a rejected command never becomes operator intent", () => {
    // Stated on `requested`, not `applied`: a step that rejects something may
    // still ramp *applied* upward toward a target an earlier accepted command
    // established. What must never happen is a rejected command raising intent.
    fc.assert(
      fc.property(arbConfig, arbScript, (config, script) => {
        let state = createInitialState(config, "fuzz", 0);
        for (const [event, now] of timeline(script)) {
          const before = { ...state.requested };
          const result = step(state, event, now);
          if (result.actions.some((a) => a.kind === "reject")) {
            expect(Math.abs(result.state.requested.left)).toBeLessThanOrEqual(
              Math.abs(before.left) + 1e-9,
            );
            expect(Math.abs(result.state.requested.right)).toBeLessThanOrEqual(
              Math.abs(before.right) + 1e-9,
            );
          }
          state = result.state;
        }
      }),
      { numRuns: 400 },
    );
  });
});
