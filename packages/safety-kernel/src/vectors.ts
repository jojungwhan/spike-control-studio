/**
 * Golden vector format, shared by the TypeScript kernel and its Python mirror.
 *
 * A vector is a fully deterministic replay: an initial config plus an ordered
 * list of (event, nowMs) with the actions and observable state expected after
 * each step. Both implementations replay the same committed JSON, which is what
 * keeps them from drifting apart.
 *
 * Only an explicit *subset* of kernel state is asserted. Internal bookkeeping is
 * free to differ between languages; what must match is what a robot can observe.
 */
import type { SafetyConfig } from "@spike/protocol";
import type { KernelAction, KernelEvent, KernelState } from "./kernel.js";

export interface ObservableState {
  estopLatched: boolean;
  leaseId: string | null;
  ownerId: string | null;
  lastSequence: number;
  rearmRequired: boolean;
  transportUp: boolean;
  latencyStopped: boolean;
  requested: { left: number; right: number };
  applied: { left: number; right: number };
}

export interface VectorStep {
  event: KernelEvent;
  nowMs: number;
  expect: {
    actions: KernelAction[];
    state: ObservableState;
  };
}

export interface Vector {
  name: string;
  description: string;
  profileId: string;
  config: SafetyConfig;
  steps: VectorStep[];
}

export interface VectorFile {
  formatVersion: 1;
  vectors: Vector[];
}

/**
 * Round to a fixed number of decimals so a float that differs only in the last
 * bit between JavaScript and Python does not read as a behavioral difference.
 * Six decimals is far finer than a motor can resolve.
 */
export function roundPower(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}

export function observable(state: KernelState): ObservableState {
  return {
    estopLatched: state.estopLatched,
    leaseId: state.lease?.leaseId ?? null,
    ownerId: state.lease?.ownerId ?? null,
    lastSequence: state.lastSequence,
    rearmRequired: state.rearmRequired,
    transportUp: state.transportUp,
    latencyStopped: state.latencyStopped,
    requested: {
      left: roundPower(state.requested.left),
      right: roundPower(state.requested.right),
    },
    applied: {
      left: roundPower(state.applied.left),
      right: roundPower(state.applied.right),
    },
  };
}

export function canonicalActions(actions: readonly KernelAction[]): KernelAction[] {
  return actions.map((action) =>
    action.kind === "applyMotor"
      ? { kind: "applyMotor", left: roundPower(action.left), right: roundPower(action.right) }
      : action,
  );
}
