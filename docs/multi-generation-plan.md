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

## 5. Hardware verdicts (verified against primary sources, 2026-08-16)

| Generation | Verdict | Transport that actually works | Library |
|---|---|---|---|
| SPIKE Prime 45678 | shipping | BLE Pybricks GATT | ours |
| Robot Inventor 51515 | **works today, zero code** | identical BLE GATT, identical firmware image | ours, unchanged |
| EV3, stock firmware | **the safe EV3 bet** | USB HID `0694:0005` · BT RFCOMM ch 1 · Wi-Fi UDP 3015 | `ev3-dc` |
| NXT, stock firmware | **works** | USB (pyusb) · BT RFCOMM ch 1 | `nxt-python` 3.5.1 + small stdlib-socket shim |
| EV3 / NXT + Pybricks fw | needs work, and the protocol is moving | **USB only** — no BLE at all | `pybricksdev` 2.3.2, pinned to fw 4.0.1 |
| RCX | **cut it** | kernel `legousbtower` char device | nothing in Python |

### What the brief got wrong

**"Pybricks EV3 exposes the same BLE stdio tunnel" — false, and it is the
load-bearing error.** The EV3 platform config compiles in *zero* LE hosts
(`PBDRV_CONFIG_BLUETOOTH_BTSTACK_NUM_LE_HOSTS (0)`); its Classic stack does
inquiry scanning and nothing resembling an RFCOMM host channel. NXT is worse:
`PBDRV_CONFIG_BLUETOOTH (0)` — Bluetooth is compiled out entirely. Under
Pybricks, EV3 and NXT are **USB-only devices**. Any `PybricksBleAdapter(EV3)` in
the design should be deleted before it is written.

**The Pybricks USB protocol is in flux right now.** Firmware ≤ 4.0.x speaks a
vendor-class USB interface (reachable by pyusb and WebUSB). Firmware 4.1.0b1
(2026-07-13) switched to CDC-ACM plus COBS framing — the hub appears as
`/dev/ttyACM0` and the host uses Web Serial. `pybricksdev` on PyPI (2.3.2,
2026-01-24) predates the switch and does not speak the new form. Pick one lane
and pin the firmware; do not straddle both in a first version.

**EV3 in Pybricks is understated, not overstated** — it is in *stable* 4.0.0/4.0.1,
not betas. But mailboxes, `speaker.say()`, filesystem access, `hub_menu` and hub
names do not exist there yet, and the EV3 hub docs page is a 404.

**ev3dev is not a viable base.** Last OS image April 2020 (Debian 9, EOL), no
news since July 2020, and Pybricks *removed* its ev3dev support in 4.0.0.
Recommending a 2020 Debian 9 SD card to schools in 2026 is a support liability.

**`legousbtower` was not removed from the kernel** — it got a use-after-free fix
in June 2026 and is a loadable module on this very machine. The driver is alive;
the *ecosystem* is dead. There is no Python library, only `nqc` as a subprocess.

**Do not use PyBluez** (0.23, 2019, and nxt-python's own docs warn the PyPI build
does not work with it). `socket.AF_BLUETOOTH` / `BTPROTO_RFCOMM` are in the
standard library and present on this box.

### Two findings that change the existing MVP 1 plan

**1. Web Bluetooth on Linux is flag-gated, which inverts the platform story.**
Chrome's Linux Web Bluetooth is "partially implemented and not supported" and
needs `chrome://flags/#enable-experimental-web-platform-features`. So the
zero-install browser path this product is built around does not work on a Linux
laptop or a Raspberry Pi without a flag — exactly the classroom and Pi cases in
the PRD. The consequence is genuinely counter-intuitive: once EV3 support lands,
**EV3 over Web Serial is more classroom-robust on Linux than SPIKE over Web
Bluetooth**. The bridge, not the browser, is the first-class Linux path, and the
setup docs should route Linux users there rather than to a chrome flag.

**2. Newly bought SPIKE hubs may not take the firmware version we pinned.**
Pybricks 4.1.0b1 added support for "a version of SPIKE Prime with slightly
updated electronics"; the 4.1.0b2 bundle ships two images, `prime_hub_f4` and
`prime_hub_h5`. A recently purchased hub may be the STM32H5 revision and require
the 4.1 **beta** line — while `docs/hardware-setup.md` currently pins 4.0.1.
**Check the hub revision before flashing at M7**, and be ready to pin 4.1 beta
instead.

## 6. Sequencing

**Phase 0 — channel generalization (prerequisite).** Section 2. No new hardware.
Ends with `formatVersion: 2` vectors, both kernels passing, and SPIKE's six ports
actually usable, which MVP 1 does not deliver today.

**Phase 1 — Robot Inventor 51515. Ship it now; it is documentation.** Pybricks
publishes one `pybricks-primehub-*.zip` covering both hubs, and its docs say the
hubs are "completely identical... They use the same Pybricks firmware." Same GATT,
same stdio tunnel, same adapter. What changes is naming, default port
suggestions, templates and setup copy. The kit differs (51515 ships four medium
motors, no large motor, no force sensor) so the profile defaults should differ.
One caveat for later: if a USB path is ever added, the USB PIDs are *not* the
same (`0x0009` vs `0x0010`) — filter on the Pybricks interface class rather than
hardcoding a PID.

**Phase 2 — stock-firmware EV3 and NXT via direct commands.** This is the
reordering the research argues for, and I agree with it. Two working generations
in days rather than weeks, no firmware flashing, no dependence on a protocol that
moved six weeks ago, and it is the path that survives if Pybricks' EV3 support
churns. LEGO's EV3 Communication Developer Kit is still the reference and the
command set is frozen. Both land at `host` enforcement only, so both are local
supervised driving until Phase 4.

**Phase 3 — Pybricks EV3/NXT over USB.** Pin firmware 4.0.1 and `pybricksdev`
2.3.2, build against the vendor-class path, and treat the 4.1 CDC/COBS switch as
a tracked migration (a small `pyserial` + COBS codec) once the format settles.
The payoff is that a Pybricks brick can run our resident agent, which is what
lifts EV3 and NXT from `host` to `hub+host`.

**Phase 4 — resident agents for EV3/NXT**, unlocking remote operation on those
generations.

**RCX — cut.** The kernel driver is alive, but there is no Python library, and
more fundamentally it does not fit the abstraction: this platform is built on a
host holding a live bidirectional stdio tunnel, and RCX offers program download
plus a few IR opcodes over half-duplex line-of-sight infrared. If the
compatibility line matters for marketing, offer "compile and download with `nqc`"
as an unsupported lab activity, not a platform adapter.

## 7. Structure this implies

Pybricks' USB protocol is a deliberate isomorphism of its BLE GATT profile — same
message set, same characteristics, payload sized off BLE's MTU. So the Pybricks
family is one codec with three transports, and the legacy bricks are a genuinely
different protocol family rather than another transport:

```
PybricksCodec         commands · events · status · stdin/stdout · capabilities
   ├── BleTransport         bleak / Web Bluetooth      → SPIKE, Inventor
   ├── UsbVendorTransport   pyusb / WebUSB             → EV3, NXT, SPIKE @ fw 4.0.x
   └── UsbSerialTransport   pyserial+COBS / Web Serial → EV3, NXT, SPIKE @ fw 4.1.x

LegacyDirectCommand   a different protocol family, not a Pybricks transport
   ├── ev3_dc      → stock EV3   (HID · RFCOMM ch1 · UDP 3015)
   └── nxt-python  → stock NXT   (pyusb · RFCOMM ch1)
```

Both families sit *below* the safety kernel and neither implements a lease.

**Version-gate everything.** Read the capabilities characteristic and the Device
Information software revision at connect; the published BLE profile is at v1.4.0
while firmware `protocol.h` is already at 1.6.0. Note also that stdio moved off
the Nordic UART Service onto the Pybricks command/event characteristic in profile
v1.3.0 — anything still touching NUS for stdio breaks on 4.x. Our implementation
already uses the command/event characteristic, so this is a "do not regress" note.

Two operational notes for the Raspberry Pi target: ship udev rules for both USB
and tty, and expect `cdc_acm` to claim a CDC-firmware brick before our process
does.

