"""Replay the committed golden vectors against the Python kernel.

This is the other half of the cross-language contract. The TypeScript reference
replays the same file in packages/safety-kernel/src/vectors.test.ts. If this
suite fails, the two kernels have diverged and one of them is wrong -- which
matters because the bridge is the Robot Host in bridge and Raspberry Pi modes,
where nothing else is close enough to the robot to make a safety decision.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from spike_bridge.kernel import (
    SafetyConfig,
    canonical_actions,
    create_initial_state,
    observable,
    step,
)

VECTOR_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "safety-kernel"
    / "vectors"
    / "kernel-vectors.json"
)

REQUIRED_VECTORS = {
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
}


def load_vectors() -> dict[str, Any]:
    assert VECTOR_PATH.exists(), (
        f"golden vectors missing at {VECTOR_PATH}; "
        "run `pnpm --filter @spike/safety-kernel gen:vectors`"
    )
    # parse_constant fires on Infinity/NaN, which are not valid JSON. The
    # reference kernel sanitizes intent at intake precisely so they cannot
    # appear here; if one does, the vectors are unusable for cross-language
    # replay and we want a loud failure rather than a silent float('inf').
    def reject_constant(name: str) -> Any:
        raise AssertionError(f"vectors contain non-JSON constant: {name}")

    return json.loads(VECTOR_PATH.read_text(), parse_constant=reject_constant)


VECTORS = load_vectors()


def test_format_version_is_supported() -> None:
    assert VECTORS["formatVersion"] == 1
    assert len(VECTORS["vectors"]) > 10


def test_safety_critical_vectors_are_present() -> None:
    names = {vector["name"] for vector in VECTORS["vectors"]}
    missing = REQUIRED_VECTORS - names
    assert not missing, f"missing golden vectors: {sorted(missing)}"


@pytest.mark.parametrize(
    "vector",
    VECTORS["vectors"],
    ids=[vector["name"] for vector in VECTORS["vectors"]],
)
def test_replays_vector(vector: dict[str, Any]) -> None:
    state = create_initial_state(
        SafetyConfig.from_json(vector["config"]), vector["profileId"], 0
    )
    for index, expected in enumerate(vector["steps"]):
        state, actions = step(state, expected["event"], expected["nowMs"])
        assert canonical_actions(actions) == expected["expect"]["actions"], (
            f"{vector['name']} step {index}: actions diverged from the TypeScript reference"
        )
        assert observable(state) == expected["expect"]["state"], (
            f"{vector['name']} step {index}: state diverged from the TypeScript reference"
        )


def test_no_vector_commands_a_motor_out_of_range() -> None:
    for vector in VECTORS["vectors"]:
        for vector_step in vector["steps"]:
            for action in vector_step["expect"]["actions"]:
                if action["kind"] != "applyMotor":
                    continue
                assert abs(action["left"]) <= 1
                assert abs(action["right"]) <= 1
