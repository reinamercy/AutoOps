"use client";

import { useState } from "react";
import { FiHardDrive, FiSlash, FiTarget, FiTrendingUp } from "react-icons/fi";
import { TbBomb, TbCpu, TbDice6, TbPlugConnected } from "react-icons/tb";
import { toast } from "sonner";
import { triggerSimulation, ApiError } from "../lib/api";
import type { ScenarioId, SimulatePayload } from "../lib/types";

interface ScenarioDef {
  id: ScenarioId;
  name: string;
  icon: React.ReactNode;
  payload: SimulatePayload;
  theme: string;
}

// Each scenario gets its own semantic glass tint + glow color, so the
// trigger grid reads at a glance instead of everything looking identical.
// Every class below is a full literal string (not built from a template
// fragment) so Tailwind's static scanner picks all of them up.
const THEME = {
  orange:
    "border-orange-500/25 bg-orange-500/[0.06] text-orange-400 hover:border-orange-500/70 hover:bg-orange-500/[0.14] hover:text-orange-300 hover:shadow-[0_0_26px_rgba(249,115,22,0.35)]",
  amber:
    "border-amber-500/25 bg-amber-500/[0.06] text-amber-400 hover:border-amber-500/70 hover:bg-amber-500/[0.14] hover:text-amber-300 hover:shadow-[0_0_26px_rgba(245,158,11,0.35)]",
  red: "border-red-500/25 bg-red-500/[0.06] text-red-400 hover:border-red-500/70 hover:bg-red-500/[0.14] hover:text-red-300 hover:shadow-[0_0_26px_rgba(239,68,68,0.35)]",
  sky: "border-sky-500/25 bg-sky-500/[0.06] text-sky-400 hover:border-sky-500/70 hover:bg-sky-500/[0.14] hover:text-sky-300 hover:shadow-[0_0_26px_rgba(14,165,233,0.35)]",
  violet:
    "border-violet-500/25 bg-violet-500/[0.06] text-violet-400 hover:border-violet-500/70 hover:bg-violet-500/[0.14] hover:text-violet-300 hover:shadow-[0_0_26px_rgba(139,92,246,0.35)]",
  rose: "border-rose-500/25 bg-rose-500/[0.06] text-rose-400 hover:border-rose-500/70 hover:bg-rose-500/[0.14] hover:text-rose-300 hover:shadow-[0_0_26px_rgba(244,63,94,0.35)]",
  cyan: "border-cyan-neon/25 bg-cyan-neon/[0.06] text-cyan-neon hover:border-cyan-neon/70 hover:bg-cyan-neon/[0.14] hover:shadow-[0_0_26px_rgba(34,232,255,0.35)]",
};

const SCENARIOS: ScenarioDef[] = [
  {
    id: "oom_kill",
    name: "OOM Kill",
    icon: <TbBomb />,
    payload: { scenario: "oom_kill", eventCount: 30 },
    theme: THEME.orange,
  },
  {
    id: "high_error_rate",
    name: "Error Rate",
    icon: <FiTrendingUp />,
    payload: { scenario: "high_error_rate", eventCount: 30 },
    theme: THEME.amber,
  },
  {
    id: "cpu_spike",
    name: "CPU Spike",
    icon: <TbCpu />,
    // Exact payload requested: targets the demo deployment directly.
    payload: { scenario: "cpu_spike", targetService: "payment-api", eventCount: 30 },
    theme: THEME.red,
  },
  {
    id: "disk_full",
    name: "Disk Full",
    icon: <FiHardDrive />,
    payload: { scenario: "disk_full", eventCount: 30 },
    theme: THEME.sky,
  },
  {
    id: "connection_pool_exhaustion",
    name: "DB Pool",
    icon: <TbPlugConnected />,
    payload: { scenario: "connection_pool_exhaustion", eventCount: 30 },
    theme: THEME.violet,
  },
  {
    id: "service_down",
    name: "Service Down",
    icon: <FiSlash />,
    payload: { scenario: "service_down", eventCount: 30 },
    theme: THEME.rose,
  },
  {
    id: "random",
    name: "Random",
    icon: <TbDice6 />,
    payload: { scenario: "random", eventCount: 30 },
    theme: THEME.cyan,
  },
];

interface Props {
  pipelineRunning: boolean;
  onTriggered: (incidentId: string) => void;
}

export default function ScenarioTriggers({ pipelineRunning, onTriggered }: Props) {
  const [loadingId, setLoadingId] = useState<ScenarioId | null>(null);

  async function handleClick(def: ScenarioDef) {
    if (pipelineRunning) return;
    setLoadingId(def.id);
    try {
      const res = await triggerSimulation(def.payload);
      toast.success(`Pipeline started — ${res.incidentId}`, {
        description: `Scenario: ${def.payload.scenario}`,
      });
      onTriggered(res.incidentId);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Unexpected error triggering scenario";
      toast.error("Failed to trigger scenario", { description: message });
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <div className="glass mb-5 rounded-2xl">
      <div className="flex items-center justify-between border-b border-[var(--hairline)] px-5 py-3.5">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <FiTarget className="text-purple-neon" /> Trigger Incident Scenario
        </div>
        <div className="hidden text-[11px] text-muted sm:block">
          AI will autonomously detect, diagnose, plan, and execute a fix
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2.5 p-5 sm:grid-cols-4 lg:grid-cols-7">
        {SCENARIOS.map((s) => {
          const isLoading = loadingId === s.id;
          const disabled = pipelineRunning || loadingId !== null;
          return (
            <button
              key={s.id}
              disabled={disabled}
              onClick={() => handleClick(s)}
              className={`group relative flex flex-col items-center gap-2 overflow-hidden rounded-xl border px-3 py-4 transition-all duration-200 ${
                disabled ? "cursor-not-allowed opacity-40" : `hover:-translate-y-0.5 ${s.theme}`
              } ${disabled ? "border-[var(--hairline)] bg-[var(--overlay-soft)] text-muted" : ""}`}
            >
              {isLoading && (
                <span className="absolute inset-0 animate-pulse bg-gradient-to-r from-cyan-neon/10 via-purple-neon/10 to-cyan-neon/10" />
              )}
              <span className="relative text-2xl transition-colors">
                {isLoading ? (
                  <span className="block h-6 w-6 animate-spin rounded-full border-2 border-cyan-neon/30 border-t-cyan-neon" />
                ) : (
                  s.icon
                )}
              </span>
              <span className="relative text-center text-[10px] font-bold uppercase tracking-wide text-text">
                {s.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
