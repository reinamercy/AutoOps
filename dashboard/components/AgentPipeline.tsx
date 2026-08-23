import {
  FiBookOpen,
  FiCrosshair,
  FiEye,
  FiFileText,
  FiClock,
  FiSliders,
  FiSettings,
  FiZap,
} from "react-icons/fi";
import type { AgentName } from "../lib/types";
import { AGENT_ORDER, type AgentState } from "../hooks/useDashboardSocket";

const AGENT_META: Record<AgentName, { label: string; desc: string; icon: React.ReactNode }> = {
  monitoring: { label: "Monitoring", desc: "Anomaly Detection", icon: <FiEye /> },
  rca: { label: "RCA", desc: "Root Cause Analysis", icon: <FiCrosshair /> },
  planning: { label: "Planning", desc: "Remediation Plan", icon: <FiFileText /> },
  sla: { label: "SLA", desc: "Priority & SLA", icon: <FiClock /> },
  decision: { label: "Decision", desc: "Risk Assessment", icon: <FiSliders /> },
  execution: { label: "Execution", desc: "Fix Execution", icon: <FiSettings /> },
  feedback: { label: "Feedback", desc: "Learn & Audit", icon: <FiBookOpen /> },
};

// Each agent gets a fixed domain color (not the old alternating cyan/purple)
// so its role is recognizable at a glance. Every class string below is a
// full literal (not built from a template fragment) so Tailwind's static
// scanner picks all of them up — colors built via `${color}-500` fragments
// silently don't get generated.
interface AgentTheme {
  idleRing: string;
  activeRing: string;
  idleBg: string;
  hoverRing: string;
  hoverShadow: string;
  icon: string;
  pill: string;
  glowRgb: string; // space-separated "R G B", feeds --glow-rgb for the active pulse
}

const AGENT_THEME: Record<AgentName, AgentTheme> = {
  monitoring: {
    idleRing: "ring-1 ring-cyan-neon/25",
    activeRing: "ring-2 ring-cyan-neon/80",
    idleBg: "bg-cyan-neon/[0.05]",
    hoverRing: "hover:ring-cyan-neon/60",
    hoverShadow: "hover:shadow-[0_0_22px_rgba(34,232,255,0.3)]",
    icon: "text-cyan-neon",
    pill: "bg-cyan-neon/25 text-cyan-neon border-cyan-neon/70 shadow-[0_0_10px_rgba(34,232,255,0.35)]",
    glowRgb: "34 232 255",
  },
  rca: {
    idleRing: "ring-1 ring-indigo-500/25",
    activeRing: "ring-2 ring-indigo-500/80",
    idleBg: "bg-indigo-500/[0.05]",
    hoverRing: "hover:ring-indigo-500/60",
    hoverShadow: "hover:shadow-[0_0_22px_rgba(99,102,241,0.3)]",
    icon: "text-indigo-400",
    pill: "bg-indigo-500/25 text-indigo-300 border-indigo-500/70 shadow-[0_0_10px_rgba(99,102,241,0.35)]",
    glowRgb: "99 102 241",
  },
  planning: {
    idleRing: "ring-1 ring-blue-500/25",
    activeRing: "ring-2 ring-blue-500/80",
    idleBg: "bg-blue-500/[0.05]",
    hoverRing: "hover:ring-blue-500/60",
    hoverShadow: "hover:shadow-[0_0_22px_rgba(59,130,246,0.3)]",
    icon: "text-blue-400",
    pill: "bg-blue-500/25 text-blue-300 border-blue-500/70 shadow-[0_0_10px_rgba(59,130,246,0.35)]",
    glowRgb: "59 130 246",
  },
  sla: {
    idleRing: "ring-1 ring-amber-500/25",
    activeRing: "ring-2 ring-amber-500/80",
    idleBg: "bg-amber-500/[0.05]",
    hoverRing: "hover:ring-amber-500/60",
    hoverShadow: "hover:shadow-[0_0_22px_rgba(245,158,11,0.3)]",
    icon: "text-amber-400",
    pill: "bg-amber-500/25 text-amber-300 border-amber-500/70 shadow-[0_0_10px_rgba(245,158,11,0.35)]",
    glowRgb: "245 158 11",
  },
  decision: {
    idleRing: "ring-1 ring-rose-500/25",
    activeRing: "ring-2 ring-rose-500/80",
    idleBg: "bg-rose-500/[0.05]",
    hoverRing: "hover:ring-rose-500/60",
    hoverShadow: "hover:shadow-[0_0_22px_rgba(244,63,94,0.3)]",
    icon: "text-rose-400",
    pill: "bg-rose-500/25 text-rose-300 border-rose-500/70 shadow-[0_0_10px_rgba(244,63,94,0.35)]",
    glowRgb: "244 63 94",
  },
  execution: {
    idleRing: "ring-1 ring-emerald-500/25",
    activeRing: "ring-2 ring-emerald-500/80",
    idleBg: "bg-emerald-500/[0.05]",
    hoverRing: "hover:ring-emerald-500/60",
    hoverShadow: "hover:shadow-[0_0_22px_rgba(16,185,129,0.3)]",
    icon: "text-emerald-400",
    pill: "bg-emerald-500/25 text-emerald-300 border-emerald-500/70 shadow-[0_0_10px_rgba(16,185,129,0.35)]",
    glowRgb: "16 185 129",
  },
  feedback: {
    idleRing: "ring-1 ring-slate-400/25",
    activeRing: "ring-2 ring-slate-400/80",
    idleBg: "bg-slate-400/[0.05]",
    hoverRing: "hover:ring-slate-400/60",
    hoverShadow: "hover:shadow-[0_0_22px_rgba(100,116,139,0.3)]",
    icon: "text-slate-400",
    pill: "bg-slate-400/25 text-slate-300 border-slate-400/70 shadow-[0_0_10px_rgba(100,116,139,0.3)]",
    glowRgb: "100 116 139",
  },
};

function summarize(agent: AgentName, data?: Record<string, unknown>): string {
  if (!data) return "";
  switch (agent) {
    case "monitoring":
      return data.type ? `${data.type} · score ${Number(data.score).toFixed(2)}` : "";
    case "rca":
      return data.category ? String(data.category).replace(/_/g, " ") : "";
    case "planning":
      return data.source ? `${data.title || ""} (${data.source})` : "";
    case "sla":
      return data.priority ? String(data.priority) : "";
    case "decision":
      return data.riskTier ? `${data.riskTier} · ${data.riskScore}/100` : "";
    case "execution":
      return typeof data.stepsCompleted === "number" ? `${data.stepsCompleted} step(s) ok` : "";
    case "feedback":
      return data.outcome ? String(data.outcome) : "";
    default:
      return "";
  }
}

function NodeCard({ agent, state }: { agent: AgentName; state: AgentState }) {
  const meta = AGENT_META[agent];
  const theme = AGENT_THEME[agent];

  // Domain color owns idle + active (that's "this agent's identity");
  // done/error stay universal success/failure signals so a failure never
  // gets visually camouflaged by whatever color the agent happens to be.
  const ring =
    state.status === "active"
      ? theme.activeRing
      : state.status === "done"
        ? "ring-1 ring-emerald-400/50"
        : state.status === "error"
          ? "ring-2 ring-danger/80"
          : theme.idleRing;

  const bgTint =
    state.status === "active"
      ? theme.idleBg
      : state.status === "done"
        ? "bg-emerald-400/[0.05]"
        : state.status === "error"
          ? "bg-danger/[0.07]"
          : theme.idleBg;

  const iconColor =
    state.status === "active"
      ? theme.icon
      : state.status === "done"
        ? "text-emerald-400"
        : state.status === "error"
          ? "text-danger"
          : `${theme.icon} opacity-60`;

  const statusLabel =
    state.status === "active"
      ? "Running"
      : state.status === "done"
        ? `Done${state.durationMs !== undefined ? ` · ${state.durationMs}ms` : ""}`
        : state.status === "error"
          ? "Error"
          : "Idle";

  const statusPill =
    state.status === "active"
      ? theme.pill
      : state.status === "done"
        ? "bg-emerald-400/25 text-emerald-300 border-emerald-400/60"
        : state.status === "error"
          ? "bg-danger/25 text-danger border-danger/70 shadow-[0_0_10px_rgba(248,81,73,0.35)]"
          : "border-border text-muted";

  return (
    <div
      style={state.status === "active" ? ({ "--glow-rgb": theme.glowRgb } as React.CSSProperties) : undefined}
      className={`glass relative flex w-[128px] shrink-0 flex-col items-center rounded-2xl px-3 py-4 transition-all duration-300 ${ring} ${bgTint} ${theme.hoverRing} ${theme.hoverShadow} ${
        state.status === "active" ? "animate-glow-dynamic animate-breathe" : ""
      } ${state.status === "error" ? "animate-pulse-glow-red" : ""}`}
    >
      <span className={`mb-2 text-2xl transition-colors ${iconColor}`}>{meta.icon}</span>
      <span className="text-[11px] font-bold uppercase tracking-wide text-text">{meta.label}</span>
      <span className="mt-0.5 text-center text-[9px] text-muted/70">{meta.desc}</span>
      <span
        className={`mt-2 rounded-full border px-2 py-0.5 text-[9px] font-semibold ${statusPill}`}
      >
        {statusLabel}
      </span>
      {state.data && summarize(agent, state.data) && (
        <span className="mt-1.5 line-clamp-2 text-center text-[9px] leading-tight text-muted/80">
          {summarize(agent, state.data)}
        </span>
      )}
    </div>
  );
}

function Connector({ state }: { state: "idle" | "active" | "done" }) {
  return (
    <div className="relative mx-1 w-8 shrink-0 self-center">
      <div className="trail-track">
        <div className={`trail-fill ${state === "idle" ? "" : state}`}>
          {state === "active" && <div className="trail-comet" />}
        </div>
      </div>
    </div>
  );
}

interface Props {
  agents: Record<AgentName, AgentState>;
  statusLabel: string;
}

export default function AgentPipeline({ agents, statusLabel }: Props) {
  return (
    <div className="glass mb-5 rounded-2xl">
      <div className="flex items-center justify-between border-b border-[var(--hairline)] px-5 py-3.5">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <FiZap className="text-cyan-neon" /> AI Agent Pipeline
        </div>
        <div className="text-[11px] text-muted">{statusLabel}</div>
      </div>
      <div className="thin-scroll overflow-x-auto px-5 py-5">
        <div className="flex w-full items-stretch justify-center">
          {AGENT_ORDER.map((agent, i) => {
            const connectorState =
              agents[agent].status === "active"
                ? "active"
                : agents[agent].status === "done"
                  ? "done"
                  : "idle";
            return (
              <div key={agent} className="flex items-center">
                <NodeCard agent={agent} state={agents[agent]} />
                {i < AGENT_ORDER.length - 1 && <Connector state={connectorState} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
