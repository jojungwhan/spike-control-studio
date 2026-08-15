/**
 * SCS — the SPIKE Control Studio hub wire protocol.
 *
 * Frames travel through the Pybricks stdio tunnel: host->hub as
 * `0x06 (WRITE_STDIN) + frame`, hub->host as `0x01 (WRITE_STDOUT) + frame`.
 * The tunnel byte is added/stripped by the transport, not here.
 *
 * Layout, little-endian throughout:
 *
 *   [SOF=0xAA][LEN u8][OP u8][PAYLOAD (LEN bytes)][CRC8]
 *
 * CRC covers LEN, OP and PAYLOAD. A 15-byte payload gives a 19-byte frame,
 * which fits one BLE write at the ATT-minimum MTU (stdin payload per write is
 * max_char_size - 1, and max_char_size is at least 20).
 */
import { crc8 } from "./crc.js";

export const SOF = 0xaa;
/** Largest payload that keeps a frame inside one minimum-MTU BLE write. */
export const MAX_PAYLOAD = 15;
export const MAX_FRAME = MAX_PAYLOAD + 4;
/** Bumped only on a breaking change to the frame layout or opcode meanings. */
export const SCS_PROTO_VERSION = 1;

/** Normalized motor power (-1.0 .. 1.0) is sent as i16 in units of 1/10000. */
export const DRIVE_SCALE = 10_000;

export const Op = {
  HELLO: 0x01,
  HEARTBEAT: 0x02,
  DRIVE: 0x03,
  ESTOP: 0x04,
  CLEAR_ESTOP: 0x05,
  SET_CONFIG: 0x06,
  HELLO_ACK: 0x81,
  TELEMETRY: 0x82,
  EVENT: 0x83,
} as const;

export type OpCode = (typeof Op)[keyof typeof Op];

const KNOWN_OPS = new Set<number>(Object.values(Op));

/** Hub-side event codes carried by {@link Op.EVENT}. */
export const EventCode = {
  ESTOP_LATCHED: 1,
  WATCHDOG_TRIP: 2,
  BAD_FRAME: 3,
  ESTOP_CLEARED: 4,
  AGENT_EXITING: 5,
} as const;

export type EventCodeValue = (typeof EventCode)[keyof typeof EventCode];

/** Bit positions in the TELEMETRY `state` byte. */
export const StateBit = {
  ESTOP_LATCHED: 1 << 0,
  WATCHDOG_TRIPPED: 1 << 1,
  HOST_SEEN: 1 << 2,
  LOW_BATTERY: 1 << 3,
} as const;

/** Hub watchdog bounds. The upper bound is a hard cap: an Expert profile may
 *  stretch the *host* lease to 10 s, but the hub still stops within a second of
 *  link silence. See docs/architecture.md, "three watchdogs". */
export const HUB_WATCHDOG_MIN_MS = 100;
export const HUB_WATCHDOG_MAX_MS = 1000;

export interface ScsFrame {
  op: number;
  payload: Uint8Array;
}

export function encodeFrame(op: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > MAX_PAYLOAD) {
    throw new RangeError(`SCS payload ${payload.length} exceeds MAX_PAYLOAD ${MAX_PAYLOAD}`);
  }
  const frame = new Uint8Array(payload.length + 4);
  frame[0] = SOF;
  frame[1] = payload.length;
  frame[2] = op & 0xff;
  frame.set(payload, 3);
  frame[frame.length - 1] = crc8(frame.subarray(1, frame.length - 1));
  return frame;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

/** Normalized power to the i16 wire value, saturating at the scale bounds. */
export function toWirePower(value: number): number {
  return Math.max(-DRIVE_SCALE, Math.min(DRIVE_SCALE, Math.round(clampUnit(value) * DRIVE_SCALE)));
}

export function fromWirePower(raw: number): number {
  return Math.max(-1, Math.min(1, raw / DRIVE_SCALE));
}

export function encodeHello(protoVersion: number = SCS_PROTO_VERSION): Uint8Array {
  return encodeFrame(Op.HELLO, Uint8Array.of(protoVersion & 0xff));
}

export function encodeHeartbeat(): Uint8Array {
  return encodeFrame(Op.HEARTBEAT);
}

export function encodeDrive(left: number, right: number): Uint8Array {
  const payload = new Uint8Array(4);
  const view = new DataView(payload.buffer);
  view.setInt16(0, toWirePower(left), true);
  view.setInt16(2, toWirePower(right), true);
  return encodeFrame(Op.DRIVE, payload);
}

export function encodeEstop(): Uint8Array {
  return encodeFrame(Op.ESTOP);
}

export function encodeClearEstop(): Uint8Array {
  return encodeFrame(Op.CLEAR_ESTOP);
}

export interface HubConfig {
  /** Link-liveness watchdog, clamped to [100, 1000] ms by both sides. */
  watchdogMs: number;
  /** Telemetry is emitted every `telemDiv` ticks of the agent's 50 Hz loop. */
  telemDiv: number;
  /** Hard duty ceiling applied on the hub, 0-100 %. */
  maxDutyPercent: number;
}

export function encodeSetConfig(config: HubConfig): Uint8Array {
  const payload = new Uint8Array(4);
  const view = new DataView(payload.buffer);
  const watchdog = Math.round(
    Math.max(HUB_WATCHDOG_MIN_MS, Math.min(HUB_WATCHDOG_MAX_MS, config.watchdogMs)),
  );
  view.setUint16(0, watchdog, true);
  payload[2] = Math.max(1, Math.min(255, Math.round(config.telemDiv)));
  payload[3] = Math.max(0, Math.min(100, Math.round(config.maxDutyPercent)));
  return encodeFrame(Op.SET_CONFIG, payload);
}

export interface HelloAck {
  protoVersion: number;
  agentVersion: { major: number; minor: number; patch: number };
  caps: number;
}

export function decodeHelloAck(payload: Uint8Array): HelloAck | null {
  if (payload.length !== 5) return null;
  return {
    protoVersion: payload[0] as number,
    agentVersion: {
      major: payload[1] as number,
      minor: payload[2] as number,
      patch: payload[3] as number,
    },
    caps: payload[4] as number,
  };
}

export interface HubTelemetry {
  estopLatched: boolean;
  watchdogTripped: boolean;
  hostSeen: boolean;
  lowBattery: boolean;
  batteryMillivolts: number;
  left: { angleDeg: number; speedDegPerSec: number };
  right: { angleDeg: number; speedDegPerSec: number };
}

export function decodeTelemetry(payload: Uint8Array): HubTelemetry | null {
  if (payload.length !== 15) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const state = payload[0] as number;
  return {
    estopLatched: (state & StateBit.ESTOP_LATCHED) !== 0,
    watchdogTripped: (state & StateBit.WATCHDOG_TRIPPED) !== 0,
    hostSeen: (state & StateBit.HOST_SEEN) !== 0,
    lowBattery: (state & StateBit.LOW_BATTERY) !== 0,
    batteryMillivolts: view.getUint16(1, true),
    left: { angleDeg: view.getInt32(3, true), speedDegPerSec: view.getInt16(7, true) },
    right: { angleDeg: view.getInt32(9, true), speedDegPerSec: view.getInt16(13, true) },
  };
}

export function encodeTelemetry(telemetry: HubTelemetry): Uint8Array {
  const payload = new Uint8Array(15);
  const view = new DataView(payload.buffer);
  let state = 0;
  if (telemetry.estopLatched) state |= StateBit.ESTOP_LATCHED;
  if (telemetry.watchdogTripped) state |= StateBit.WATCHDOG_TRIPPED;
  if (telemetry.hostSeen) state |= StateBit.HOST_SEEN;
  if (telemetry.lowBattery) state |= StateBit.LOW_BATTERY;
  payload[0] = state;
  view.setUint16(1, Math.max(0, Math.min(0xffff, Math.round(telemetry.batteryMillivolts))), true);
  view.setInt32(3, Math.round(telemetry.left.angleDeg), true);
  view.setInt16(7, clampI16(telemetry.left.speedDegPerSec), true);
  view.setInt32(9, Math.round(telemetry.right.angleDeg), true);
  view.setInt16(13, clampI16(telemetry.right.speedDegPerSec), true);
  return encodeFrame(Op.TELEMETRY, payload);
}

function clampI16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

export interface HubEvent {
  code: number;
  arg: number;
}

export function decodeEvent(payload: Uint8Array): HubEvent | null {
  if (payload.length !== 2) return null;
  return { code: payload[0] as number, arg: payload[1] as number };
}

export function encodeEvent(code: number, arg = 0): Uint8Array {
  return encodeFrame(Op.EVENT, Uint8Array.of(code & 0xff, arg & 0xff));
}

/** Hub-level motor intent. The host-level {@link import("./host.js").DriveCommand}
 *  carries the lease; by the time a value reaches this shape the kernel has
 *  already approved, limited and ramped it. */
export interface ScsDriveCommand {
  left: number;
  right: number;
}

export function decodeDrive(payload: Uint8Array): ScsDriveCommand | null {
  if (payload.length !== 4) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    left: fromWirePower(view.getInt16(0, true)),
    right: fromWirePower(view.getInt16(2, true)),
  };
}

export function decodeSetConfig(payload: Uint8Array): HubConfig | null {
  if (payload.length !== 4) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    watchdogMs: view.getUint16(0, true),
    telemDiv: payload[2] as number,
    maxDutyPercent: payload[3] as number,
  };
}

type ParserState = "sof" | "len" | "op" | "payload" | "crc";

/**
 * Byte-at-a-time framer, mirroring what the hub agent runs against
 * `read_input_byte()`. BLE writes split and merge relative to reads, so the
 * parser resynchronizes by scanning for SOF and validating CRC rather than
 * trusting message boundaries.
 *
 * A rejected frame increments {@link FrameParser.badFrames} and is dropped. It
 * never reaches the caller, which is what keeps malformed traffic from
 * refreshing any watchdog.
 */
export class FrameParser {
  private state: ParserState = "sof";
  private len = 0;
  private op = 0;
  private payload = new Uint8Array(MAX_PAYLOAD);
  private filled = 0;
  badFrames = 0;

  reset(): void {
    this.state = "sof";
    this.filled = 0;
  }

  feed(byte: number): ScsFrame[] {
    const out: ScsFrame[] = [];
    this.step(byte & 0xff, out);
    return out;
  }

  feedAll(bytes: Uint8Array): ScsFrame[] {
    const out: ScsFrame[] = [];
    for (const byte of bytes) this.step(byte, out);
    return out;
  }

  private step(byte: number, out: ScsFrame[]): void {
    switch (this.state) {
      case "sof":
        if (byte === SOF) this.state = "len";
        return;

      case "len":
        if (byte > MAX_PAYLOAD) {
          // Not a length we can honor. The byte may itself be the real SOF of a
          // frame that began mid-garbage, so re-examine it from scratch.
          this.badFrames += 1;
          this.state = "sof";
          this.step(byte, out);
          return;
        }
        this.len = byte;
        this.state = "op";
        return;

      case "op":
        this.op = byte;
        this.filled = 0;
        this.state = this.len === 0 ? "crc" : "payload";
        return;

      case "payload":
        this.payload[this.filled] = byte;
        this.filled += 1;
        if (this.filled === this.len) this.state = "crc";
        return;

      case "crc": {
        const header = Uint8Array.of(this.len, this.op);
        const check = new Uint8Array(2 + this.len);
        check.set(header, 0);
        check.set(this.payload.subarray(0, this.len), 2);
        this.state = "sof";
        if (crc8(check) !== byte || !KNOWN_OPS.has(this.op)) {
          this.badFrames += 1;
          return;
        }
        out.push({ op: this.op, payload: this.payload.slice(0, this.len) });
        return;
      }
    }
  }
}
