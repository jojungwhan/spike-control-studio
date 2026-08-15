import { useEffect, useRef } from "react";

const KEY_MAP: Record<string, "up" | "down" | "left" | "right"> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
  W: "up",
  S: "down",
  A: "left",
  D: "right",
};

/**
 * Keyboard driving. Held keys are tracked as a set rather than acted on per
 * event, so the intent is a state, not a stream — releasing the last key
 * produces exactly one zero, and losing window focus produces one too.
 */
export function useKeyboardDrive(
  enabled: boolean,
  onChange: (left: number, right: number) => void,
): void {
  const held = useRef(new Set<string>());
  const lastSent = useRef({ left: 0, right: 0 });

  useEffect(() => {
    const emit = () => {
      const keys = held.current;
      const throttle = (keys.has("up") ? 1 : 0) - (keys.has("down") ? 1 : 0);
      const steer = (keys.has("right") ? 1 : 0) - (keys.has("left") ? 1 : 0);
      const left = clamp(throttle + steer * 0.7);
      const right = clamp(throttle - steer * 0.7);
      if (left === lastSent.current.left && right === lastSent.current.right) return;
      lastSent.current = { left, right };
      onChange(left, right);
    };

    const release = () => {
      if (held.current.size === 0) return;
      held.current.clear();
      emit();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!enabled) return;
      const direction = KEY_MAP[event.key];
      if (direction === undefined) return;
      event.preventDefault();
      if (held.current.has(direction)) return;
      held.current.add(direction);
      emit();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const direction = KEY_MAP[event.key];
      if (direction === undefined) return;
      event.preventDefault();
      held.current.delete(direction);
      emit();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    // A tab switch mid-drive must not leave a key logically held down.
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);

    if (!enabled) release();

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, [enabled, onChange]);
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
