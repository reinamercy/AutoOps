"use client";

import { useEffect, useState } from "react";
import { FiCheckCircle, FiLoader, FiXCircle } from "react-icons/fi";
import { SiKubernetes } from "react-icons/si";
import type { ClusterStateUpdate } from "../lib/types";
import type { ClusterBanner } from "../hooks/useDashboardSocket";

interface Props {
  clusterState: ClusterStateUpdate | null;
  flash: boolean;
  banner: ClusterBanner | null;
  pollIntervalMs: number;
}

const BANNER_STYLE: Record<ClusterBanner["kind"], { wrap: string; icon: React.ReactNode }> = {
  running: { wrap: "bg-cyan-neon/10 text-cyan-neon", icon: <FiLoader className="animate-spin" /> },
  success: { wrap: "bg-emerald-400/10 text-emerald-400", icon: <FiCheckCircle /> },
  error: { wrap: "bg-danger/10 text-danger", icon: <FiXCircle /> },
};

function highlightLine(line: string, key: number) {
  let cls = "";
  if (/^NAME\s+READY/.test(line)) cls = "ct-header";
  else if (/\b(CrashLoopBackOff|Error|ImagePullBackOff|Failed)\b/.test(line)) cls = "ct-error";
  else if (/\b(Pending|ContainerCreating|Terminating)\b/.test(line)) cls = "ct-notready";
  else if (/\bRunning\b/.test(line)) cls = "ct-running";
  return (
    <div key={key} className={cls}>
      {line || " "}
    </div>
  );
}

export default function LiveClusterTerminal({ clusterState, flash, banner, pollIntervalMs }: Props) {
  const [staleFor, setStaleFor] = useState(0);

  useEffect(() => {
    setStaleFor(0);
    const id = setInterval(() => setStaleFor((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [clusterState?.timestamp]);

  const isStale = staleFor > 8;
  const live = clusterState?.ok && !isStale;

  return (
    <div className="glass mb-5 overflow-hidden rounded-2xl">
      <div className="flex items-center justify-between border-b border-[var(--hairline)] px-5 py-3.5">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <SiKubernetes className="text-cyan-neon" /> Live Cluster Terminal
        </div>
        <div className="text-[11px] text-muted">{clusterState?.namespace || "production"}</div>
      </div>

      {banner && (
        <div
          className={`flex items-center gap-2 border-b border-[var(--hairline)] px-5 py-1.5 font-mono text-[11px] ${BANNER_STYLE[banner.kind].wrap}`}
        >
          {BANNER_STYLE[banner.kind].icon}
          {banner.text}
        </div>
      )}

      <div className="p-4">
        <div
          className={`overflow-hidden rounded-xl border transition-all duration-500 ${
            flash
              ? "border-emerald-400/70 shadow-[0_0_0_1px_rgba(52,211,153,0.5),0_0_28px_rgba(52,211,153,0.35)]"
              : "border-[var(--hairline-strong)]"
          }`}
        >
          <div className="flex items-center gap-2 bg-[#0a0e14] px-3.5 py-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
            <span className="flex-1 truncate text-center font-mono text-[11px] text-muted/70">
              kubectl get pods -n {clusterState?.namespace || "production"} -o wide
            </span>
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  live ? "animate-blink bg-emerald-400 shadow-[0_0_6px_#34d399]" : "bg-danger"
                }`}
              />
              {clusterState ? (live ? "live" : "stale") : "connecting"}
            </span>
          </div>
          <div className="thin-scroll h-[260px] overflow-y-auto whitespace-pre bg-[#0a0e14] px-4 py-3.5 font-mono text-[12px] leading-relaxed text-[#7ee787]">
            {clusterState ? (
              clusterState.output.split("\n").map((line, i) => highlightLine(line, i))
            ) : (
              <>
                <div className="text-muted">Waiting for cluster data…</div>
                <div className="text-muted">
                  Set EXECUTION_MODE=shadow or live with a reachable cluster to stream kubectl
                  output here.
                </div>
              </>
            )}
            <span className="ml-0.5 inline-block h-[13px] w-[7px] animate-blink bg-[#7ee787] align-text-bottom" />
          </div>
          <div className="flex items-center justify-between bg-[#0a0e14] px-3.5 py-1.5 font-mono text-[10px] text-muted">
            <span>
              {clusterState
                ? `updated ${new Date(clusterState.timestamp).toLocaleTimeString("en-US", { hour12: false })}`
                : "never updated"}
            </span>
            <span>poll: {(pollIntervalMs / 1000).toFixed(1)}s</span>
          </div>
        </div>
      </div>
    </div>
  );
}
