# SPIKE Control Studio — Claude Code Instructions

Browser-based control platform for LEGO SPIKE Prime hubs running Pybricks firmware.
Full plan: `<home>/.claude/plans/misty-bubbling-snail.md`.

## The architecture in one paragraph

There are **two protocol layers** with the safety kernel as the boundary. Operator clients talk the
**host protocol** (JSON, `packages/protocol/src/host.ts`) to the **Robot Host** — whichever machine
is physically near the robot: the browser itself in direct Web Bluetooth mode, the Python bridge in
bridge/Pi mode. The Robot Host runs the **safety kernel**, and only kernel-approved, limited, ramped
motor values leave it, encoded as compact **SCS binary frames** (`packages/protocol/src/scs.ts`) sent
through the Pybricks stdio tunnel to the hub. The hub never sees a lease, a session, or a sequence
number — it sees "drive left/right" plus its own independent watchdog.

## Critical rules

### The kernel is pure

`packages/safety-kernel/src/kernel.ts` is a deterministic reducer: `step(state, event, nowMs)`. No IO,
no timers, no clock reads inside — the host injects `nowMs` from a **monotonic** source. Keep it that
way. Purity is what makes the Python mirror provably equivalent by golden-vector replay.

### Freshness is receiver-monotonic, never `sentAt`

A command's validity is judged by the *receiving* host against its own monotonic clock at receipt
time. `sentAt` is diagnostics only (it feeds the "command age" readout). Never "optimize" a freshness
check into a `sentAt` comparison — wall-clock skew between a phone and a Pi would then decide whether
a robot moves.

### Three watchdogs, three different jobs

1. **Input release** (UI) — letting go sends an explicit stop. Responsiveness, not safety.
2. **Host lease TTL** (kernel, 150 ms–10 s, default 600 ms) — measures *operator intent freshness*.
3. **Hub watchdog** (agent, 100–1000 ms) — measures *link liveness*. Hard-capped at 1000 ms no matter
   what the profile says. Heartbeat frames keep it alive between drive commands.

Do not collapse these into one. They fail for different reasons.

### Never-disableable protections

Expert Mode may relax max power, ramping, and latency response. It can **never** switch off: manual
command expiration, emergency stop, command ownership, freshness validation, or hardware clamping.
`normalizeConfig()` enforces the bounds structurally — a knob that could disable one of these must not
exist in `SafetyConfig` in the first place.

### A BLE disconnect does not stop a running Pybricks program

This is the single most important hardware fact (pybricks/support#212). Only the hub's own watchdog
stops motors when the link drops. Never treat "disconnected" as "stopped".

### Only real knobs

`SafetyConfig` contains only settings the kernel actually enforces with data MVP 1 has. Do not add a
control that does nothing pending a later milestone.

## Layout

```
packages/protocol/       Zod host-protocol schemas + SCS binary codec  [leaf, no internal deps]
packages/safety-kernel/  The pure reducer + built-in profiles + golden vectors
packages/control-engine/ Input mixing, 20 Hz scheduler, profile application
packages/device-adapters/Transport interface: WebBluetooth | BridgeWs | Simulator
packages/simulator/      Virtual hub for tests and hardware-free development
packages/project-format/ Robot/safety profile documents, migrations, .spikestudio bundle
packages/ui-components/  Joystick, DPad, EStopButton, telemetry tiles
apps/web/                React 18 + Vite PWA
apps/bridge/             Python (uv, 3.12): FastAPI + bleak. Desktop AND Raspberry Pi.
firmware/pybricks-agent/ MicroPython program that runs on the hub
```

## Build and test

- `pnpm build` / `pnpm typecheck` / `pnpm test` (Turborepo)
- `pnpm verify` — everything including the Python suite
- `pnpm test:py` — bridge tests via `uv run pytest`
- Package manager is **pnpm**; never npm or yarn. Node pinned in `.nvmrc`.
- `typecheck` uses `tsconfig.typecheck.json` (includes test files); `build` uses `tsconfig.json`
  (excludes them).

### Property tests must not go vacuous

`packages/safety-kernel/src/kernel.test.ts` has a coverage guard ("invariant 0") that asserts the
generator actually reaches motion, emergency stop, lease expiry, transport loss, and every reject and
stop reason. It exists because an earlier uniform-random generator produced scripts that were
emergency-stopped or lease-less almost always, so every safety property passed while proving nothing.
If you change the generator and that guard fails, the generator is wrong, not the guard.

## Ports

See `docs/PORTS.md`. This machine also runs the CIT stack — check
`<workspace>/PORTS.md` before claiming a new port.

## Scratch

`<home>/scratch/spike-control-studio/`. Never `/tmp` — it is tmpfs (RAM) on this box.
