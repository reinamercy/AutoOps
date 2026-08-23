"use client";

import { useEffect, useState } from "react";
import { FiActivity } from "react-icons/fi";
import ThemeToggle from "./ThemeToggle";

interface Props {
  connectionStatus: "connecting" | "connected" | "disconnected";
  executionMode: string | null;
}

export default function Header({ connectionStatus, executionMode }: Props) {
  const [clock, setClock] = useState("");

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString("en-US", { hour12: false }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const dotColor =
    connectionStatus === "connected"
      ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
      : connectionStatus === "connecting"
        ? "bg-amber-400 animate-pulse"
        : "bg-red-500";

  return (
    <header className="flex items-center justify-between border-b border-border/70 bg-surface/70 px-6 py-3 backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-neon/20 to-purple-neon/20 text-cyan-neon ring-1 ring-cyan-neon/30">
          <FiActivity size={16} />
        </span>
        <div className="leading-tight">
          <div className="text-[15px] font-bold tracking-tight">AutoOps AI</div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted">
            Enterprise Dashboard
          </div>
        </div>
      </div>

      <div className="flex items-center gap-5">
        {executionMode && (
          <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
            {executionMode} mode
          </span>
        )}
        <div className="flex items-center gap-1.5 text-xs">
          <span className={`h-2 w-2 rounded-full transition-colors ${dotColor}`} />
          <span className="text-muted">
            {connectionStatus === "connected"
              ? "Live"
              : connectionStatus === "connecting"
                ? "Connecting…"
                : "Disconnected"}
          </span>
        </div>
        <span className="hidden text-xs tabular-nums text-muted sm:inline">{clock}</span>
        <ThemeToggle />
      </div>
    </header>
  );
}
