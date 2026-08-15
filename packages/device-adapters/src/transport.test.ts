import { describe, expect, it } from "vitest";
import { Op, decodeTelemetry, encodeDrive, encodeEstop, encodeHello } from "@spike/protocol";
import { CoalescingWriter } from "./transport.js";
import { SimulatorTransport } from "./simulator-transport.js";

/** A write function whose completion the test controls. */
function controllableWrite() {
  const sent: Uint8Array[] = [];
  let release: (() => void) | null = null;
  const write = async (frame: Uint8Array) => {
    sent.push(frame);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  return {
    sent,
    write,
    finishOne() {
      const resolve = release;
      release = null;
      resolve?.();
      return new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe("CoalescingWriter", () => {
  it("keeps only the newest fast frame while a write is in flight", async () => {
    const link = controllableWrite();
    const writer = new CoalescingWriter(link.write);

    writer.sendFast(encodeDrive(0.1, 0.1));
    await new Promise((r) => setTimeout(r, 0));
    expect(link.sent).toHaveLength(1);

    // Three more arrive while the first write is still outstanding.
    writer.sendFast(encodeDrive(0.2, 0.2));
    writer.sendFast(encodeDrive(0.3, 0.3));
    writer.sendFast(encodeDrive(0.4, 0.4));
    expect(writer.coalescedCount).toBe(2);

    await link.finishOne();
    // Only the newest survived; 0.2 and 0.3 were never sent.
    expect(link.sent).toHaveLength(2);
    expect(link.sent[1]).toEqual(encodeDrive(0.4, 0.4));
  });

  it("never drops a reliable frame and sends it ahead of steering", async () => {
    const link = controllableWrite();
    const writer = new CoalescingWriter(link.write);

    writer.sendFast(encodeDrive(0.5, 0.5));
    await new Promise((r) => setTimeout(r, 0));

    writer.sendFast(encodeDrive(0.6, 0.6));
    writer.sendReliable(encodeEstop());
    writer.sendReliable(encodeHello());

    await link.finishOne();
    await link.finishOne();
    await link.finishOne();

    expect(link.sent[1]).toEqual(encodeEstop());
    expect(link.sent[2]).toEqual(encodeHello());
  });

  it("survives a failing write without wedging the queue", async () => {
    let calls = 0;
    const writer = new CoalescingWriter(async () => {
      calls += 1;
      throw new Error("GATT failure");
    });
    writer.sendReliable(encodeEstop());
    writer.sendReliable(encodeHello());
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    expect(writer.idle).toBe(true);
  });

  it("stops accepting frames once closed", async () => {
    const sent: Uint8Array[] = [];
    const writer = new CoalescingWriter(async (frame) => {
      sent.push(frame);
    });
    writer.close();
    writer.sendFast(encodeDrive(1, 1));
    writer.sendReliable(encodeEstop());
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(0);
  });
});

describe("SimulatorTransport", () => {
  it("carries frames to the hub and telemetry back", async () => {
    const transport = new SimulatorTransport(0);
    const received: number[] = [];
    transport.onFrame((frame) => received.push(frame.op));
    await transport.connect();

    transport.send(encodeHello());
    transport.advance(20);
    expect(received).toContain(Op.HELLO_ACK);

    for (let now = 40; now <= 400; now += 20) {
      transport.send(encodeDrive(1, 1));
      transport.advance(now);
    }
    expect(received).toContain(Op.TELEMETRY);
    expect(transport.hub.moving).toBe(true);
  });

  it("reports motor state through decoded telemetry", async () => {
    const transport = new SimulatorTransport(0);
    const telemetry: ReturnType<typeof decodeTelemetry>[] = [];
    transport.onFrame((frame) => {
      if (frame.op === Op.TELEMETRY) telemetry.push(decodeTelemetry(frame.payload));
    });
    await transport.connect();
    transport.send(encodeHello());
    for (let now = 20; now <= 600; now += 20) {
      transport.send(encodeDrive(0.8, -0.8));
      transport.advance(now);
    }
    const last = telemetry[telemetry.length - 1];
    expect(last?.left.speedDegPerSec).toBeGreaterThan(0);
    expect(last?.right.speedDegPerSec).toBeLessThan(0);
  });

  it("delays delivery by the configured link latency", async () => {
    const transport = new SimulatorTransport(0, { latencyMs: 100 });
    const received: number[] = [];
    transport.onFrame((frame) => received.push(frame.op));
    await transport.connect();

    transport.send(encodeHello());
    transport.advance(50);
    // Still in flight toward the hub.
    expect(received).toHaveLength(0);

    transport.advance(150);
    transport.advance(300);
    expect(received).toContain(Op.HELLO_ACK);
  });

  it("leaves the hub running when the link drops, until its watchdog fires", async () => {
    const transport = new SimulatorTransport(0, { watchdogMs: 250 });
    await transport.connect();
    transport.send(encodeHello());
    for (let now = 20; now <= 200; now += 20) {
      transport.send(encodeDrive(1, 1));
      transport.advance(now);
    }
    expect(transport.hub.moving).toBe(true);

    transport.dropLink();
    transport.advance(240);
    expect(transport.state).toBe("reconnecting");
    expect(transport.hub.running).toBe(true);
    expect(transport.hub.moving).toBe(true);

    for (let now = 260; now <= 700; now += 20) transport.advance(now);
    expect(transport.hub.moving).toBe(false);
    expect(transport.hub.watchdogHasTripped).toBe(true);
  });

  it("ignores sends while disconnected", async () => {
    const transport = new SimulatorTransport(0);
    transport.send(encodeHello());
    transport.advance(100);
    expect(transport.hub.currentState).toBe("BOOTING");
  });
});
