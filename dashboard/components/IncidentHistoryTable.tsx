"use client";

import { useEffect, useState, useCallback } from "react";
import { FiClipboard, FiRefreshCw } from "react-icons/fi";
import { fetchIncidents } from "../lib/api";

// The backend returns two different shapes depending on whether Postgres is
// reachable: a nested camelCase IncidentState from the in-memory fallback, or
// a flat snake_case row once it's DB-backed (see src/api/server.ts's
// GET /api/incidents). Every field below is read with both spellings, same
// as the previous vanilla dashboard did.
interface Row {
  id?: string;
  incidentId?: string;
  createdAt?: string;
  created_at?: string;
  issue?: { type?: string; severity?: string; affectedService?: string };
  severity?: string;
  rootCauseCategory?: string;
  root_cause_category?: string;
  rootCauseService?: string;
  root_cause_service?: string;
  priority?: string;
  outcome?: string;
  durationSeconds?: number;
  duration_seconds?: number;
}

const OUTCOME_DOT: Record<string, string> = {
  resolved: "bg-emerald-400",
  failed: "bg-danger",
  escalated: "bg-purple-neon",
  partial: "bg-amber-400",
};

export default function IncidentHistoryTable({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchIncidents(20);
      setRows((data.incidents as Row[]) || []);
    } catch {
      // keep last known rows on failure — non-critical panel
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <div className="glass rounded-2xl">
      <div className="flex items-center justify-between border-b border-[var(--hairline)] px-5 py-3.5">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <FiClipboard className="text-cyan-neon" /> Incident History
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 rounded-md border border-border bg-surface2 px-2 py-1 text-[10px] text-muted transition-colors hover:text-text"
        >
          <FiRefreshCw className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>
      <div className="thin-scroll overflow-x-auto">
        <table className="w-full text-left text-[11px]">
          <thead>
            <tr className="border-b border-[var(--hairline)] text-muted">
              {["ID", "Started", "Type", "Service", "Severity", "Priority", "Outcome"].map((h) => (
                <th key={h} className="px-4 py-2.5 font-semibold uppercase tracking-wide">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted/60">
                  {loading ? "Loading incidents…" : "No incidents yet."}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const incId = r.incidentId || r.id || "—";
                const created = r.createdAt || r.created_at;
                const type = r.issue?.type || r.rootCauseCategory || r.root_cause_category;
                const service = r.issue?.affectedService || r.rootCauseService || r.root_cause_service;
                const severity = r.issue?.severity || r.severity;
                const outcome = r.outcome;
                return (
                  <tr key={incId} className="border-b border-[var(--hairline)] hover:bg-[var(--overlay-soft)]">
                    <td className="px-4 py-2 font-mono text-cyan-neon">{incId}</td>
                    <td className="px-4 py-2 text-muted">
                      {created
                        ? new Date(created).toLocaleTimeString("en-US", { hour12: false })
                        : "—"}
                    </td>
                    <td className="px-4 py-2 capitalize">{type?.replace(/_/g, " ") || "—"}</td>
                    <td className="px-4 py-2 font-mono">{service || "—"}</td>
                    <td className="px-4 py-2 capitalize">{severity || "—"}</td>
                    <td className="px-4 py-2">{r.priority || "—"}</td>
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${OUTCOME_DOT[outcome || ""] || "bg-muted"}`}
                        />
                        {outcome || "running"}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
