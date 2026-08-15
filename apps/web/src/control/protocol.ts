/**
 * Messages between the UI thread and the Control Worker.
 *
 * The split exists because the worker owns everything timing-critical: the
 * 20 Hz scheduler, the safety kernel, lease and sequence bookkeeping. Render
 * jank on the main thread can delay a transport write, but it can never delay a
 * safety decision.
 */
import type { HubTelemetry } from "@spike/protocol";
import type { TransportState } from "@spike/device-adapters";

export type ToWorker =
  | { type: "connect"; profileId: string }
  | { type: "disconnect" }
  | { type: "enableControl" }
  | { type: "disableControl" }
  /** Latest operator intent. Superseded by the next one; never queued. */
  | { type: "input"; left: number; right: number }
  | { type: "emergencyStop"; reason: string }
  | { type: "emergencyReset" }
  | { type: "setProfile"; profileId: string }
  /** Fault injection, so the safety behavior can be demonstrated without hardware. */
  | { type: "dropLink" }
  | { type: "restoreLink" }
  | { type: "setLatency"; roundTripMs: number };

export interface Snapshot {
  transport: TransportState;
  /** True once a control lease is held. */
  controlEnabled: boolean;
  estopLatched: boolean;
  rearmRequired: boolean;
  profileId: string;
  requested: { left: number; right: number };
  applied: { left: number; right: number };
  /** Milliseconds since the last accepted command, or null if none. */
  commandAgeMs: number | null;
  latencyMs: number | null;
  latencyStopped: boolean;
  telemetry: HubTelemetry | null;
  batteryPercent: number | null;
  hubState: string;
  agentVersion: string | null;
  /** Rolling counters, useful for showing that rejects are happening. */
  counters: {
    commandsSent: number;
    commandsRejected: number;
    telemetryFrames: number;
    coalesced: number;
  };
  lastRejectReason: string | null;
  lastStopReason: string | null;
  /** Measured emission rate of the control loop. */
  commandRateHz: number;
}

export type FromWorker =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "log"; level: "info" | "warn"; message: string };
