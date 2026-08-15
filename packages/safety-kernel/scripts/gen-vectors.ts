/**
 * Regenerate the committed golden vectors from the TypeScript reference kernel.
 *
 *   pnpm --filter @spike/safety-kernel gen:vectors
 *
 * Run this whenever kernel behavior changes on purpose, commit the result, and
 * make sure the Python conformance suite still passes. If it does not, the two
 * kernels have diverged and one of them is wrong.
 *
 * Everything here is deterministic: scenarios are hand-written, and the fuzz
 * section uses a seeded generator rather than Math.random, so regenerating on an
 * unchanged kernel produces a byte-identical file.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_PROTOCOL_VERSION, TTL_DEFAULT_MS, type HostCommand } from "@spike/protocol";
import { createInitialState, step, type KernelEvent } from "../src/kernel.js";
import { BALANCED_CONFIG, DEMO_CONFIG, PERFORMANCE_CONFIG } from "../src/profiles.js";
import {
  canonicalActions,
  observable,
  type Vector,
  type VectorFile,
  type VectorStep,
} from "../src/vectors.js";

const SESSION = "session_v";
const OWNER = "user_owner";
const LEASE = "lease_v";

function grant(sequence: number, senderId = OWNER, leaseId = LEASE): HostCommand {
  return {
    version: HOST_PROTOCOL_VERSION,
    type: "control_grant",
    sessionId: SESSION,
    sequence,
    sentAt: 0,
    leaseId,
    senderId,
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

const cmd = (command: HostCommand): KernelEvent => ({ kind: "command", command });
const tick: KernelEvent = { kind: "tick" };

function build(
  name: string,
  description: string,
  profileId: string,
  config: Vector["config"],
  script: ReadonlyArray<readonly [KernelEvent, number]>,
): Vector {
  let state = createInitialState(config, profileId, 0);
  const steps: VectorStep[] = [];
  for (const [event, nowMs] of script) {
    const result = step(state, event, nowMs);
    state = result.state;
    steps.push({
      event,
      nowMs,
      expect: { actions: canonicalActions(result.actions), state: observable(state) },
    });
  }
  return { name, description, profileId, config, steps };
}

const vectors: Vector[] = [
  build(
    "grant-drive-stop",
    "The ordinary path: take a lease, drive, release the stick.",
    "performance",
    PERFORMANCE_CONFIG,
    [
      [cmd(grant(0)), 0],
      [cmd(drive(1, 0.5, 0.5)), 50],
      [tick, 100],
      [cmd(drive(2, 1, -1)), 150],
      [tick, 200],
      [cmd(drive(3, 0, 0)), 250],
      [tick, 300],
    ],
  ),

  build(
    "profile-ceiling",
    "Demo profile scales a full-deflection stick down to its 35 % ceiling.",
    "demo",
    DEMO_CONFIG,
    [
      [cmd(grant(0)), 0],
      [cmd(drive(1, 1, 1)), 10],
      [tick, 500],
      [tick, 1000],
    ],
  ),

  build(
    "acceleration-ramp",
    "Balanced profile ramps toward the target instead of stepping to it.",
    "balanced",
    BALANCED_CONFIG,
    [
      [cmd(grant(0)), 0],
      [cmd(drive(1, 1, 1)), 0],
      [tick, 50],
      [tick, 100],
      [tick, 150],
      [tick, 400],
    ],
  ),

  build(
    "lease-expiry-and-rearm",
    "Silence past the timeout stops the robot; queued motion is refused until a zero command re-arms it.",
    "performance",
    PERFORMANCE_CONFIG,
    [
      [cmd(grant(0)), 0],
      [cmd(drive(1, 0.8, 0.8)), 10],
      [tick, 20],
      [tick, 1500],
      [cmd(drive(2, 0.8, 0.8)), 1510],
      [cmd(drive(3, 0.8, 0.8)), 1520],
      [cmd(drive(4, 0, 0)), 1530],
      [cmd(drive(5, 0.4, 0.4)), 1540],
      [tick, 1550],
    ],
  ),

  build(
    "estop-latches",
    "Emergency stop latches, refuses motion, and still needs a re-arm after reset.",
    "performance",
    PERFORMANCE_CONFIG,
    [
      [cmd(grant(0)), 0],
      [cmd(drive(1, 1, 1)), 10],
      [tick, 20],
      [cmd(estop(2)), 30],
      [cmd(drive(3, 1, 1)), 40],
      [tick, 50],
      [cmd(reset(4)), 60],
      [cmd(drive(5, 1, 1)), 70],
      [cmd(drive(6, 0, 0)), 80],
      [cmd(drive(7, 0.6, 0.6)), 90],
      [tick, 100],
    ],
  ),

  build(
    "ownership-and-sequence",
    "Non-owners, wrong leases, wrong sessions and replayed sequences are all refused.",
    "performance",
    PERFORMANCE_CONFIG,
    [
      [cmd(drive(1, 1, 1)), 0],
      [cmd(grant(2)), 10],
      [cmd(drive(3, 0.5, 0.5, { senderId: "user_intruder" })), 20],
      [cmd(drive(4, 0.5, 0.5, { leaseId: "lease_other" })), 30],
      [cmd(drive(5, 0.5, 0.5, { sessionId: "session_other" })), 40],
      [cmd(drive(6, 0.5, 0.5)), 50],
      [cmd(drive(4, 1, 1)), 60],
      [tick, 70],
    ],
  ),

  build(
    "transport-loss",
    "Losing the link stops the robot and costs a re-arm even after it comes back.",
    "performance",
    PERFORMANCE_CONFIG,
    [
      [cmd(grant(0)), 0],
      [cmd(drive(1, 0.7, 0.7)), 10],
      [tick, 20],
      [{ kind: "transport", up: false }, 30],
      [cmd(drive(2, 0.7, 0.7)), 40],
      [{ kind: "transport", up: true }, 50],
      [cmd(drive(3, 0.7, 0.7)), 60],
      [cmd(drive(4, 0, 0)), 70],
      [cmd(drive(5, 0.7, 0.7)), 80],
      [tick, 90],
    ],
  ),

  build(
    "latency-stop-and-recover",
    "Latency past the profile threshold stops the robot, and recovery is announced.",
    "balanced",
    BALANCED_CONFIG,
    [
      [cmd(grant(0)), 0],
      [cmd(drive(1, 1, 1)), 10],
      [tick, 300],
      [{ kind: "latency", roundTripMs: 400 }, 310],
      [{ kind: "latency", roundTripMs: 5000 }, 320],
      [cmd(drive(2, 1, 1)), 330],
      [{ kind: "latency", roundTripMs: 80 }, 340],
      [cmd(drive(3, 0, 0)), 350],
      [cmd(drive(4, 0.5, 0.5)), 360],
      [tick, 400],
    ],
  ),

  build(
    "malformed-never-moves",
    "Malformed traffic is recorded and ignored; it cannot refresh a lease.",
    "performance",
    PERFORMANCE_CONFIG,
    [
      [cmd(grant(0)), 0],
      [cmd(drive(1, 0.5, 0.5)), 10],
      [{ kind: "malformed", detail: "truncated json" }, 20],
      [{ kind: "malformed" }, 900],
      [tick, 1200],
    ],
  ),

  build(
    "out-of-contract-values",
    "Values outside the contract are clamped rather than trusted.",
    "performance",
    PERFORMANCE_CONFIG,
    [
      [cmd(grant(0)), 0],
      [cmd(drive(1, 42, -42)), 10],
      [tick, 20],
      [cmd(drive(2, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)), 30],
      [tick, 40],
      [cmd(drive(3, 0.5, 0.5, { ttlMs: 5 })), 50],
      [cmd(drive(4, 0.5, 0.5, { ttlMs: 999_999 })), 60],
      [tick, 70],
    ],
  ),

  build(
    "instructor-takeover",
    "A fresh grant supersedes the previous holder, and the old driver goes quiet.",
    "performance",
    PERFORMANCE_CONFIG,
    [
      [cmd(grant(0, OWNER, LEASE)), 0],
      [cmd(drive(1, 0.6, 0.6)), 10],
      [tick, 20],
      [cmd(grant(2, "user_instructor", "lease_instructor")), 30],
      [cmd(drive(3, 0.9, 0.9)), 40],
      [
        cmd(
          drive(4, 0.3, 0.3, { senderId: "user_instructor", leaseId: "lease_instructor" }),
        ),
        50,
      ],
      [tick, 60],
    ],
  ),
];

// A deterministic pseudo-random tail, so the vectors also cover interleavings
// nobody thought to hand-write. Seeded LCG — never Math.random, which would make
// regeneration produce a different file every time.
function lcg(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function fuzzVector(seed: number): Vector {
  const rand = lcg(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const script: Array<readonly [KernelEvent, number]> = [];
  let now = 0;
  let seq = 0;
  script.push([cmd(grant(seq)), now]);
  for (let i = 0; i < 40; i += 1) {
    now += Math.floor(rand() * 300);
    seq += 1;
    const roll = rand();
    if (roll < 0.55) {
      const left = Math.round((rand() * 2 - 1) * 100) / 100;
      const right = Math.round((rand() * 2 - 1) * 100) / 100;
      script.push([
        cmd(
          drive(seq, left, right, {
            senderId: pick([OWNER, OWNER, OWNER, "user_intruder"]),
            leaseId: pick([LEASE, LEASE, LEASE, "lease_other"]),
          }),
        ),
        now,
      ]);
    } else if (roll < 0.75) {
      script.push([tick, now]);
    } else if (roll < 0.82) {
      script.push([cmd(estop(seq)), now]);
    } else if (roll < 0.89) {
      script.push([cmd(reset(seq)), now]);
    } else if (roll < 0.95) {
      script.push([{ kind: "transport", up: rand() < 0.6 }, now]);
    } else {
      script.push([{ kind: "latency", roundTripMs: Math.floor(rand() * 4000) }, now]);
    }
  }
  return build(
    `fuzz-${seed}`,
    `Deterministic pseudo-random interleaving (seed ${seed}).`,
    "balanced",
    BALANCED_CONFIG,
    script,
  );
}

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  vectors.push(fuzzVector(seed));
}

const file: VectorFile = { formatVersion: 1, vectors };
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "vectors", "kernel-vectors.json");
writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, "utf8");

const stepCount = vectors.reduce((total, vector) => total + vector.steps.length, 0);
console.log(`wrote ${vectors.length} vectors, ${stepCount} steps -> ${target}`);
