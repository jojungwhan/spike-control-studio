import { describe, expect, it } from "vitest";
import {
  EventCode,
  FrameParser,
  Op,
  decodeEvent,
  decodeHelloAck,
  decodeTelemetry,
  encodeClearEstop,
  encodeDrive,
  encodeEstop,
  encodeHeartbeat,
  encodeHello,
  encodeSetConfig,
} from "@spike/protocol";
import { AGENT_VERSION, IDLE_EXIT_MS, VirtualHub } from "./hub.js";

/** Collect everything the hub has emitted, decoded into (op, payload) pairs. */
function collect(hub: VirtualHub) {
  const parser = new FrameParser();
  const frames = [];
  for (const bytes of hub.drain()) frames.push(...parser.feedAll(bytes));
  return frames;
}

function opsOf(hub: VirtualHub): number[] {
  return collect(hub).map((frame) => frame.op);
}

/** Drive the hub forward in small steps, as a real host would. */
function runFor(hub: VirtualHub, fromMs: number, durationMs: number, stepMs = 20): number {
  let now = fromMs;
  const end = fromMs + durationMs;
  while (now < end) {
    now = Math.min(end, now + stepMs);
    hub.advance(now);
  }
  return now;
}

/** Stream drive commands the way a real host does, at 20 Hz. */
function streamDrive(
  hub: VirtualHub,
  fromMs: number,
  durationMs: number,
  left: number,
  right: number,
): number {
  let now = fromMs;
  const end = fromMs + durationMs;
  while (now < end) {
    now = Math.min(end, now + 50);
    hub.receive(encodeDrive(left, right), now);
    hub.advance(now);
  }
  return now;
}

describe("virtual hub", () => {
  it("answers HELLO with its agent version", () => {
    const hub = new VirtualHub(0);
    hub.receive(encodeHello(), 0);
    const frames = collect(hub);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.op).toBe(Op.HELLO_ACK);
    expect(decodeHelloAck(frames[0]!.payload)?.agentVersion).toEqual(AGENT_VERSION);
  });

  it("spins the motors up on a drive command", () => {
    const hub = new VirtualHub(0);
    hub.receive(encodeHello(), 0);
    hub.receive(encodeDrive(1, 1), 0);
    runFor(hub, 0, 200);
    expect(hub.left.speedDegPerSec).toBeGreaterThan(100);
    expect(hub.right.speedDegPerSec).toBeGreaterThan(100);
    expect(hub.left.angleDeg).toBeGreaterThan(0);
    expect(hub.currentState).toBe("MANUAL_ACTIVE");
  });

  it("stops on watchdog timeout when commands stop arriving", () => {
    const hub = new VirtualHub(0, { watchdogMs: 250 });
    hub.receive(encodeHello(), 0);
    hub.receive(encodeDrive(1, 1), 0);
    runFor(hub, 0, 100);
    expect(hub.moving).toBe(true);

    collect(hub);
    runFor(hub, 100, 500);
    expect(hub.watchdogHasTripped).toBe(true);
    expect(hub.moving).toBe(false);
    expect(hub.currentState).toBe("STOPPED");

    const events = collect(hub)
      .filter((frame) => frame.op === Op.EVENT)
      .map((frame) => decodeEvent(frame.payload)?.code);
    expect(events).toContain(EventCode.WATCHDOG_TRIP);
  });

  it("keeps running when the link drops, and the watchdog is what stops it", () => {
    // This is the behavior that makes the real hardware dangerous: a BLE
    // disconnect does not stop a running Pybricks program. If the simulator
    // did not reproduce it, every test built on the simulator would be
    // reassuring and wrong.
    const hub = new VirtualHub(0, { watchdogMs: 250 });
    hub.receive(encodeHello(), 0);
    hub.receive(encodeDrive(1, 1), 0);
    runFor(hub, 0, 100);
    expect(hub.moving).toBe(true);

    hub.setFaults({ linkDown: true });
    hub.advance(140);
    // Immediately after the drop the program is still running at speed.
    expect(hub.running).toBe(true);
    expect(hub.moving).toBe(true);

    runFor(hub, 140, 400);
    expect(hub.running).toBe(true);
    expect(hub.watchdogHasTripped).toBe(true);
    expect(hub.moving).toBe(false);
  });

  it("refuses to let malformed traffic hold the watchdog open", () => {
    const hub = new VirtualHub(0, { watchdogMs: 250 });
    hub.receive(encodeHello(), 0);
    hub.receive(encodeDrive(1, 1), 0);
    runFor(hub, 0, 100);

    // A flood of garbage that happens to contain the start-of-frame byte.
    let now = 100;
    for (let i = 0; i < 40; i += 1) {
      now += 20;
      hub.receive(new Uint8Array([0xaa, 0x04, 0x03, 0x10, 0x27, 0x10, 0x27, 0x00]), now);
      hub.advance(now);
    }
    expect(hub.watchdogHasTripped).toBe(true);
    expect(hub.moving).toBe(false);
  });

  it("stays alive while heartbeats keep arriving", () => {
    const hub = new VirtualHub(0, { watchdogMs: 250 });
    hub.receive(encodeHello(), 0);
    hub.receive(encodeDrive(0.5, 0.5), 0);
    let now = 0;
    for (let i = 0; i < 30; i += 1) {
      now += 100;
      hub.receive(encodeHeartbeat(), now);
      hub.advance(now);
    }
    expect(hub.watchdogHasTripped).toBe(false);
    expect(hub.moving).toBe(true);
  });

  it("latches emergency stop and only clears it from a zero command", () => {
    const hub = new VirtualHub(0);
    hub.receive(encodeHello(), 0);
    hub.receive(encodeDrive(1, 1), 0);
    runFor(hub, 0, 100);

    hub.receive(encodeEstop(), 100);
    hub.advance(120);
    expect(hub.emergencyStopped).toBe(true);
    expect(hub.moving).toBe(false);
    expect(hub.currentState).toBe("EMERGENCY_STOP");

    // A non-zero command must not unlatch it.
    hub.receive(encodeDrive(1, 1), 140);
    hub.receive(encodeClearEstop(), 160);
    hub.advance(180);
    expect(hub.emergencyStopped).toBe(true);
    expect(hub.moving).toBe(false);

    hub.receive(encodeDrive(0, 0), 200);
    hub.receive(encodeClearEstop(), 220);
    hub.advance(240);
    expect(hub.emergencyStopped).toBe(false);
    expect(hub.currentState).toBe("READY");
  });

  it("does not move while an emergency stop is latched, whatever arrives", () => {
    const hub = new VirtualHub(0);
    hub.receive(encodeHello(), 0);
    hub.receive(encodeEstop(), 0);
    let now = 0;
    for (let i = 0; i < 20; i += 1) {
      now += 20;
      hub.receive(encodeDrive(1, 1), now);
      hub.advance(now);
      expect(hub.moving).toBe(false);
    }
  });

  it("applies the configured duty ceiling", () => {
    const full = new VirtualHub(0);
    full.receive(encodeHello(), 0);
    streamDrive(full, 0, 400, 1, 1);

    const limited = new VirtualHub(0);
    limited.receive(encodeHello(), 0);
    limited.receive(encodeSetConfig({ watchdogMs: 250, telemDiv: 10, maxDutyPercent: 30 }), 0);
    streamDrive(limited, 0, 400, 1, 1);

    expect(limited.left.speedDegPerSec).toBeLessThan(full.left.speedDegPerSec * 0.5);
  });

  it("clamps a watchdog request to the firmware bounds", () => {
    // An Expert profile may ask for a 10 s lease, but the hub caps its own
    // watchdog at 1 s regardless.
    const hub = new VirtualHub(0);
    hub.receive(encodeHello(), 0);
    hub.receive(encodeSetConfig({ watchdogMs: 60_000, telemDiv: 10, maxDutyPercent: 100 }), 0);
    hub.receive(encodeDrive(1, 1), 0);
    runFor(hub, 0, 900);
    expect(hub.watchdogHasTripped).toBe(false);
    runFor(hub, 900, 400);
    expect(hub.watchdogHasTripped).toBe(true);
  });

  it("emits telemetry that decodes and tracks the motors", () => {
    const hub = new VirtualHub(0);
    hub.receive(encodeHello(), 0);
    collect(hub);
    streamDrive(hub, 0, 400, 1, -1);

    const telemetry = collect(hub)
      .filter((frame) => frame.op === Op.TELEMETRY)
      .map((frame) => decodeTelemetry(frame.payload));
    expect(telemetry.length).toBeGreaterThan(0);
    const last = telemetry[telemetry.length - 1]!;
    expect(last.left.speedDegPerSec).toBeGreaterThan(0);
    expect(last.right.speedDegPerSec).toBeLessThan(0);
    expect(last.batteryMillivolts).toBeGreaterThan(6000);
  });

  it("exits after a long silence so the hub can advertise again", () => {
    const hub = new VirtualHub(0);
    hub.receive(encodeHello(), 0);
    hub.receive(encodeDrive(0.5, 0.5), 0);
    runFor(hub, 0, IDLE_EXIT_MS + 1000, 100);
    expect(hub.running).toBe(false);
    expect(hub.currentState).toBe("EXITED");
    expect(hub.moving).toBe(false);
  });

  it("ignores everything once it has exited", () => {
    const hub = new VirtualHub(0);
    hub.receive(encodeHello(), 0);
    runFor(hub, 0, IDLE_EXIT_MS + 1000, 100);
    expect(hub.running).toBe(false);
    hub.receive(encodeDrive(1, 1), IDLE_EXIT_MS + 2000);
    hub.advance(IDLE_EXIT_MS + 3000);
    expect(hub.moving).toBe(false);
  });

  it("reassembles commands split across writes", () => {
    const hub = new VirtualHub(0);
    const frame = encodeDrive(0.8, 0.8);
    hub.receive(encodeHello(), 0);
    hub.receive(frame.subarray(0, 3), 0);
    hub.receive(frame.subarray(3), 5);
    runFor(hub, 5, 200);
    expect(hub.moving).toBe(true);
  });

  it("is deterministic under packet loss for a given seed", () => {
    const script = (hub: VirtualHub) => {
      let now = 0;
      for (let i = 0; i < 50; i += 1) {
        now += 20;
        hub.receive(encodeDrive(0.9, 0.9), now);
        hub.advance(now);
      }
      return hub.left.angleDeg;
    };
    const a = script(new VirtualHub(0, { seed: 7, faults: { inboundDropRate: 0.5 } }));
    const b = script(new VirtualHub(0, { seed: 7, faults: { inboundDropRate: 0.5 } }));
    expect(a).toBe(b);
  });

  it("drains the battery faster under load", () => {
    const idle = new VirtualHub(0);
    idle.receive(encodeHello(), 0);
    runFor(idle, 0, 5000, 100);

    const loaded = new VirtualHub(0);
    loaded.receive(encodeHello(), 0);
    let now = 0;
    for (let i = 0; i < 50; i += 1) {
      now += 100;
      loaded.receive(encodeDrive(1, 1), now);
      loaded.advance(now);
    }
    expect(loaded.telemetry().batteryMillivolts).toBeLessThan(idle.telemetry().batteryMillivolts);
  });

  it("reports every op it emits as a known opcode", () => {
    const hub = new VirtualHub(0);
    hub.receive(encodeHello(), 0);
    streamDrive(hub, 0, 600, 1, 1);
    for (const op of opsOf(hub)) {
      expect([Op.HELLO_ACK, Op.TELEMETRY, Op.EVENT]).toContain(op);
    }
  });
});
