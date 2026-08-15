# Revising to a multi-generation platform

Status: proposal, 2026-08-16. Supersedes nothing yet — MVP 1 for SPIKE Prime
continues as planned.

The brief is right about the important thing: the UI, safety model, telemetry,
input handling, mission runtime and (later) vision are generation-independent,
and only the hardware conversation changes per LEGO generation. Everything below
accepts that and argues with three specifics.

---

## 1. The proposed adapter interface puts safety in the wrong place

The brief's `RobotAdapter` includes `acquireControlLease`, `releaseControlLease`,
`setMotorTargets`, `emergencyStop` and `resetEmergencyStop`. Those are kernel
concerns, and moving them into the adapter would undo the property this codebase
is built around.

Right now there is exactly one implementation of the control lease, sequence
validation, freshness, clamping and the emergency latch. It is a pure reducer
with 47 tests including nine property-based invariants, and its Python mirror is
held to it by 413 committed golden-vector steps. If each adapter implements its
own lease, then "the lease cannot be bypassed" stops being a property of the
system and becomes a claim about eleven separate files — and the golden vectors
stop proving anything about the generations that need the guarantee most, which
are precisely the legacy ones where the hub cannot help.

The adapter belongs strictly *below* the kernel:

```
operator client ── host protocol (JSON, carries the lease)
        │
        ▼
   safety kernel          ← ONE implementation, generation-independent
        │  approved, limited, ramped motor values
        ▼
   robot adapter          ← generation-specific, dumb by construction
        │
        ▼
     hardware
```

So the interface should be roughly:

```ts
interface RobotAdapter {
  readonly adapterId: string;
  readonly family: RobotFamily;

  discover(): Promise<DiscoveredRobot[]>;
  connect(options: ConnectionOptions): Promise<void>;
  disconnect(): Promise<void>;
  readonly state: ConnectionState;

  capabilities(): RobotCapabilities;
  configure(configuration: RobotConfiguration): Promise<void>;

  /** Receives values the kernel has ALREADY approved. Must not re-decide. */
  applyMotors(values: MotorFrame): void;
  /** Best-effort immediate zero. The kernel has already zeroed its own output. */
  stop(reason: StopReason): void;
  /** Push the latch down to the hardware where the hardware supports one. */
  latchEmergencyStop(): void;
  clearEmergencyStop(): void;

  subscribeTelemetry(listener: TelemetryListener): Unsubscribe;
}
```

No lease, no sequence numbers, no TTL. An adapter that cannot be trusted with a
lease is an adapter that never sees one.

The capability manifest from the brief is a good idea and should be adopted
close to as written, with one addition (below).

## 2. Two motors is baked into a contract that is already frozen

This is the expensive part, and the brief does not mention it.

The current wire format is `DRIVE(left i16, right i16)`. Kernel state is a
`Vec2`. The web app's mixers, the simulator's physics, the Python mirror, and all
413 golden-vector steps encode `left`/`right`. EV3 has four motor ports, NXT has
three, RCX has three outputs. A drive base is two of them; the rest are arms,
grabbers and launchers, and those move too — an auxiliary motor is not
safety-exempt just because it does not propel the robot.

Generalizing from a pair to a channel map is a breaking change to:

- `packages/protocol/src/scs.ts` — DRIVE payload shape, and the 15-byte payload
  budget that keeps a frame inside one minimum-MTU BLE write
- `packages/protocol/src/host.ts` — the JSON drive command
- `packages/safety-kernel/src/kernel.ts` — state, clamping, ramping
- `packages/safety-kernel/vectors/` — all 413 steps, regenerated
- `apps/bridge/spike_bridge/kernel.py` — the mirror
- `packages/simulator`, `packages/device-adapters`, `apps/web`

**Do it before writing any second adapter, not after.** Adapters written against
a two-motor contract all get rewritten otherwise, and the golden vectors would
have to be regenerated twice.

Concretely: motors become an ordered, fixed-length channel vector whose length
and port labels come from the capability manifest; `Vec2` becomes the
two-channel special case that the arcade/tank mixers emit. The frame budget
needs re-checking at four channels (4 × i16 = 8 bytes, still inside the 15-byte
payload — fine), and the vector format goes to `formatVersion: 2`.

This is worth doing on its own merits even if no second generation ships,
because SPIKE Prime itself has six ports and MVP 1 only drives two of them.

## 3. Name it without "LEGO"

The brief proposes "LEGO Robotics Control Studio". LEGO's Fair Play guidelines
ask that the LEGO trademark not appear in third-party product names — the
convention is to name the product neutrally and state compatibility in prose
("works with LEGO® MINDSTORMS® EV3"). Worth confirming against the current
guidelines before any public naming, especially for something aimed at schools.
A neutral name also survives adding a non-LEGO platform later, which the PRD
already lists as a goal.

---

## 4. Safety enforcement becomes a first-class, displayed property

The brief's enforcement-level table is the right idea and maps cleanly onto the
three watchdogs this system already has:

| Layer | Exists when | Stops the robot if |
|---|---|---|
| Input release (UI) | always | operator lets go |
| Host lease TTL (kernel) | always | operator intent goes stale |
| Hub watchdog (on-brick agent) | only where an agent can run | the link dies |

So the capability manifest carries an enforcement level, and the UI shows it
without blocking anything:

```json
{
  "safety": {
    "enforcement": "hub+host",
    "hubWatchdogMs": 250,
    "emergencyLatch": "hub",
    "notes": "Agent resident in slot 0; stops independently on link loss."
  }
}
```

- `hub+host` — SPIKE, Robot Inventor, and any generation running a resident agent
- `host` — direct-command modes: the brick will happily keep executing the last
  command forever, so only the host stops it, and only while the host is alive
- `transport` — the stop itself has to travel a link that may be gone (RCX
  infrared, out of line of sight)

The rule this implies: **remote operation over the internet should require
`hub+host`.** Local, supervised, in-the-room driving can run at `host`. That is a
better line than restricting power or hiding features, and it matches the PRD's
existing stance of informing rather than blocking.

## 5. Sequencing

**Phase 0 — channel generalization (prerequisite).** Section 2. No new hardware.
Ends with `formatVersion: 2` vectors, both kernels passing, six-port SPIKE
support in the UI.

**Phase 1 — Robot Inventor 51515.** If the research confirms it is the same hub
to Pybricks, this is a product-identity change and not an adapter: hub naming,
default port suggestions, templates, imagery, setup copy. Cheap, and it doubles
the addressable hardware.

**Phase 2 — EV3.** The real prize for schools, and the one that most needs a
resident agent so it can reach `hub+host`. Adapter selection depends on the
research verdict below.

**Phase 3 — NXT.** Bridge-only. Direct-command adapter first for setup and
diagnostics; resident agent for anything unsupervised.

**Phase 4 — RCX.** Only if the research says the tower is still practical. Label
it a legacy lab, cap expectations in the UI, and never advertise
internet driving on it.

---

## 6. Hardware verdicts

Pending verification. The brief's claims about EV3-in-Pybricks-4.x, a Pybricks
NXT firmware artifact, ev3dev's current health, and the RCX USB tower on modern
Linux all need checking against primary sources before any of them turns into a
milestone. This section gets filled in with a per-generation
SUPPORTED-NOW / NEEDS-WORK / IMPRACTICAL verdict, the specific transport and
library for each, and a list of claims that did not survive checking.

A generation with no verified path gets cut rather than shipped as a broken
adapter — a control surface that looks like it works and does not is worse than
one that is absent, and that is doubly true for the ones that cannot hold a
hub-side watchdog.
