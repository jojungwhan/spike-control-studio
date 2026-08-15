/**
 * Host protocol — JSON messages between an operator client and the Robot Host.
 *
 * The Robot Host is whichever machine is physically near the robot: the browser
 * itself in direct Web Bluetooth mode, the bridge process in bridge/Pi mode.
 * These messages carry the control lease; they never reach the hub, which only
 * ever sees SCS frames (see ./scs.ts).
 */
import { z } from "zod";

export const HOST_PROTOCOL_VERSION = 1;

/** Manual command lease bounds, per PRD 13.2. */
export const TTL_MIN_MS = 150;
export const TTL_DEFAULT_MS = 600;
export const TTL_MAX_MS = 10_000;

const unitPower = z.number().finite().min(-1).max(1);

const envelope = {
  version: z.literal(HOST_PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  /**
   * Sender's wall clock at send time. Diagnostics only — it feeds the
   * "command age" readout. Freshness is judged by the receiving host against
   * its own monotonic clock, so clock skew can never move a robot.
   */
  sentAt: z.number().int(),
};

export const DriveCommandSchema = z.object({
  ...envelope,
  type: z.literal("drive"),
  leaseId: z.string().min(1),
  senderId: z.string().min(1),
  ttlMs: z.number().int().min(TTL_MIN_MS).max(TTL_MAX_MS),
  mode: z.literal("manual"),
  left: unitPower,
  right: unitPower,
});
export type DriveCommand = z.infer<typeof DriveCommandSchema>;

export const StopCommandSchema = z.object({
  ...envelope,
  type: z.literal("stop"),
  leaseId: z.string().min(1),
  senderId: z.string().min(1),
  reason: z.string().min(1),
});
export type StopCommand = z.infer<typeof StopCommandSchema>;

export const EmergencyStopSchema = z.object({
  ...envelope,
  type: z.literal("emergency_stop"),
  eventId: z.string().min(1),
  senderId: z.string().min(1),
  reason: z.string().min(1),
});
export type EmergencyStop = z.infer<typeof EmergencyStopSchema>;

export const EmergencyResetSchema = z.object({
  ...envelope,
  type: z.literal("emergency_reset"),
  eventId: z.string().min(1),
  senderId: z.string().min(1),
});
export type EmergencyReset = z.infer<typeof EmergencyResetSchema>;

/**
 * Opens a control lease. Only the holder of the current lease may drive, and a
 * new grant supersedes the previous one — which is how instructor takeover and
 * "one active driver" fall out of the same mechanism.
 */
export const ControlGrantSchema = z.object({
  ...envelope,
  type: z.literal("control_grant"),
  leaseId: z.string().min(1),
  senderId: z.string().min(1),
});
export type ControlGrant = z.infer<typeof ControlGrantSchema>;

export const ControlReleaseSchema = z.object({
  ...envelope,
  type: z.literal("control_release"),
  leaseId: z.string().min(1),
  senderId: z.string().min(1),
  reason: z.string().min(1),
});
export type ControlRelease = z.infer<typeof ControlReleaseSchema>;

/**
 * Safety settings the kernel actually enforces. Anything the kernel cannot
 * enforce with MVP 1 data does not appear here — a profile document may carry
 * forward-compatible extras, but a knob in this schema is a knob that works.
 */
export const SafetyConfigSchema = z.object({
  /** Ceiling applied to |motor power| after mixing. Never above 1. */
  maxPower: z.number().finite().min(0.01).max(1),
  /** Manual command lease TTL. Expiration itself can never be switched off. */
  commandTimeoutMs: z.number().int().min(TTL_MIN_MS).max(TTL_MAX_MS),
  /** Max change in normalized power per second; null means step instantly. */
  accelRampPerSec: z.number().finite().positive().nullable(),
  /** Warn above this measured latency; null disables the warning. */
  latencyWarnMs: z.number().int().positive().nullable(),
  /** Stop above this measured latency; null disables latency-based stopping. */
  latencyStopMs: z.number().int().positive().nullable(),
});
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;

export const SafetyProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  builtIn: z.boolean(),
  expert: z.boolean(),
  config: SafetyConfigSchema,
});
export type SafetyProfile = z.infer<typeof SafetyProfileSchema>;

export const SafetyConfigSyncSchema = z.object({
  ...envelope,
  type: z.literal("safety_config"),
  senderId: z.string().min(1),
  profileId: z.string().min(1),
  config: SafetyConfigSchema,
});
export type SafetyConfigSync = z.infer<typeof SafetyConfigSyncSchema>;

/** Every operator -> host message. */
export const HostCommandSchema = z.discriminatedUnion("type", [
  DriveCommandSchema,
  StopCommandSchema,
  EmergencyStopSchema,
  EmergencyResetSchema,
  ControlGrantSchema,
  ControlReleaseSchema,
  SafetyConfigSyncSchema,
]);
export type HostCommand = z.infer<typeof HostCommandSchema>;

/** Which logical channel a message belongs on, per PRD 18. */
export function channelFor(type: HostCommand["type"]): "control-fast" | "control-reliable" {
  return type === "drive" ? "control-fast" : "control-reliable";
}

export const TelemetrySchema = z.object({
  version: z.literal(HOST_PROTOCOL_VERSION),
  type: z.literal("telemetry"),
  robotId: z.string().min(1),
  hostTimestamp: z.number().int(),
  hub: z.object({
    connected: z.boolean(),
    batteryPercent: z.number().min(0).max(100).nullable(),
    batteryMillivolts: z.number().int().nonnegative().nullable(),
    rssi: z.number().int().nullable(),
    agentVersion: z.string().nullable(),
  }),
  motors: z.object({
    left: z.object({
      requestedPower: unitPower,
      appliedPower: unitPower,
      angle: z.number().int(),
      speed: z.number().int(),
    }),
    right: z.object({
      requestedPower: unitPower,
      appliedPower: unitPower,
      angle: z.number().int(),
      speed: z.number().int(),
    }),
  }),
  network: z.object({
    roundTripMs: z.number().nonnegative().nullable(),
  }),
  safety: z.object({
    profileId: z.string(),
    emergencyStop: z.boolean(),
    commandAgeMs: z.number().nonnegative().nullable(),
    watchdogTripped: z.boolean(),
  }),
});
export type Telemetry = z.infer<typeof TelemetrySchema>;

/**
 * Parse an untrusted operator message. Returns null rather than throwing so the
 * caller's hot path stays branch-simple: a null is a rejected command, and a
 * rejected command never reaches the kernel.
 */
export function parseHostCommand(raw: unknown): HostCommand | null {
  const result = HostCommandSchema.safeParse(raw);
  return result.success ? result.data : null;
}
