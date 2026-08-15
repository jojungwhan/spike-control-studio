import { useCallback, useEffect, useRef, useState } from "react";

interface JoystickProps {
  disabled: boolean;
  onChange: (left: number, right: number) => void;
}

/**
 * Virtual joystick with arcade mixing.
 *
 * Pointer capture means a drag that leaves the pad still tracks, and releasing
 * anywhere still returns to centre — a stick that stayed deflected because the
 * pointer left the element would be a stuck throttle.
 */
export function Joystick({ disabled, onChange }: JoystickProps) {
  const padRef = useRef<HTMLDivElement | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const active = useRef(false);

  const emit = useCallback(
    (x: number, y: number) => {
      // Arcade mix: y is throttle, x is steering.
      const throttle = -y;
      const left = clamp(throttle + x);
      const right = clamp(throttle - x);
      onChange(left, right);
    },
    [onChange],
  );

  const centre = useCallback(() => {
    active.current = false;
    setKnob({ x: 0, y: 0 });
    onChange(0, 0);
  }, [onChange]);

  const move = useCallback(
    (clientX: number, clientY: number) => {
      const pad = padRef.current;
      if (pad === null) return;
      const rect = pad.getBoundingClientRect();
      const radius = rect.width / 2;
      let x = (clientX - (rect.left + radius)) / radius;
      let y = (clientY - (rect.top + radius)) / radius;
      const magnitude = Math.hypot(x, y);
      if (magnitude > 1) {
        x /= magnitude;
        y /= magnitude;
      }
      setKnob({ x, y });
      emit(x, y);
    },
    [emit],
  );

  useEffect(() => {
    if (disabled) centre();
  }, [disabled, centre]);

  return (
    <div
      ref={padRef}
      className={`joystick${disabled ? " joystick--disabled" : ""}`}
      role="application"
      aria-label="Virtual joystick"
      aria-disabled={disabled}
      onPointerDown={(event) => {
        if (disabled) return;
        active.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        move(event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        if (!active.current || disabled) return;
        move(event.clientX, event.clientY);
      }}
      onPointerUp={centre}
      onPointerCancel={centre}
      onLostPointerCapture={centre}
    >
      <div className="joystick__crosshair" />
      <div
        className="joystick__knob"
        style={{ transform: `translate(${knob.x * 42}%, ${knob.y * 42}%)` }}
      />
    </div>
  );
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
