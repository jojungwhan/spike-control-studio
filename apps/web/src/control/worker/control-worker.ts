/// <reference lib="webworker" />
/**
 * The Control Worker: this is the Robot Host.
 *
 * It owns the 20 Hz command scheduler, the safety kernel, and the transport.
 * The UI thread only sends operator intent and renders snapshots — it cannot
 * make a robot move, and it cannot stop one either.
 *
 * `performance.now()` is monotonic, which is exactly what the kernel's
 * freshness rule requires. Never swap it for `Date.now()`.
 */
import {
  EventCode,
  HOST_PROTOCOL_VERSION,
  Op,
  decodeEvent,
  decodeHelloAck,
  decodeTelemetry,
  encodeDrive,
  encodeEstop,
  encodeHello,
  encodeSetConfig,
  type HostCommand,
  type HubTelemetry,
} from "@spike/protocol";
import { SimulatorTransport } from "@spike/device-adapters";
import {
  BUILT_IN_PROFILES,
  DEFAULT_PROFILE_ID,
  createInitialState,
  hubWatchdogMsFor,
  step,
  type KernelAction,
  type KernelState,
} from "@spike/safety-kernel";
import type { FromWorker, Snapshot, ToWorker } from "../protocol.js";

/** 20 Hz. The Pybricks profile uses write-with-response, so this is the honest ceiling. */
const COMMAND_PERIOD_MS = 50;
const SESSION_ID = `session_${Math.floor(Math.random() * 1e9).toString(36)}`;
const SENDER_ID = "local_operator";

const scope = self as unknown as DedicatedWorkerGlobalScope;

function profileById(id: string) {
  return BUILT_IN_PROFILES.find((profile) => profile.id === id) ?? BUILT_IN_PROFILES[1]!;
}

class ControlHost {
  private transport: SimulatorTransport | null = null;
  private kernel: KernelState;
  private profileId = DEFAULT_PROFILE_ID;
  private timer: ReturnType<typeof setInterval> | null = null;

  private leaseId: string | null = null;
  private sequence = 0;
  private input = { left: 0, right: 0 };
  private telemetry: HubTelemetry | null = null;
  private agentVersion: string | null = null;
  private hubState = "disconnected";
  private lastAcceptedMono: number | null = null;

  private counters = { commandsSent: 0, commandsRejected: 0, telemetryFrames: 0, coalesced: 0 };
  private lastRejectReason: string | null = null;
  private lastStopReason: string | null = null;
  private emissionTimes: number[] = [];

  constructor() {
    this.kernel = createInitialState(profileById(this.profileId).config, this.profileId, now());
  }

  handle(message: ToWorker): void {
    switch (message.type) {
      case "connect":
        void this.connect(message.profileId);
        return;
      case "disconnect":
        this.disconnect();
        return;
      case "enableControl":
        this.enableControl();
        return;
      case "disableControl":
        this.disableControl();
        return;
      case "input":
        this.input = { left: message.left, right: message.right };
        return;
      case "emergencyStop":
        this.dispatch({
          version: HOST_PROTOCOL_VERSION,
          type: "emergency_stop",
          sessionId: SESSION_ID,
          sequence: this.nextSequence(),
          sentAt: Date.now(),
          eventId: `estop_${this.sequence}`,
          senderId: SENDER_ID,
          reason: message.reason,
        });
        this.pushEstopToHub();
        return;
      case "emergencyReset":
        this.dispatch({
          version: HOST_PROTOCOL_VERSION,
          type: "emergency_reset",
          sessionId: SESSION_ID,
          sequence: this.nextSequence(),
          sentAt: Date.now(),
          eventId: `reset_${this.sequence}`,
          senderId: SENDER_ID,
        });
        this.input = { left: 0, right: 0 };
        return;
      case "setProfile":
        this.setProfile(message.profileId);
        return;
      case "dropLink":
        this.transport?.dropLink();
        this.applyEvent({ kind: "transport", up: false });
        return;
      case "restoreLink":
        this.transport?.restoreLink();
        this.applyEvent({ kind: "transport", up: true });
        return;
      case "setLatency":
        this.applyEvent({ kind: "latency", roundTripMs: message.roundTripMs });
        return;
    }
  }

  private async connect(profileId: string): Promise<void> {
    this.disconnect();
    this.profileId = profileId;
    const profile = profileById(profileId);
    this.kernel = createInitialState(profile.config, profileId, now());

    const transport = new SimulatorTransport(now(), { watchdogMs: hubWatchdogMsFor(profile.config) });
    this.transport = transport;
    transport.onFrame((frame) => this.onHubFrame(frame.op, frame.payload));
    transport.onStateChange((state) => {
      if (state !== "connected") this.applyEvent({ kind: "transport", up: false });
      this.emit();
    });

    await transport.connect();
    transport.send(encodeHello());
    transport.send(
      encodeSetConfig({
        watchdogMs: hubWatchdogMsFor(profile.config),
        telemDiv: 5,
        maxDutyPercent: 100,
      }),
    );
    this.applyEvent({ kind: "transport", up: true });
    this.hubState = "connected";
    this.startLoop();
    this.emit();
  }

  private disconnect(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    void this.transport?.disconnect();
    this.transport = null;
    this.leaseId = null;
    this.telemetry = null;
    this.agentVersion = null;
    this.hubState = "disconnected";
    this.emissionTimes = [];
    this.emit();
  }

  private enableControl(): void {
    this.leaseId = `lease_${Math.floor(Math.random() * 1e9).toString(36)}`;
    this.input = { left: 0, right: 0 };
    this.dispatch({
      version: HOST_PROTOCOL_VERSION,
      type: "control_grant",
      sessionId: SESSION_ID,
      sequence: this.nextSequence(),
      sentAt: Date.now(),
      leaseId: this.leaseId,
      senderId: SENDER_ID,
    });
  }

  private disableControl(): void {
    if (this.leaseId === null) return;
    this.dispatch({
      version: HOST_PROTOCOL_VERSION,
      type: "control_release",
      sessionId: SESSION_ID,
      sequence: this.nextSequence(),
      sentAt: Date.now(),
      leaseId: this.leaseId,
      senderId: SENDER_ID,
      reason: "operator_disabled",
    });
    this.leaseId = null;
    this.input = { left: 0, right: 0 };
  }

  private setProfile(profileId: string): void {
    const profile = profileById(profileId);
    this.profileId = profileId;
    this.dispatch({
      version: HOST_PROTOCOL_VERSION,
      type: "safety_config",
      sessionId: SESSION_ID,
      sequence: this.nextSequence(),
      sentAt: Date.now(),
      senderId: SENDER_ID,
      profileId,
      config: profile.config,
    });
    // The hub's own watchdog tracks the profile, still hard-capped in firmware.
    this.transport?.send(
      encodeSetConfig({
        watchdogMs: hubWatchdogMsFor(profile.config),
        telemDiv: 5,
        maxDutyPercent: 100,
      }),
    );
  }

  private startLoop(): void {
    this.timer = setInterval(() => this.tick(), COMMAND_PERIOD_MS);
  }

  private tick(): void {
    const nowMs = now();
    const transport = this.transport;
    if (transport === null) return;

    if (this.leaseId !== null && !this.kernel.estopLatched) {
      // A drive command every tick doubles as the heartbeat that keeps the
      // hub watchdog fed.
      this.dispatch(
        {
          version: HOST_PROTOCOL_VERSION,
          type: "drive",
          sessionId: SESSION_ID,
          sequence: this.nextSequence(),
          sentAt: Date.now(),
          leaseId: this.leaseId,
          senderId: SENDER_ID,
          ttlMs: this.kernel.config.commandTimeoutMs,
          mode: "manual",
          left: this.input.left,
          right: this.input.right,
        },
        nowMs,
      );
    } else {
      this.applyEvent({ kind: "tick" }, nowMs);
    }

    // Whatever the kernel approved is what goes on the wire — never raw input.
    transport.send(encodeDrive(this.kernel.applied.left, this.kernel.applied.right));
    this.counters.commandsSent += 1;
    this.emissionTimes.push(nowMs);
    if (this.emissionTimes.length > 40) this.emissionTimes.shift();

    transport.advance(nowMs);
    this.emit();
  }

  private dispatch(command: HostCommand, nowMs = now()): void {
    this.applyEvent({ kind: "command", command }, nowMs);
  }

  private applyEvent(event: Parameters<typeof step>[1], nowMs = now()): void {
    const result = step(this.kernel, event, nowMs);
    this.kernel = result.state;
    this.consume(result.actions, nowMs);
  }

  private consume(actions: readonly KernelAction[], nowMs: number): void {
    for (const action of actions) {
      switch (action.kind) {
        case "reject":
          this.counters.commandsRejected += 1;
          this.lastRejectReason = action.reason;
          break;
        case "stopMotors":
          this.lastStopReason = action.reason;
          break;
        case "applyMotor":
          this.lastAcceptedMono = nowMs;
          break;
        case "latchEstop":
          this.pushEstopToHub();
          break;
        default:
          break;
      }
    }
    if (this.kernel.lastCommandMono !== null) this.lastAcceptedMono = this.kernel.lastCommandMono;
  }

  private pushEstopToHub(): void {
    // The kernel already zeroed the output; this is the hub-level latch, sent on
    // the reliable path so it never waits behind a steering update.
    this.transport?.send(encodeEstop());
  }

  private onHubFrame(op: number, payload: Uint8Array): void {
    if (op === Op.TELEMETRY) {
      const decoded = decodeTelemetry(payload);
      if (decoded !== null) {
        this.telemetry = decoded;
        this.counters.telemetryFrames += 1;
      }
      return;
    }
    if (op === Op.HELLO_ACK) {
      const ack = decodeHelloAck(payload);
      if (ack !== null) {
        this.agentVersion = `${ack.agentVersion.major}.${ack.agentVersion.minor}.${ack.agentVersion.patch}`;
      }
      return;
    }
    if (op === Op.EVENT) {
      const event = decodeEvent(payload);
      if (event === null) return;
      if (event.code === EventCode.WATCHDOG_TRIP) {
        post({ type: "log", level: "warn", message: "Hub watchdog tripped — motors stopped." });
      }
      if (event.code === EventCode.AGENT_EXITING) {
        post({ type: "log", level: "warn", message: "Hub agent exited after a long silence." });
      }
    }
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private commandRateHz(): number {
    if (this.emissionTimes.length < 2) return 0;
    const first = this.emissionTimes[0]!;
    const last = this.emissionTimes[this.emissionTimes.length - 1]!;
    const span = last - first;
    if (span <= 0) return 0;
    return ((this.emissionTimes.length - 1) / span) * 1000;
  }

  private emit(): void {
    const nowMs = now();
    const snapshot: Snapshot = {
      transport: this.transport?.state ?? "disconnected",
      controlEnabled: this.leaseId !== null,
      estopLatched: this.kernel.estopLatched,
      rearmRequired: this.kernel.rearmRequired,
      profileId: this.profileId,
      requested: { ...this.kernel.requested },
      applied: { ...this.kernel.applied },
      commandAgeMs: this.lastAcceptedMono === null ? null : Math.round(nowMs - this.lastAcceptedMono),
      latencyMs: this.kernel.latencyMs,
      latencyStopped: this.kernel.latencyStopped,
      telemetry: this.telemetry,
      batteryPercent: this.transport?.hub.batteryPercent() ?? null,
      hubState: this.transport?.hub.currentState ?? this.hubState,
      agentVersion: this.agentVersion,
      counters: { ...this.counters, coalesced: this.counters.coalesced },
      lastRejectReason: this.lastRejectReason,
      lastStopReason: this.lastStopReason,
      commandRateHz: Math.round(this.commandRateHz() * 10) / 10,
    };
    post({ type: "snapshot", snapshot });
  }
}

function now(): number {
  return performance.now();
}

function post(message: FromWorker): void {
  scope.postMessage(message);
}

const host = new ControlHost();
scope.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  host.handle(event.data);
});
