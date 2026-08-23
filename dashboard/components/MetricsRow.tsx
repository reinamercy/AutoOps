import { FiCheckCircle, FiClock, FiLayers, FiZap } from "react-icons/fi";
import type { MetricsPayload } from "../lib/types";

interface Props {
  metrics: MetricsPayload | null;
  activeCount: number;
}

function Card({
  icon,
  label,
  value,
  sub,
  accent,
  tint,
  border,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  accent: string;
  tint: string;
  border: string;
}) {
  return (
    <div
      className={`glass group relative overflow-hidden rounded-2xl border p-5 transition-all hover:-translate-y-0.5 ${tint} ${border}`}
    >
      <div
        className={`absolute -right-6 -top-6 h-24 w-24 rounded-full opacity-25 blur-2xl transition-opacity group-hover:opacity-40 ${accent}`}
      />
      <div className="relative flex items-center justify-between">
        <span className="text-2xl font-bold tabular-nums tracking-tight">{value}</span>
        <span className="text-muted/70">{icon}</span>
      </div>
      <div className="relative mt-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className="relative mt-0.5 text-[11px] text-muted/70">{sub}</div>
    </div>
  );
}

export default function MetricsRow({ metrics, activeCount }: Props) {
  const total = metrics?.incidentsTotal ?? 0;
  const resolved = metrics?.incidentsResolved ?? 0;
  const rate = metrics?.autoResolutionRate ?? 0;
  const mttr = metrics?.avgMttrSeconds ?? 0;

  return (
    <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card
        icon={<FiLayers size={20} />}
        label="Total Incidents"
        value={total ? String(total) : "—"}
        sub={resolved > 0 ? `${resolved} auto-resolved` : "no data yet"}
        accent="bg-blue-500"
        tint="bg-gradient-to-br from-blue-500/[0.12] to-transparent"
        border="border-blue-500/20"
      />
      <Card
        icon={<FiCheckCircle size={20} />}
        label="Auto-Resolution Rate"
        value={total > 0 ? `${(rate * 100).toFixed(0)}%` : "—"}
        sub={`${resolved} of ${total} incidents`}
        accent="bg-emerald-400"
        tint="bg-gradient-to-br from-emerald-400/[0.12] to-transparent"
        border="border-emerald-400/20"
      />
      <Card
        icon={<FiClock size={20} />}
        label="Avg MTTR"
        value={mttr > 0 ? `${mttr}s` : "—"}
        sub="mean time to resolution"
        accent="bg-purple-neon"
        tint="bg-gradient-to-br from-purple-neon/[0.12] to-transparent"
        border="border-purple-neon/20"
      />
      <Card
        icon={<FiZap size={20} />}
        label="Active Pipelines"
        value={String(activeCount)}
        sub={activeCount > 0 ? "running" : "idle"}
        accent="bg-amber-400"
        tint="bg-gradient-to-br from-amber-400/[0.12] to-transparent"
        border="border-amber-400/20"
      />
    </div>
  );
}
