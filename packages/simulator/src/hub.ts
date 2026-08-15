/**
 * A virtual SPIKE hub running the SCS agent.
 *
 * This mirrors the semantics of firmware/pybricks-agent/agent.py, deliberately
 * including the behavior that makes the real thing dangerous: a dropped link
 * does NOT stop a running program, so only the hub's own watchdog brings the
 * motors down. Tests that rely on the simulator are only meaningful because it
 * reproduces that.
 *
 * Everything is deterministic — the caller drives time, and packet loss comes
 * from a seeded generator — so the same script always produces the same run.
 */
import {
  EventCode,
  FrameParser,
  HUB_WATCHDOG_MAX_MS,
  HUB_WATCHDOG_MIN_MS,
  Op,
  decodeDrive,
  decodeSetConfig,
  encodeEvent,
  encodeFrame,
  encodeTelemetry,
  type HubTelemetry,
} from "@spike/protocol";

export const AGENT_VERSION = { major: 0, minor: 1, patch: 0 } as const;
export const AGENT_PROTO = 1;
/** Agent loop period. The real agent paces itself at 50 Hz. */
export const TICK_MS = 20;
/**
 * With no valid traffic at all the agent exits, because a Pybricks hub does not
 * advertise while a program is running — so exiting is what makes the hub
 * discoverable again after a link is truly gone.
 */
export const IDLE_EXIT_MS = 20_000;

/** Roughly a SPIKE medium motor's free speed, in degrees per second. */
const MAX_SPEED_DEG_S = 1000;
/** First-order lag: fraction of the gap to the target closed per second. */
const MOTOR_RESPONSE_PER_SEC = 12;
const FULL_BATTERY_MV = 8200;
const EMPTY_BATTERY_MV = 6000;
const LOW_BATTERY_MV = 6600;

export type HubState =
  | "BOOTING"
  | "READY"
  | "MANUAL_ACTIVE"
  | "STOPPED"
  | "EMERGENCY_STOP"
  | "EXITED";

export interface HubFaults {
  /** Fraction of inbound frames silently dropped, 0..1. */
  inboundDropRate: number;
  /** Fraction of outbound frames silently dropped, 0..1. */
  outboundDropRate: number;
  /** When true the link is severed: nothing gets in or out, but the agent runs on. */
  linkDown: boolean;
}

export interface HubOptions {
  seed?: number;
  batteryMillivolts?: number;
  faults?: Partial<HubFaults>;
  watchdogMs?: number;
}

interface MotorSim {
  angleDeg: number;
  speedDegPerSec: number;
  duty: number;
}

function newMotor(): MotorSim {
  return { angleDeg: 0, speedDegPerSec: 0, duty: 0 };
}

/** Seeded LCG — never Math.random, so a failing test can always be replayed. */
function lcg(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

export class VirtualHub {
  private readonly parser = new FrameParser();
  private readonly rand: () => number;
  private readonly outbox: Uint8Array[] = [];

  private state: HubState = "BOOTING";
  private estopLatched = false;
  private watchdogTripped = false;
  private hostSeen = false;

  private watchdogMs: number;
  private telemDiv = 10;
  private maxDutyPercent = 100;

  private commandedLeft = 0;
  private commandedRight = 0;
  readonly left = newMotor();
  readonly right = newMotor();

  private batteryMv: number;
  private lastValidRxMs = Number.NEGATIVE_INFINITY;
  private lastActivityMs = 0;
  private lastTickMs: number;
  private tickCount = 0;
  private startedMs: number | null = null;

  readonly faults: HubFaults;
  badFrames = 0;

  constructor(nowMs = 0, options: HubOptions = {}) {
    this.rand = lcg(options.seed ?? 1);
    this.batteryMv = options.batteryMillivolts ?? 7800;
    this.watchdogMs = clampWatchdog(options.watchdogMs ?? 250);
    this.faults = {
      inboundDropRate: options.faults?.inboundDropRate ?? 0,
      outboundDropRate: options.faults?.outboundDropRate ?? 0,
      linkDown: options.faults?.linkDown ?? false,
    };
    this.lastTickMs = nowMs;
    this.lastActivityMs = nowMs;
    this.startedMs = nowMs;
  }

  get currentState(): HubState {
    return this.state;
  }

  get running(): boolean {
    return this.state !== "EXITED";
  }

  get emergencyStopped(): boolean {
    return this.estopLatched;
  }

  get watchdogHasTripped(): boolean {
    return this.watchdogTripped;
  }

  setFaults(faults: Partial<HubFaults>): void {
    Object.assign(this.faults, faults);
  }

  /** Deliver bytes from the host. Partial frames are fine; the parser resyncs. */
  receive(bytes: Uint8Array, nowMs: number): void {
    if (!this.running) return;
    if (this.faults.linkDown) return;
    for (const frame of this.parser.feedAll(bytes)) {
      if (this.rand() < this.faults.inboundDropRate) continue;
      this.handle(frame.op, frame.payload, nowMs);
    }
    this.badFrames = this.parser.badFrames;
  }

  /** Collect frames the hub has emitted since the last call. */
  drain(): Uint8Array[] {
    const out = this.outbox.splice(0, this.outbox.length);
    return out.filter(() => !(this.rand() < this.faults.outboundDropRate));
  }

  /** Advance simulated time. Runs as many agent ticks as have elapsed. */
  advance(nowMs: number): void {
    while (this.running && nowMs - this.lastTickMs >= TICK_MS) {
      this.lastTickMs += TICK_MS;
      this.tick(this.lastTickMs);
    }
  }

  private send(frame: Uint8Array): void {
    if (this.faults.linkDown) return;
    this.outbox.push(frame);
  }

  private handle(op: number, payload: Uint8Array, nowMs: number): void {
    this.lastActivityMs = nowMs;
    switch (op) {
      case Op.HELLO: {
        this.hostSeen = true;
        if (this.state === "BOOTING") this.state = "READY";
        this.send(
          encodeFrame(
            Op.HELLO_ACK,
            Uint8Array.of(
              AGENT_PROTO,
              AGENT_VERSION.major,
              AGENT_VERSION.minor,
              AGENT_VERSION.patch,
              0,
            ),
          ),
        );
        return;
      }

      case Op.HEARTBEAT: {
        this.lastValidRxMs = nowMs;
        this.watchdogTripped = false;
        return;
      }

      case Op.DRIVE: {
        const command = decodeDrive(payload);
        if (command === null) return;
        this.lastValidRxMs = nowMs;
        this.watchdogTripped = false;
        this.commandedLeft = command.left;
        this.commandedRight = command.right;
        if (!this.estopLatched) this.state = "MANUAL_ACTIVE";
        return;
      }

      case Op.ESTOP: {
        this.estopLatched = true;
        this.commandedLeft = 0;
        this.commandedRight = 0;
        this.brake();
        this.state = "EMERGENCY_STOP";
        this.send(encodeEvent(EventCode.ESTOP_LATCHED));
        return;
      }

      case Op.CLEAR_ESTOP: {
        // Only honored from a zero command, matching the agent.
        if (!this.estopLatched) return;
        if (this.commandedLeft !== 0 || this.commandedRight !== 0) return;
        this.estopLatched = false;
        this.watchdogTripped = false;
        this.state = "READY";
        this.send(encodeEvent(EventCode.ESTOP_CLEARED));
        return;
      }

      case Op.SET_CONFIG: {
        const config = decodeSetConfig(payload);
        if (config === null) return;
        this.watchdogMs = clampWatchdog(config.watchdogMs);
        this.telemDiv = Math.max(1, config.telemDiv);
        this.maxDutyPercent = Math.max(0, Math.min(100, config.maxDutyPercent));
        return;
      }

      default:
        return;
    }
  }

  private tick(nowMs: number): void {
    this.tickCount += 1;

    // Watchdog: this is the only thing that stops the motors when the link
    // disappears, because the program keeps running regardless.
    if (
      this.lastValidRxMs !== Number.NEGATIVE_INFINITY &&
      nowMs - this.lastValidRxMs > this.watchdogMs &&
      !this.watchdogTripped
    ) {
      this.watchdogTripped = true;
      this.commandedLeft = 0;
      this.commandedRight = 0;
      this.brake();
      if (!this.estopLatched) this.state = "STOPPED";
      this.send(encodeEvent(EventCode.WATCHDOG_TRIP));
    }

    const targetLeft =
      this.estopLatched || this.watchdogTripped
        ? 0
        : (this.commandedLeft * this.maxDutyPercent) / 100;
    const targetRight =
      this.estopLatched || this.watchdogTripped
        ? 0
        : (this.commandedRight * this.maxDutyPercent) / 100;

    this.stepMotor(this.left, targetLeft, TICK_MS);
    this.stepMotor(this.right, targetRight, TICK_MS);
    this.drainBattery(TICK_MS);

    if (this.tickCount % this.telemDiv === 0) {
      this.send(encodeTelemetry(this.telemetry()));
    }

    if (nowMs - this.lastActivityMs > IDLE_EXIT_MS) {
      this.send(encodeEvent(EventCode.AGENT_EXITING));
      this.brake();
      this.state = "EXITED";
    }
  }

  private brake(): void {
    this.left.duty = 0;
    this.right.duty = 0;
    this.left.speedDegPerSec = 0;
    this.right.speedDegPerSec = 0;
  }

  private stepMotor(motor: MotorSim, targetDuty: number, dtMs: number): void {
    const dt = dtMs / 1000;
    motor.duty = targetDuty;
    const targetSpeed = targetDuty * MAX_SPEED_DEG_S;
    const alpha = Math.min(1, MOTOR_RESPONSE_PER_SEC * dt);
    motor.speedDegPerSec += (targetSpeed - motor.speedDegPerSec) * alpha;
    motor.angleDeg += motor.speedDegPerSec * dt;
  }

  private drainBattery(dtMs: number): void {
    const load = (Math.abs(this.left.duty) + Math.abs(this.right.duty)) / 2;
    // Deliberately fast so a test can reach a low-battery state without
    // simulating an hour of driving.
    const drainMvPerSec = 0.5 + load * 6;
    this.batteryMv = Math.max(EMPTY_BATTERY_MV, this.batteryMv - drainMvPerSec * (dtMs / 1000));
  }

  telemetry(): HubTelemetry {
    return {
      estopLatched: this.estopLatched,
      watchdogTripped: this.watchdogTripped,
      hostSeen: this.hostSeen,
      lowBattery: this.batteryMv <= LOW_BATTERY_MV,
      batteryMillivolts: Math.round(this.batteryMv),
      left: {
        angleDeg: Math.round(this.left.angleDeg),
        speedDegPerSec: Math.round(this.left.speedDegPerSec),
      },
      right: {
        angleDeg: Math.round(this.right.angleDeg),
        speedDegPerSec: Math.round(this.right.speedDegPerSec),
      },
    };
  }

  batteryPercent(): number {
    const span = FULL_BATTERY_MV - EMPTY_BATTERY_MV;
    const pct = ((this.batteryMv - EMPTY_BATTERY_MV) / span) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  /** True while either motor is actually turning. */
  get moving(): boolean {
    return Math.abs(this.left.speedDegPerSec) > 1 || Math.abs(this.right.speedDegPerSec) > 1;
  }

  msSinceStart(nowMs: number): number {
    return this.startedMs === null ? 0 : nowMs - this.startedMs;
  }
}

function clampWatchdog(value: number): number {
  return Math.max(HUB_WATCHDOG_MIN_MS, Math.min(HUB_WATCHDOG_MAX_MS, Math.round(value)));
}
