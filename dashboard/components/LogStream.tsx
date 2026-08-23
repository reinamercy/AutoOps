"use client";

import { useEffect, useRef, useState } from "react";
import { FiActivity, FiPause, FiPlay } from "react-icons/fi";
import type { LogEntry } from "../lib/types";

interface Props {
  logs: LogEntry[];
}

const LEVEL_COLOR: Record<LogEntry["level"], string> = {
  info: "text-cyan-neon",
  warn: "text-amber-400",
  error: "text-danger",
};

export default function LogStream({ logs }: Props) {
  const [autoScroll, setAutoScroll] = useState(true);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  return (
    <div className="glass flex h-full min-h-[420px] flex-col rounded-2xl">
      <div className="flex items-center justify-between border-b border-[var(--hairline)] px-5 py-3.5">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <FiActivity className="text-cyan-neon" /> Live Agent Activity
          <span className="text-[10px] font-normal text-muted">({logs.length})</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setAutoScroll((a) => !a)}
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface2 px-2 py-1 text-[10px] text-muted transition-colors hover:text-text"
          >
            {autoScroll ? <FiPause /> : <FiPlay />} {autoScroll ? "Pause" : "Resume"}
          </button>
        </div>
      </div>
      <div ref={streamRef} className="thin-scroll flex-1 overflow-y-auto px-2 py-2 font-mono text-[11px]">
        {logs.length === 0 && (
          <div className="px-3 py-6 text-center text-muted/60">No activity yet.</div>
        )}
        {logs.map((log) => (
          <div
            key={log.id}
            className="flex items-start gap-2 rounded-md px-3 py-1 transition-colors hover:bg-[var(--overlay-med)] animate-fade-in-up"
          >
            <span className="shrink-0 text-muted/60">
              {new Date(log.ts).toLocaleTimeString("en-US", { hour12: false })}
            </span>
            <span className={`shrink-0 font-semibold ${LEVEL_COLOR[log.level]}`}>{log.agent}</span>
            <span className="break-words text-text/80">{log.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
