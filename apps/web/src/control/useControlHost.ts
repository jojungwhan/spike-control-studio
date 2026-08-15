import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FromWorker, Snapshot, ToWorker } from "./protocol.js";

const EMPTY: Snapshot = {
  transport: "disconnected",
  controlEnabled: false,
  estopLatched: false,
  rearmRequired: false,
  profileId: "balanced",
  requested: { left: 0, right: 0 },
  applied: { left: 0, right: 0 },
  commandAgeMs: null,
  latencyMs: null,
  latencyStopped: false,
  telemetry: null,
  batteryPercent: null,
  hubState: "disconnected",
  agentVersion: null,
  counters: { commandsSent: 0, commandsRejected: 0, telemetryFrames: 0, coalesced: 0 },
  lastRejectReason: null,
  lastStopReason: null,
  commandRateHz: 0,
};

export interface LogLine {
  id: number;
  level: "info" | "warn";
  message: string;
}

/**
 * Owns the Control Worker. The UI never touches the kernel directly — it sends
 * intent and renders what comes back.
 */
export function useControlHost() {
  const workerRef = useRef<Worker | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logId = useRef(0);

  useEffect(() => {
    const worker = new Worker(new URL("./worker/control-worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (message.type === "snapshot") {
        setSnapshot(message.snapshot);
        return;
      }
      logId.current += 1;
      const line: LogLine = { id: logId.current, level: message.level, message: message.message };
      setLogs((previous) => [line, ...previous].slice(0, 40));
    });
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const send = useCallback((message: ToWorker) => {
    workerRef.current?.postMessage(message);
  }, []);

  const actions = useMemo(
    () => ({
      connect: (profileId: string) => send({ type: "connect", profileId }),
      disconnect: () => send({ type: "disconnect" }),
      enableControl: () => send({ type: "enableControl" }),
      disableControl: () => send({ type: "disableControl" }),
      setInput: (left: number, right: number) => send({ type: "input", left, right }),
      emergencyStop: (reason: string) => send({ type: "emergencyStop", reason }),
      emergencyReset: () => send({ type: "emergencyReset" }),
      setProfile: (profileId: string) => send({ type: "setProfile", profileId }),
      dropLink: () => send({ type: "dropLink" }),
      restoreLink: () => send({ type: "restoreLink" }),
      setLatency: (roundTripMs: number) => send({ type: "setLatency", roundTripMs }),
    }),
    [send],
  );

  return { snapshot, logs, actions };
}
