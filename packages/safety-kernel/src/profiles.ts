/**
 * Built-in safety profiles (PRD 13.4). These are code constants, not stored
 * documents — only Expert customs get persisted.
 *
 * `accelRampPerSec` is the change in normalized power allowed per second, so
 * 1.5 means a stopped robot reaches full commanded power in about two thirds of
 * a second. `null` steps instantly.
 */
import type { SafetyConfig, SafetyProfile } from "@spike/protocol";

export const RAMP_GENTLE = 1.5;
export const RAMP_MODERATE = 3;

export const DEMO_CONFIG: SafetyConfig = {
  maxPower: 0.35,
  commandTimeoutMs: 450,
  accelRampPerSec: RAMP_GENTLE,
  latencyWarnMs: 250,
  latencyStopMs: 1000,
};

export const BALANCED_CONFIG: SafetyConfig = {
  maxPower: 0.65,
  commandTimeoutMs: 600,
  accelRampPerSec: RAMP_MODERATE,
  latencyWarnMs: 350,
  latencyStopMs: 1500,
};

export const PERFORMANCE_CONFIG: SafetyConfig = {
  maxPower: 1,
  commandTimeoutMs: 1000,
  accelRampPerSec: null,
  latencyWarnMs: 500,
  latencyStopMs: null,
};

export const BUILT_IN_PROFILES: readonly SafetyProfile[] = [
  { id: "demo", name: "Demo", builtIn: true, expert: false, config: DEMO_CONFIG },
  { id: "balanced", name: "Balanced", builtIn: true, expert: false, config: BALANCED_CONFIG },
  {
    id: "performance",
    name: "Performance",
    builtIn: true,
    expert: true,
    config: PERFORMANCE_CONFIG,
  },
];

export const DEFAULT_PROFILE_ID = "balanced";

export function findBuiltInProfile(id: string): SafetyProfile | undefined {
  return BUILT_IN_PROFILES.find((profile) => profile.id === id);
}

/**
 * The hub watchdog measures link liveness, not operator intent, so it tracks the
 * profile timeout but is hard-capped an order of magnitude tighter. An Expert
 * lease may run to 10 s; the hub still stops within a second of silence, and the
 * host's heartbeat frames are what keep it alive in between commands.
 */
export function hubWatchdogMsFor(config: SafetyConfig): number {
  return Math.max(100, Math.min(1000, config.commandTimeoutMs));
}
