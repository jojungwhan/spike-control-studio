/**
 * In-process transport backed by the virtual hub.
 *
 * Time is injected rather than read from a clock, so a test can step a whole
 * session deterministically. `SimulatorClockDriver` wires it to real time for
 * interactive use in the browser.
 */
import { FrameParser, type ScsFrame } from "@spike/protocol";
import { VirtualHub, type HubOptions } from "@spike/simulator";
import {
  Emitter,
  type Transport,
  type TransportKind,
  type TransportState,
  type Unsubscribe,
} from "./transport.js";

export interface SimulatorTransportOptions extends HubOptions {
  /** Simulated one-way link delay applied in both directions. */
  latencyMs?: number;
}

interface DelayedFrame {
  bytes: Uint8Array;
  deliverAtMs: number;
}

export class SimulatorTransport implements Transport {
  readonly kind: TransportKind = "simulator";

  private readonly frames = new Emitter<ScsFrame>();
  private readonly states = new Emitter<TransportState>();
  private readonly parser = new FrameParser();
  private readonly inbound: DelayedFrame[] = [];
  private readonly outbound: DelayedFrame[] = [];
  private readonly latencyMs: number;

  private currentState: TransportState = "disconnected";
  private nowMs: number;

  readonly hub: VirtualHub;

  constructor(startMs = 0, options: SimulatorTransportOptions = {}) {
    this.nowMs = startMs;
    this.latencyMs = options.latencyMs ?? 0;
    this.hub = new VirtualHub(startMs, options);
  }

  get state(): TransportState {
    return this.currentState;
  }

  async connect(): Promise<void> {
    this.setState("connecting");
    this.setState("connected");
  }

  async disconnect(): Promise<void> {
    this.setState("disconnected");
  }

  send(frame: Uint8Array): void {
    if (this.currentState !== "connected") return;
    this.inbound.push({ bytes: frame, deliverAtMs: this.nowMs + this.latencyMs });
  }

  onFrame(listener: (frame: ScsFrame) => void): Unsubscribe {
    return this.frames.subscribe(listener);
  }

  onStateChange(listener: (state: TransportState) => void): Unsubscribe {
    return this.states.subscribe(listener);
  }

  /** Advance simulated time, moving frames in both directions and ticking the hub. */
  advance(nowMs: number): void {
    this.nowMs = nowMs;

    for (let i = this.inbound.length - 1; i >= 0; i -= 1) {
      const queued = this.inbound[i]!;
      if (queued.deliverAtMs > nowMs) continue;
      this.inbound.splice(i, 1);
      this.hub.receive(queued.bytes, nowMs);
    }

    this.hub.advance(nowMs);

    for (const bytes of this.hub.drain()) {
      this.outbound.push({ bytes, deliverAtMs: nowMs + this.latencyMs });
    }

    for (let i = this.outbound.length - 1; i >= 0; i -= 1) {
      const queued = this.outbound[i]!;
      if (queued.deliverAtMs > nowMs) continue;
      this.outbound.splice(i, 1);
      if (this.currentState !== "connected") continue;
      for (const frame of this.parser.feedAll(queued.bytes)) this.frames.emit(frame);
    }
  }

  /** Simulate the link vanishing without the hub program stopping. */
  dropLink(): void {
    this.hub.setFaults({ linkDown: true });
    this.setState("reconnecting");
  }

  restoreLink(): void {
    this.hub.setFaults({ linkDown: false });
    this.setState("connected");
  }

  private setState(next: TransportState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    this.states.emit(next);
  }
}
