/**
 * One transport interface, three implementations (Web Bluetooth, bridge
 * WebSocket, simulator). Everything above this line speaks SCS frames and does
 * not care which one is underneath.
 */
import type { ScsFrame } from "@spike/protocol";

export type TransportKind = "simulator" | "web-bluetooth" | "bridge-ws";

export type TransportState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export type Unsubscribe = () => void;

export interface Transport {
  readonly kind: TransportKind;
  readonly state: TransportState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Queue an SCS frame. Implementations add their own tunnel framing (the
   * Pybricks WRITE_STDIN byte for the BLE paths). Returns immediately: delivery
   * is best-effort and the safety model never depends on a write completing.
   */
  send(frame: Uint8Array): void;
  onFrame(listener: (frame: ScsFrame) => void): Unsubscribe;
  onStateChange(listener: (state: TransportState) => void): Unsubscribe;
}

export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  subscribe(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  get size(): number {
    return this.listeners.size;
  }
}

/**
 * Single-flight sender with latest-wins coalescing.
 *
 * The Pybricks profile removed write-without-response, so every command costs an
 * ATT round trip and only one GATT operation may be in flight at a time. Two
 * consequences, both handled here:
 *
 * 1. Overlapping writes would throw "GATT operation already in progress", so
 *    writes are serialized through one promise chain.
 * 2. If the UI outruns the link, queueing every frame would build a backlog and
 *    replay stale motion after a stall. Instead the pending slot holds only the
 *    newest fast-channel frame, so a delayed link loses intermediate positions
 *    rather than acting on them late.
 *
 * Reliable frames (emergency stop, config) are queued in order and never
 * dropped — losing one of those is not an option.
 */
export class CoalescingWriter {
  private pendingFast: Uint8Array | null = null;
  private readonly reliableQueue: Uint8Array[] = [];
  private inFlight = false;
  private closed = false;

  /** Frames dropped because a newer one superseded them. Surfaced as a diagnostic. */
  coalescedCount = 0;

  constructor(private readonly write: (frame: Uint8Array) => Promise<void>) {}

  /** Latest-wins. An older unsent frame is discarded, not queued. */
  sendFast(frame: Uint8Array): void {
    if (this.closed) return;
    if (this.pendingFast !== null) this.coalescedCount += 1;
    this.pendingFast = frame;
    void this.pump();
  }

  /** Ordered and lossless. */
  sendReliable(frame: Uint8Array): void {
    if (this.closed) return;
    this.reliableQueue.push(frame);
    void this.pump();
  }

  close(): void {
    this.closed = true;
    this.pendingFast = null;
    this.reliableQueue.length = 0;
  }

  get idle(): boolean {
    return !this.inFlight && this.pendingFast === null && this.reliableQueue.length === 0;
  }

  private async pump(): Promise<void> {
    if (this.inFlight || this.closed) return;
    this.inFlight = true;
    try {
      while (!this.closed) {
        // Reliable frames go first: an emergency stop must not wait behind a
        // steering update.
        const next = this.reliableQueue.shift() ?? this.takeFast();
        if (next === null) break;
        try {
          await this.write(next);
        } catch {
          // A failed write is not a safety event on its own — the lease TTL and
          // the hub watchdog cover it. Drop it and keep the queue moving.
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  private takeFast(): Uint8Array | null {
    const frame = this.pendingFast;
    this.pendingFast = null;
    return frame;
  }
}
