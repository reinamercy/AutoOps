import {
  FiAlertTriangle,
  FiCheckCircle,
  FiShield,
  FiTarget,
  FiTrendingUp,
  FiXCircle,
} from "react-icons/fi";
import type { ExecutionStepEvent, IncidentState } from "../lib/types";
import type { AgentState } from "../hooks/useDashboardSocket";

interface Props {
  incidentId: string | null;
  incident: IncidentState | null;
  execSteps: Record<number, ExecutionStepEvent>;
  agents: Record<string, AgentState>;
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-danger/25 text-danger border-danger/70 shadow-[0_0_14px_rgba(248,81,73,0.3)]",
  high: "bg-amber-500/25 text-amber-300 border-amber-500/70 shadow-[0_0_14px_rgba(245,158,11,0.25)]",
  medium: "bg-cyan-neon/25 text-cyan-neon border-cyan-neon/70 shadow-[0_0_14px_rgba(34,232,255,0.25)]",
  low: "bg-emerald-400/25 text-emerald-300 border-emerald-400/70 shadow-[0_0_14px_rgba(52,211,153,0.25)]",
  info: "bg-muted/20 text-muted border-muted/50",
};

const OUTCOME_ICON: Record<string, React.ReactNode> = {
  resolved: <FiCheckCircle />,
  partial: <FiAlertTriangle />,
  failed: <FiXCircle />,
  escalated: <FiAlertTriangle />,
};

const OUTCOME_STYLE: Record<string, string> = {
  resolved: "bg-emerald-400/25 text-emerald-300 border-emerald-400/70 shadow-[0_0_14px_rgba(52,211,153,0.3)]",
  partial: "bg-amber-500/25 text-amber-300 border-amber-500/70 shadow-[0_0_14px_rgba(245,158,11,0.25)]",
  failed: "bg-danger/25 text-danger border-danger/70 shadow-[0_0_14px_rgba(248,81,73,0.3)]",
  escalated: "bg-purple-neon/25 text-purple-neon border-purple-neon/70 shadow-[0_0_14px_rgba(176,107,255,0.3)]",
};

function riskColor(score: number) {
  if (score < 35)
    return { bar: "bg-emerald-400", text: "text-emerald-300", pill: "bg-emerald-400/25 border-emerald-400/70" };
  if (score < 65)
    return { bar: "bg-amber-400", text: "text-amber-300", pill: "bg-amber-400/25 border-amber-400/70" };
  return { bar: "bg-danger", text: "text-danger", pill: "bg-danger/25 border-danger/70" };
}

export default function ActiveIncidentPanel({ incidentId, incident, execSteps, agents }: Props) {
  if (!incidentId) {
    return (
      <div className="glass flex h-full min-h-[420px] flex-col items-center justify-center rounded-2xl p-8 text-center">
        <FiShield size={34} className="mb-3 text-muted/40" />
        <p className="text-sm text-muted">No active incident detected.</p>
        <p className="mt-1.5 text-xs text-muted/60">
          Click a scenario below to start the AI pipeline.
        </p>
      </div>
    );
  }

  if (!incident) {
    return (
      <div className="glass flex h-full min-h-[420px] flex-col items-center justify-center rounded-2xl p-8">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-cyan-neon/30 border-t-cyan-neon" />
        <p className="mt-3 text-sm text-muted">Pipeline starting…</p>
      </div>
    );
  }

  const { issue, rootCause, plan, riskAssessment, decisionResult, outcome, workflowStatus, priority } =
    incident;

  return (
    <div className="glass thin-scroll flex h-full min-h-[420px] flex-col overflow-y-auto rounded-2xl p-5">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-[11px] text-muted">{incident.incidentId}</div>
          <div className="text-lg font-bold capitalize">
            {issue ? issue.type.replace(/_/g, " ") : "Analyzing…"}
          </div>
          {issue && (
            <div className="mt-0.5 text-xs text-muted">
              {incident.rawEvents?.[0]?.source?.service || "—"} ·{" "}
              {incident.rawEvents?.[0]?.source?.namespace || "production"}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {issue && (
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${SEVERITY_STYLE[issue.severity] || SEVERITY_STYLE.info}`}
            >
              {issue.severity}
            </span>
          )}
          {priority && (
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-bold text-muted">
              {priority}
            </span>
          )}
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${
              outcome ? OUTCOME_STYLE[outcome] || OUTCOME_STYLE.failed : "border-cyan-neon/40 bg-cyan-neon/10 text-cyan-neon"
            }`}
          >
            {outcome || workflowStatus}
          </span>
        </div>
      </div>

      {/* Anomaly + RCA reasoning */}
      {issue && (
        <div className="mb-4 grid grid-cols-2 gap-2.5 animate-fade-in-up">
          <Stat label="Anomaly Score" value={issue.anomalyScore.toFixed(4)} />
          <Stat label="Affected Service" value={issue.affectedService} mono />
          {rootCause && <Stat label="Root Cause" value={rootCause.category.replace(/_/g, " ")} />}
          {rootCause && <Stat label="RCA Confidence" value={`${(rootCause.confidence * 100).toFixed(0)}%`} />}
        </div>
      )}

      {rootCause && (
        <Section icon={<FiTarget />} title="RCA Reasoning" className="animate-fade-in-up">
          <p className="text-[12px] leading-relaxed text-text/90">{rootCause.description}</p>
          {rootCause.evidence && rootCause.evidence.length > 0 && (
            <ul className="mt-2 space-y-1">
              {rootCause.evidence.map((e, i) => (
                <li key={i} className="flex gap-2 text-[11px] text-muted">
                  <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-cyan-neon/70" />
                  {e}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {plan && (
        <Section
          icon={<FiTrendingUp />}
          title={`Planning Steps — ${plan.title}`}
          badge={incident.planSource}
          className="animate-fade-in-up"
        >
          <ol className="space-y-2">
            {plan.steps.map((step) => {
              const result = execSteps[step.stepId];
              return (
                <li
                  key={step.stepId}
                  className="rounded-lg border border-[var(--hairline)] bg-[var(--overlay-soft)] p-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] font-semibold text-cyan-neon">
                      {step.stepId}. {step.action}
                    </span>
                    {result && (
                      <span
                        className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                          result.status === "success"
                            ? "border-emerald-400/60 bg-emerald-400/25 text-emerald-300"
                            : result.status === "failed"
                              ? "border-danger/60 bg-danger/25 text-danger"
                              : "border-cyan-neon/60 bg-cyan-neon/25 text-cyan-neon"
                        }`}
                      >
                        {result.status}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-muted">{step.description}</div>
                  {step.parameters && Object.keys(step.parameters).length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {Object.entries(step.parameters).map(([k, v]) => (
                        <span
                          key={k}
                          className="rounded border border-border bg-surface2 px-1.5 py-0.5 font-mono text-[9px] text-muted"
                        >
                          {k}={String(v)}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </Section>
      )}

      {riskAssessment && (
        <Section icon={<FiAlertTriangle />} title="Risk Score" className="animate-fade-in-up">
          <div className="flex items-center justify-between">
            <span className="text-2xl font-bold tabular-nums">
              {riskAssessment.score}
              <span className="text-sm text-muted">/100</span>
            </span>
            <span
              className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase ${riskColor(riskAssessment.score).text} ${riskColor(riskAssessment.score).pill}`}
            >
              {riskAssessment.tier}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--overlay-soft)]">
            <div
              className={`h-full rounded-full transition-all duration-700 ${riskColor(riskAssessment.score).bar}`}
              style={{ width: `${riskAssessment.score}%` }}
            />
          </div>
          {decisionResult && (
            <p className="mt-2 text-[11px] text-muted">
              <span className="font-semibold text-text/80">{decisionResult.action}</span> —{" "}
              {decisionResult.reason}
            </p>
          )}
          {riskAssessment.reasons && riskAssessment.reasons.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {riskAssessment.reasons.map((r, i) => (
                <li key={i} className="text-[10px] text-muted/80">
                  · {r}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {outcome && (
        <div
          className={`mt-2 rounded-xl border p-4 text-center animate-fade-in-up ${OUTCOME_STYLE[outcome] || OUTCOME_STYLE.failed}`}
        >
          <div className="flex items-center justify-center gap-2 text-lg font-bold uppercase tracking-wide">
            {OUTCOME_ICON[outcome] || OUTCOME_ICON.failed} {outcome}
          </div>
          <div className="mt-1 text-[11px] text-muted">
            {(
              (new Date(incident.updatedAt).getTime() - new Date(incident.createdAt).getTime()) /
              1000
            ).toFixed(1)}
            s
            {incident.retryCount > 0 ? ` · ${incident.retryCount} retry(s)` : ""} ·{" "}
            {incident.stepsCompleted.length} steps completed
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--hairline)] bg-[var(--overlay-soft)] p-2.5">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-0.5 text-[13px] font-medium ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function Section({
  icon,
  title,
  badge,
  children,
  className = "",
}: {
  icon: React.ReactNode;
  title: string;
  badge?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-4 ${className}`}>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <span className="text-cyan-neon">{icon}</span>
        {title}
        {badge && (
          <span className="ml-auto rounded-full border border-border px-1.5 py-0.5 text-[9px] font-bold uppercase text-muted">
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
