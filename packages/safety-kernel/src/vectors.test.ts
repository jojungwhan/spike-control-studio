/**
 * Replay the committed golden vectors against the TypeScript kernel.
 *
 * This is the TS half of the cross-language contract. The Python mirror in
 * apps/bridge replays the exact same JSON. If this test fails, either the kernel
 * changed on purpose (regenerate with `pnpm gen:vectors`, then confirm the
 * Python suite still passes) or something changed by accident.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createInitialState, step } from "./kernel.js";
import { canonicalActions, observable, type VectorFile } from "./vectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const file = JSON.parse(
  readFileSync(join(here, "..", "vectors", "kernel-vectors.json"), "utf8"),
) as VectorFile;

describe("golden vectors", () => {
  it("has a recognized format version", () => {
    expect(file.formatVersion).toBe(1);
    expect(file.vectors.length).toBeGreaterThan(10);
  });

  it("covers the safety-critical scenarios by name", () => {
    // Named rather than counted: if someone deletes the emergency-stop vector,
    // a count assertion would pass as long as they added any other one.
    const names = new Set(file.vectors.map((vector) => vector.name));
    for (const required of [
      "grant-drive-stop",
      "profile-ceiling",
      "acceleration-ramp",
      "lease-expiry-and-rearm",
      "estop-latches",
      "ownership-and-sequence",
      "transport-loss",
      "latency-stop-and-recover",
      "malformed-never-moves",
      "out-of-contract-values",
      "instructor-takeover",
    ]) {
      expect(names, `missing golden vector: ${required}`).toContain(required);
    }
  });

  for (const vector of file.vectors) {
    it(`replays ${vector.name}`, () => {
      let state = createInitialState(vector.config, vector.profileId, 0);
      vector.steps.forEach((expected, index) => {
        const result = step(state, expected.event, expected.nowMs);
        state = result.state;
        expect(canonicalActions(result.actions), `${vector.name} step ${index} actions`).toEqual(
          expected.expect.actions,
        );
        expect(observable(state), `${vector.name} step ${index} state`).toEqual(
          expected.expect.state,
        );
      });
    });
  }

  it("never records a motor command outside hardware range", () => {
    for (const vector of file.vectors) {
      for (const vectorStep of vector.steps) {
        for (const action of vectorStep.expect.actions) {
          if (action.kind !== "applyMotor") continue;
          expect(Math.abs(action.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(action.right)).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
