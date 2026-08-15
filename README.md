# SPIKE Control Studio

A browser-based control platform for LEGO SPIKE Prime hubs running
[Pybricks](https://pybricks.com/) firmware. Drive a robot from a phone, tablet or
laptop, with the safety rules enforced by a kernel that is small enough to prove
things about.

> **Status: MVP 1, in progress.** The protocol, the safety kernel, its Python
> mirror, a virtual hub and the web UI are built and tested. The app currently
> drives a **simulated** hub. Nothing here has yet talked to real hardware — see
> [Status](#status).

## Why a safety kernel

A remote-control app for a physical robot has one interesting problem: deciding
when the robot is allowed to move. Every answer to that question is scattered
across UI code in most such projects — a debounce here, a timeout there — which
makes it impossible to say what the guarantees actually are.

Here it is a single pure reducer, `step(state, event, nowMs)`, with no IO, no
timers and no clock reads. The host injects time from a monotonic source. That
purity buys three things:

- **Property tests.** Nine invariants are checked against generated event
  scripts, with a coverage guard that fails if the generator stops reaching
  motion, emergency stop, lease expiry, transport loss and every reject reason.
  (An earlier uniform-random generator made every safety property pass while
  proving essentially nothing.)
- **Golden vectors.** Recorded event/state traces, replayed as tests.
- **A provably equivalent second implementation.** `apps/bridge` contains a
  Python mirror of the kernel, held equal by replaying the same vectors. If the
  two disagree, the build fails and one of them is wrong.

### What the kernel guarantees

Expert Mode may relax maximum power, ramping and latency response. It can never
switch off manual command expiration, emergency stop, command ownership,
freshness validation, or hardware clamping — `normalizeConfig()` enforces the
bounds structurally, and a knob that could disable one of those is not allowed
to exist in `SafetyConfig` in the first place.

Freshness is judged by the **receiving** host against its own monotonic clock at
receipt time, never against a `sentAt` timestamp from the sender. Otherwise
wall-clock skew between a phone and a Raspberry Pi would decide whether a robot
moves.

There are three separate watchdogs, and they are separate because they fail for
different reasons:

| Watchdog | Lives in | Measures |
|---|---|---|
| Input release | UI | Responsiveness — letting go sends an explicit stop |
| Host lease TTL (150 ms–10 s, default 600 ms) | Kernel | Operator intent freshness |
| Hub watchdog (100–1000 ms, hard-capped) | Hub agent | Link liveness |

The hub watchdog is not redundant with the others. **A BLE disconnect does not
stop a running Pybricks program** ([pybricks/support#212](https://github.com/pybricks/support/issues/212)),
so only the hub's own watchdog stops the motors when the link drops. "Disconnected"
must never be read as "stopped".

## Architecture

Two protocol layers, with the safety kernel as the boundary:

```
operator client  ──host protocol (JSON)──▶  Robot Host  ──SCS binary frames──▶  hub
  joystick, UI                             safety kernel                      Pybricks
                                           runs here                          + its own watchdog
```

The Robot Host is whichever machine is physically near the robot: the browser
itself in direct Web Bluetooth mode, or the Python bridge in bridge/Pi mode.
Only kernel-approved, limited, ramped motor values leave it. The hub never sees
a lease, a session or a sequence number — it sees "drive left/right" and runs
its own watchdog.

```
packages/protocol/        Zod host-protocol schemas + SCS binary codec  [leaf]
packages/safety-kernel/   The pure reducer + built-in profiles + golden vectors
packages/control-engine/  Input mixing, 20 Hz scheduler, profile application
packages/device-adapters/ Transport interface: WebBluetooth | BridgeWs | Simulator
packages/simulator/       Virtual hub for tests and hardware-free development
packages/project-format/  Robot/safety profile documents, migrations, bundles
packages/ui-components/   Joystick, DPad, EStopButton, telemetry tiles
apps/web/                 React 18 + Vite PWA
apps/bridge/              Python (uv, 3.12): FastAPI + bleak. Desktop and Raspberry Pi.
firmware/pybricks-agent/  MicroPython program that runs on the hub
```

## Getting started

Requires Node ≥ 22 (see `.nvmrc`), [pnpm](https://pnpm.io/), and
[uv](https://docs.astral.sh/uv/) for the Python bridge.

```bash
pnpm install
pnpm dev        # web app against the simulated hub — no hardware needed
pnpm verify     # build + typecheck + TypeScript tests + Python conformance suite
```

`pnpm verify` is the one command that matters before committing. If you change
the kernel, regenerate the golden vectors (`pnpm gen:vectors`) **and** re-run the
Python suite (`pnpm test:py`) — a disagreement means the two kernels have
diverged.

Publishing the web app as a static bundle: see [`deploy/README.md`](deploy/README.md).

### A note for Linux users

Chrome's Web Bluetooth on Linux is partially implemented and unsupported; it
needs `chrome://flags/#enable-experimental-web-platform-features` and still
behaves inconsistently. On Linux and on a Raspberry Pi, the Python bridge is the
first-class path, not the browser.

## Status

Built and tested:

- `packages/protocol` — host JSON protocol and the SCS binary hub codec
- `packages/safety-kernel` — the reducer, property invariants, golden vectors
- `apps/bridge/spike_bridge/kernel.py` — the Python mirror, proven equal by replay
- `packages/simulator`, `packages/device-adapters` — virtual hub and transports
- `apps/web` — React/Vite PWA running the kernel in a Web Worker

Not built yet: storage and profile UI, the bridge's FastAPI + bleak layer, the
Pybricks hub agent, and hardware-in-the-loop testing. Remote operation over
WebRTC is explicitly out of scope for MVP 1.

`docs/multi-generation-plan.md` covers the intended path beyond SPIKE Prime,
starting with generalizing the kernel from two motors to a channel map — EV3 has
four motor ports, NXT three, and SPIKE itself six that MVP 1 does not use.

### Before flashing a hub

Check the hub revision first. Pybricks 4.1.0b1 added support for a SPIKE Prime
variant with updated electronics, and the 4.1.0b2 bundle ships two images
(`prime_hub_f4` and `prime_hub_h5`). A recently purchased hub may be the STM32H5
revision, which needs the 4.1 **beta** line rather than 4.0.1.

## Disclaimer

Not affiliated with, endorsed by, or sponsored by the LEGO Group. LEGO® and
SPIKE™ are trademarks of the LEGO Group. Pybricks is an independent project.

This software drives physical hardware. It ships with no warranty of any kind;
you are responsible for operating a robot safely.
