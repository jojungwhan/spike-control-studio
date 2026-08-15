import { useCallback, useState } from "react";
import { BUILT_IN_PROFILES } from "@spike/safety-kernel";
import { useControlHost } from "./control/useControlHost.js";
import { Joystick } from "./ui/Joystick.js";
import { useKeyboardDrive } from "./ui/useKeyboardDrive.js";

const STATE_LABEL: Record<string, { label: string; tone: string }> = {
  disconnected: { label: "Not connected", tone: "neutral" },
  connecting: { label: "Connecting", tone: "connecting" },
  connected: { label: "Connected", tone: "ready" },
  reconnecting: { label: "Link lost", tone: "critical" },
  failed: { label: "Failed", tone: "critical" },
};

export function App() {
  const { snapshot, logs, actions } = useControlHost();
  const [profileId, setProfileId] = useState("balanced");

  const connected = snapshot.transport === "connected" || snapshot.transport === "reconnecting";
  const driving = snapshot.controlEnabled && !snapshot.estopLatched;

  const setInput = useCallback(
    (left: number, right: number) => actions.setInput(left, right),
    [actions],
  );
  useKeyboardDrive(driving, setInput);

  const transportState = STATE_LABEL[snapshot.transport] ?? STATE_LABEL.disconnected!;
  const tone = snapshot.estopLatched
    ? "emergency"
    : snapshot.rearmRequired
      ? "warning"
      : driving
        ? "active"
        : transportState.tone;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__identity">
          <span className="topbar__name">SPIKE Control Studio</span>
          <span className="topbar__sub">Simulated hub · no hardware attached</span>
        </div>
        <div className="topbar__stats">
          <Stat label="Link" value={transportState.label} tone={tone} />
          <Stat label="Hub" value={snapshot.hubState} />
          <Stat
            label="Battery"
            value={snapshot.batteryPercent === null ? "—" : `${snapshot.batteryPercent}%`}
          />
          <Stat label="Rate" value={`${snapshot.commandRateHz.toFixed(1)} Hz`} />
          <Stat
            label="Cmd age"
            value={snapshot.commandAgeMs === null ? "—" : `${snapshot.commandAgeMs} ms`}
          />
          <Stat label="Agent" value={snapshot.agentVersion ?? "—"} />
        </div>
      </header>

      {snapshot.estopLatched && (
        <div className="banner banner--emergency">
          <strong>Emergency stop latched.</strong> Motors are held at zero. It stays latched until
          you reset it explicitly.
          <button type="button" onClick={actions.emergencyReset}>
            Reset emergency stop
          </button>
        </div>
      )}
      {!snapshot.estopLatched && snapshot.rearmRequired && (
        <div className="banner banner--warning">
          <strong>Re-arm required.</strong> The lease went quiet or the link dropped, so queued
          motion is being refused. Return the controls to centre to re-arm.
        </div>
      )}

      <main className="grid">
        <section className="panel">
          <h2>Drive</h2>
          <Joystick disabled={!driving} onChange={setInput} />
          <p className="hint">
            Drag the pad, or use the arrow keys / WASD. Releasing returns to centre.
          </p>
          <div className="motorbars">
            <MotorBar
              label="Left"
              requested={snapshot.requested.left}
              applied={snapshot.applied.left}
            />
            <MotorBar
              label="Right"
              requested={snapshot.requested.right}
              applied={snapshot.applied.right}
            />
          </div>
        </section>

        <section className="panel">
          <h2>Session</h2>
          <label className="field">
            <span>Safety profile</span>
            <select
              value={profileId}
              onChange={(event) => {
                setProfileId(event.target.value);
                if (connected) actions.setProfile(event.target.value);
              }}
            >
              {BUILT_IN_PROFILES.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} — {Math.round(profile.config.maxPower * 100)}% max,{" "}
                  {profile.config.commandTimeoutMs} ms lease
                </option>
              ))}
            </select>
          </label>

          <div className="buttonrow">
            {!connected ? (
              <button type="button" className="primary" onClick={() => actions.connect(profileId)}>
                Connect
              </button>
            ) : (
              <button type="button" onClick={actions.disconnect}>
                Disconnect
              </button>
            )}
            {snapshot.controlEnabled ? (
              <button type="button" onClick={actions.disableControl} disabled={!connected}>
                Disable control
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                onClick={actions.enableControl}
                disabled={!connected || snapshot.estopLatched}
              >
                Enable control
              </button>
            )}
          </div>

          <button
            type="button"
            className="estop"
            onClick={() => actions.emergencyStop("operator_pressed")}
            disabled={!connected}
          >
            Emergency stop
          </button>

          <h3>Fault injection</h3>
          <p className="hint">
            The hub keeps running when the link drops — a real Pybricks program does not stop on
            disconnect. Only the hub watchdog brings the motors down.
          </p>
          <div className="buttonrow">
            <button type="button" onClick={actions.dropLink} disabled={!connected}>
              Drop link
            </button>
            <button type="button" onClick={actions.restoreLink} disabled={!connected}>
              Restore link
            </button>
            <button type="button" onClick={() => actions.setLatency(2500)} disabled={!connected}>
              Latency spike
            </button>
            <button type="button" onClick={() => actions.setLatency(40)} disabled={!connected}>
              Latency normal
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>Telemetry</h2>
          <dl className="telemetry">
            <Row label="Left angle" value={fmt(snapshot.telemetry?.left.angleDeg, "°")} />
            <Row label="Left speed" value={fmt(snapshot.telemetry?.left.speedDegPerSec, "°/s")} />
            <Row label="Right angle" value={fmt(snapshot.telemetry?.right.angleDeg, "°")} />
            <Row label="Right speed" value={fmt(snapshot.telemetry?.right.speedDegPerSec, "°/s")} />
            <Row label="Battery" value={fmt(snapshot.telemetry?.batteryMillivolts, " mV")} />
            <Row label="Hub e-stop" value={snapshot.telemetry?.estopLatched ? "latched" : "clear"} />
            <Row
              label="Hub watchdog"
              value={snapshot.telemetry?.watchdogTripped ? "tripped" : "ok"}
            />
            <Row label="Latency" value={snapshot.latencyMs === null ? "—" : `${snapshot.latencyMs} ms`} />
            <Row label="Commands sent" value={String(snapshot.counters.commandsSent)} />
            <Row label="Commands rejected" value={String(snapshot.counters.commandsRejected)} />
            <Row label="Telemetry frames" value={String(snapshot.counters.telemetryFrames)} />
            <Row label="Last reject" value={snapshot.lastRejectReason ?? "—"} />
            <Row label="Last stop" value={snapshot.lastStopReason ?? "—"} />
          </dl>
        </section>

        <section className="panel">
          <h2>Events</h2>
          {logs.length === 0 ? (
            <p className="hint">Nothing yet.</p>
          ) : (
            <ul className="log">
              {logs.map((line) => (
                <li key={line.id} className={`log__line log__line--${line.level}`}>
                  {line.message}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="footer">
        The safety kernel runs in a Web Worker and is authoritative: the interface can request
        motion, but only the kernel decides. Every value on the wire has already been clamped,
        limited and ramped.
      </footer>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`stat${tone ? ` stat--${tone}` : ""}`}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function MotorBar({
  label,
  requested,
  applied,
}: {
  label: string;
  requested: number;
  applied: number;
}) {
  return (
    <div className="motorbar">
      <div className="motorbar__head">
        <span>{label}</span>
        <span>
          {Math.round(applied * 100)}%
          {Math.abs(requested - applied) > 0.005 && (
            <em className="motorbar__requested"> (asked {Math.round(requested * 100)}%)</em>
          )}
        </span>
      </div>
      <div className="motorbar__track">
        <div
          className="motorbar__fill"
          style={{
            width: `${Math.abs(applied) * 50}%`,
            left: applied >= 0 ? "50%" : `${50 - Math.abs(applied) * 50}%`,
          }}
        />
        <div className="motorbar__zero" />
      </div>
    </div>
  );
}

function fmt(value: number | undefined, suffix: string): string {
  return value === undefined ? "—" : `${value}${suffix}`;
}
