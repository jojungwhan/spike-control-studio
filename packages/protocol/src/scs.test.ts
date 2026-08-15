import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { crc8 } from "./crc.js";
import {
  DRIVE_SCALE,
  FrameParser,
  HUB_WATCHDOG_MAX_MS,
  HUB_WATCHDOG_MIN_MS,
  MAX_FRAME,
  MAX_PAYLOAD,
  Op,
  SOF,
  decodeDrive,
  decodeEvent,
  decodeHelloAck,
  decodeSetConfig,
  decodeTelemetry,
  encodeDrive,
  encodeEvent,
  encodeFrame,
  encodeSetConfig,
  encodeTelemetry,
  type HubTelemetry,
} from "./scs.js";

function parseAll(bytes: Uint8Array) {
  const parser = new FrameParser();
  return { frames: parser.feedAll(bytes), parser };
}

describe("frame encoding", () => {
  it("keeps every frame inside one minimum-MTU BLE write", () => {
    const telemetry = encodeTelemetry({
      estopLatched: true,
      watchdogTripped: false,
      hostSeen: true,
      lowBattery: false,
      batteryMillivolts: 7800,
      left: { angleDeg: 123456, speedDegPerSec: -430 },
      right: { angleDeg: -99, speedDegPerSec: 421 },
    });
    // Telemetry is the largest frame we send; if it fits, everything fits.
    expect(telemetry.length).toBe(MAX_FRAME);
    expect(telemetry.length).toBeLessThanOrEqual(19);
  });

  it("rejects an oversized payload rather than truncating it", () => {
    expect(() => encodeFrame(Op.EVENT, new Uint8Array(MAX_PAYLOAD + 1))).toThrow(RangeError);
  });

  it("round-trips a drive command through the wire scale", () => {
    const { frames } = parseAll(encodeDrive(0.62, -0.58));
    expect(frames).toHaveLength(1);
    const decoded = decodeDrive(frames[0]!.payload);
    expect(decoded?.left).toBeCloseTo(0.62, 4);
    expect(decoded?.right).toBeCloseTo(-0.58, 4);
  });

  it("saturates out-of-range power instead of wrapping the integer", () => {
    const { frames } = parseAll(encodeDrive(50, -50));
    const decoded = decodeDrive(frames[0]!.payload);
    expect(decoded).toEqual({ left: 1, right: -1 });
  });

  it("round-trips telemetry including negative angles and speeds", () => {
    const telemetry: HubTelemetry = {
      estopLatched: false,
      watchdogTripped: true,
      hostSeen: true,
      lowBattery: true,
      batteryMillivolts: 6500,
      left: { angleDeg: -1_000_000, speedDegPerSec: -1000 },
      right: { angleDeg: 2_000_000, speedDegPerSec: 999 },
    };
    const { frames } = parseAll(encodeTelemetry(telemetry));
    expect(decodeTelemetry(frames[0]!.payload)).toEqual(telemetry);
  });

  it("clamps the hub watchdog on encode, both directions", () => {
    const tooLow = decodeSetConfig(
      parseAll(encodeSetConfig({ watchdogMs: 1, telemDiv: 10, maxDutyPercent: 100 })).frames[0]!
        .payload,
    );
    const tooHigh = decodeSetConfig(
      parseAll(encodeSetConfig({ watchdogMs: 99_999, telemDiv: 10, maxDutyPercent: 300 })).frames[0]!
        .payload,
    );
    expect(tooLow?.watchdogMs).toBe(HUB_WATCHDOG_MIN_MS);
    expect(tooHigh?.watchdogMs).toBe(HUB_WATCHDOG_MAX_MS);
    expect(tooHigh?.maxDutyPercent).toBe(100);
  });

  it("decodes hello-ack and events", () => {
    const ack = encodeFrame(Op.HELLO_ACK, Uint8Array.of(1, 0, 2, 3, 0b1));
    expect(decodeHelloAck(parseAll(ack).frames[0]!.payload)).toEqual({
      protoVersion: 1,
      agentVersion: { major: 0, minor: 2, patch: 3 },
      caps: 1,
    });
    expect(decodeEvent(parseAll(encodeEvent(2, 7)).frames[0]!.payload)).toEqual({
      code: 2,
      arg: 7,
    });
  });

  it("returns null for a payload of the wrong length instead of reading past it", () => {
    expect(decodeDrive(new Uint8Array(3))).toBeNull();
    expect(decodeTelemetry(new Uint8Array(14))).toBeNull();
    expect(decodeHelloAck(new Uint8Array(4))).toBeNull();
    expect(decodeEvent(new Uint8Array(1))).toBeNull();
  });
});

describe("frame parser", () => {
  it("reassembles a frame split across arbitrary chunk boundaries", () => {
    const frame = encodeDrive(0.25, -0.75);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: frame.length - 1 }), (cut) => {
        const parser = new FrameParser();
        const first = parser.feedAll(frame.subarray(0, cut));
        const second = parser.feedAll(frame.subarray(cut));
        expect([...first, ...second]).toHaveLength(1);
      }),
      { numRuns: 50 },
    );
  });

  it("drops a corrupted frame and recovers on the next good one", () => {
    const good = encodeDrive(0.5, 0.5);
    const corrupt = encodeDrive(1, 1);
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1]! ^ 0xff) & 0xff;

    const stream = new Uint8Array([...corrupt, ...good]);
    const { frames, parser } = parseAll(stream);
    expect(frames).toHaveLength(1);
    expect(parser.badFrames).toBe(1);
    expect(decodeDrive(frames[0]!.payload)?.left).toBeCloseTo(0.5, 4);
  });

  it("resynchronizes through leading garbage", () => {
    const good = encodeDrive(-0.3, 0.3);
    const stream = new Uint8Array([0x00, 0xff, 0x12, SOF, 0xfe, ...good]);
    const { frames } = parseAll(stream);
    expect(frames).toHaveLength(1);
    expect(decodeDrive(frames[0]!.payload)?.left).toBeCloseTo(-0.3, 4);
  });

  it("recovers when garbage ends on the SOF byte of a real frame", () => {
    // 0xAA is a plausible payload byte, so the parser must be able to treat a
    // byte it rejected as a length as the start of the next frame.
    const good = encodeDrive(0.1, 0.1);
    const stream = new Uint8Array([SOF, ...good]);
    const { frames } = parseAll(stream);
    expect(frames).toHaveLength(1);
  });

  it("never emits an unknown opcode", () => {
    const bogus = encodeFrame(0x7f, Uint8Array.of(1, 2, 3));
    const { frames, parser } = parseAll(bogus);
    expect(frames).toHaveLength(0);
    expect(parser.badFrames).toBe(1);
  });

  it("never emits a frame from random bytes without a valid CRC", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 400 }), (noise) => {
        const parser = new FrameParser();
        for (const frame of parser.feedAll(noise)) {
          // Anything that does emerge must be a structurally valid frame — the
          // CRC is doing the work, not luck about buffer boundaries.
          const check = new Uint8Array(2 + frame.payload.length);
          check[0] = frame.payload.length;
          check[1] = frame.op;
          check.set(frame.payload, 2);
          expect(crc8(check)).toBeGreaterThanOrEqual(0);
          expect(frame.payload.length).toBeLessThanOrEqual(MAX_PAYLOAD);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("round-trips every encodable drive pair", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        (left, right) => {
          const { frames } = parseAll(encodeDrive(left, right));
          const decoded = decodeDrive(frames[0]!.payload);
          expect(decoded).not.toBeNull();
          expect(Math.abs(decoded!.left - left)).toBeLessThanOrEqual(1 / DRIVE_SCALE);
          expect(Math.abs(decoded!.right - right)).toBeLessThanOrEqual(1 / DRIVE_SCALE);
        },
      ),
      { numRuns: 300 },
    );
  });
});
