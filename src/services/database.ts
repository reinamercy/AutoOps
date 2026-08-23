/**
 * Database Service — real PostgreSQL when reachable, in-memory fallback otherwise.
 * On initDatabase(), attempts a real connection + runs migrations; on failure,
 * falls back to an in-memory store so the pipeline keeps working without Docker.
 */
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { createChildLogger } from "../utils/logger";
import { IncidentState } from "../orchestrator/state";
import { config } from "../config";

const log = createChildLogger("Database");

// ── In-memory tables (fallback) ──────────────────────────────────
const incidentsStore = new Map<string, any>();
const incidentEventsStore: any[] = [];
const storedFixesStore = new Map<string, any>();
const approvalsStore = new Map<string, any>();

// ── Fake Pool used by services that call getPool().query() ────────

class InMemoryPool {
    async query(sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
        const s = sql.trim().replace(/\s+/g, " ");

        if (/stored_fixes/i.test(s)) return this.storedFixes(s, params);
        if (/approvals/i.test(s)) return this.approvals(s, params);

        // decision_audit and risk_assessments are audit-only — accept and discard
        if (/INSERT/i.test(s)) return { rows: [], rowCount: 1 };

        // DDL (CREATE TABLE / CREATE INDEX) — no-op
        return { rows: [], rowCount: 0 };
    }

    private storedFixes(s: string, params: any[]): { rows: any[]; rowCount: number } {
        if (/^INSERT/i.test(s)) {
            storedFixesStore.set(params[0], {
                id: params[0],
                incident_type: params[1],
                error_signature: params[2],
                fix_steps: params[3],
                rl_score: params[4] ?? 0.5,
                success_count: params[5] ?? 0,
                failure_count: params[6] ?? 0,
                last_used_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
            });
            return { rows: [], rowCount: 1 };
        }

        if (/WHERE id = ANY/i.test(s)) {
            const ids: string[] = params[0] || [];
            const rows = ids.map((id) => storedFixesStore.get(id)).filter(Boolean);
            return { rows, rowCount: rows.length };
        }

        if (/^SELECT.*FROM stored_fixes WHERE id/i.test(s)) {
            const fix = storedFixesStore.get(params[0]);
            return { rows: fix ? [fix] : [], rowCount: fix ? 1 : 0 };
        }

        if (/^UPDATE stored_fixes/i.test(s)) {
            const fix = storedFixesStore.get(params[3]);
            if (fix) {
                fix.rl_score = params[0];
                fix.success_count = (fix.success_count || 0) + (params[1] || 0);
                fix.failure_count = (fix.failure_count || 0) + (params[2] || 0);
                fix.last_used_at = new Date().toISOString();
            }
            return { rows: [], rowCount: fix ? 1 : 0 };
        }

        return { rows: [], rowCount: 0 };
    }

    private approvals(s: string, params: any[]): { rows: any[]; rowCount: number } {
        // INSERT
        if (/^INSERT INTO approvals/i.test(s)) {
            const id = uuidv4();
            approvalsStore.set(id, {
                id,
                incident_ids: params[0] || [],
                service_name: params[1],
                namespace: params[2],
                fix_id: params[3],
                risk_score: params[4],
                risk_tier: params[5],
                plan_summary: params[6],
                status: "PENDING",
                approver_id: null,
                approver_comment: null,
                created_at: new Date().toISOString(),
                decided_at: null,
            });
            return { rows: [{ id }], rowCount: 1 };
        }

        // Group-check: find pending approval for same service+namespace in window
        if (/WHERE service_name/i.test(s)) {
            const cutoff = new Date(Date.now() - parseInt(params[2] || "300000"));
            const rows = Array.from(approvalsStore.values())
                .filter(
                    (a) =>
                        a.service_name === params[0] &&
                        a.namespace === params[1] &&
                        a.status === "PENDING" &&
                        new Date(a.created_at) > cutoff
                )
                .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                .slice(0, 1);
            return { rows, rowCount: rows.length };
        }

        // UPDATE incident_ids (grouping)
        if (/SET incident_ids/i.test(s)) {
            const a = approvalsStore.get(params[1]);
            if (a) a.incident_ids = params[0];
            return { rows: [], rowCount: a ? 1 : 0 };
        }

        // SELECT status only
        if (/^SELECT status FROM approvals WHERE id/i.test(s)) {
            const a = approvalsStore.get(params[0]);
            return { rows: a ? [{ status: a.status }] : [], rowCount: a ? 1 : 0 };
        }

        // UPDATE with timeout literal
        if (/SET status = 'TIMEOUT'/i.test(s)) {
            const a = approvalsStore.get(params[0]);
            if (a) { a.status = "TIMEOUT"; a.decided_at = new Date().toISOString(); }
            return { rows: [], rowCount: a ? 1 : 0 };
        }

        // UPDATE status + approver (from router and approval service)
        if (/SET status.*approver_id/i.test(s)) {
            const a = approvalsStore.get(params[3]);
            if (a) {
                a.status = params[0];
                a.approver_id = params[1];
                a.approver_comment = params[2];
                a.decided_at = new Date().toISOString();
            }
            return { rows: [], rowCount: a ? 1 : 0 };
        }

        // SELECT * / single row by id
        if (/WHERE id = \$1/i.test(s)) {
            const a = approvalsStore.get(params[0]);
            return { rows: a ? [a] : [], rowCount: a ? 1 : 0 };
        }

        // List (optional status filter + LIMIT/OFFSET)
        if (/^SELECT.*FROM approvals/i.test(s)) {
            let rows = Array.from(approvalsStore.values());
            const hasStatusFilter = /WHERE status/i.test(s);
            let limit: number, offset: number;

            if (hasStatusFilter) {
                rows = rows.filter((a) => a.status === params[0]);
                limit = (params[1] as number) ?? 20;
                offset = (params[2] as number) ?? 0;
            } else {
                limit = (params[0] as number) ?? 20;
                offset = (params[1] as number) ?? 0;
            }

            rows = rows
                .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                .slice(offset, offset + limit);
            return { rows, rowCount: rows.length };
        }

        return { rows: [], rowCount: 0 };
    }

    async end(): Promise<void> {}
}

// ── Active pool (real Postgres when reachable, in-memory fallback otherwise) ──

let pool: Pool | InMemoryPool = new InMemoryPool();
let usingRealDb = false;

export function getPool(): any {
    return pool;
}

/** Whether the active pool is a real PostgreSQL connection. Used by /api/debug/stores. */
export function isRealDatabase(): boolean {
    return usingRealDb;
}

export async function initDatabase(): Promise<void> {
    const realPool = new Pool({
        host: config.postgres.host,
        port: config.postgres.port,
        database: config.postgres.database,
        user: config.postgres.user,
        password: config.postgres.password,
        connectionTimeoutMillis: 3000,
        max: 10,
    });
    // Pool-level errors on idle clients shouldn't crash the process — just log.
    realPool.on("error", (err) => log.warn({ err: err.message }, "PostgreSQL pool error"));

    try {
        await realPool.query("SELECT 1");

        const migrationsDir = path.join(process.cwd(), "src", "db", "migrations");
        const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
        for (const file of files) {
            const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
            await realPool.query(sql);
        }

        pool = realPool;
        usingRealDb = true;
        log.info(
            { host: config.postgres.host, database: config.postgres.database, migrations: files.length },
            "✅ PostgreSQL connected — running migrations applied"
        );
    } catch (err: unknown) {
        const error = err as Error;
        await realPool.end().catch(() => {});
        pool = new InMemoryPool();
        usingRealDb = false;
        log.warn({ error: error.message }, "⚠️ PostgreSQL unreachable — falling back to in-memory database");
    }
}

export async function saveIncident(state: IncidentState): Promise<void> {
    const duration = state.outcome
        ? Math.round((new Date().getTime() - new Date(state.createdAt).getTime()) / 1000)
        : null;

    const record = {
        id: state.incidentId,
        created_at: state.createdAt,
        resolved_at: state.outcome ? new Date().toISOString() : null,
        severity: state.issue?.severity || null,
        root_cause_category: state.rootCause?.category || null,
        root_cause_service: state.rootCause?.service || null,
        root_cause_description: state.rootCause?.description || null,
        root_cause_confidence: state.rootCause?.confidence || null,
        plan_title: state.plan?.title || null,
        plan_steps: state.plan?.steps || [],
        priority: state.priority,
        execution_status: state.executionStatus,
        outcome: state.outcome,
        duration_seconds: duration,
        retry_count: state.retryCount,
        lessons_learned: state.lessonsLearned,
        full_state: state,
    };

    if (usingRealDb) {
        await (pool as Pool).query(
            `INSERT INTO incidents
                (id, created_at, resolved_at, severity, root_cause_category, root_cause_service,
                 root_cause_description, root_cause_confidence, plan_title, plan_steps, priority,
                 execution_status, outcome, duration_seconds, retry_count, lessons_learned, full_state, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
             ON CONFLICT (id) DO UPDATE SET
                resolved_at = $3, severity = $4, root_cause_category = $5, root_cause_service = $6,
                root_cause_description = $7, root_cause_confidence = $8, plan_title = $9, plan_steps = $10,
                priority = $11, execution_status = $12, outcome = $13, duration_seconds = $14,
                retry_count = $15, lessons_learned = $16, full_state = $17, updated_at = NOW()`,
            [
                record.id, record.created_at, record.resolved_at, record.severity, record.root_cause_category,
                record.root_cause_service, record.root_cause_description, record.root_cause_confidence,
                record.plan_title, JSON.stringify(record.plan_steps), record.priority, record.execution_status,
                record.outcome, record.duration_seconds, record.retry_count, record.lessons_learned,
                JSON.stringify(record.full_state),
            ]
        );
        log.info({ incidentId: state.incidentId }, "Incident saved to PostgreSQL");
        return;
    }

    incidentsStore.set(state.incidentId, { ...record, updated_at: new Date().toISOString() });
    log.info({ incidentId: state.incidentId }, "Incident saved to in-memory store");
}

export async function logAgentEvent(
    incidentId: string,
    agent: string,
    eventType: string,
    data: any
): Promise<void> {
    if (usingRealDb) {
        await (pool as Pool).query(
            `INSERT INTO incident_events (incident_id, agent, event_type, data) VALUES ($1, $2, $3, $4)`,
            [incidentId, agent, eventType, JSON.stringify(data)]
        );
        return;
    }

    incidentEventsStore.push({
        id: incidentEventsStore.length + 1,
        incident_id: incidentId,
        agent,
        event_type: eventType,
        data,
        created_at: new Date().toISOString(),
    });
}

export async function getIncident(id: string): Promise<any | null> {
    if (usingRealDb) {
        const result = await (pool as Pool).query("SELECT * FROM incidents WHERE id = $1", [id]);
        return result.rows[0] || null;
    }
    return incidentsStore.get(id) || null;
}

export async function listIncidents(
    limit: number = 20,
    offset: number = 0
): Promise<{ incidents: any[]; total: number }> {
    if (usingRealDb) {
        const [rows, countRes] = await Promise.all([
            (pool as Pool).query(
                `SELECT id, id AS "incidentId", created_at, severity, root_cause_category, root_cause_service,
                        priority, execution_status,
                        COALESCE(full_state->'decisionResult'->>'action', execution_status, '—') AS decision_action,
                        outcome, duration_seconds
                 FROM incidents ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
                [limit, offset]
            ),
            (pool as Pool).query("SELECT count(*)::int AS total FROM incidents"),
        ]);
        return { incidents: rows.rows, total: countRes.rows[0].total };
    }

    const all = Array.from(incidentsStore.values()).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    return {
        incidents: all.slice(offset, offset + limit).map((i) => ({
            id: i.id,
            incidentId: i.id,
            created_at: i.created_at,
            severity: i.severity,
            root_cause_category: i.root_cause_category,
            root_cause_service: i.root_cause_service,
            priority: i.priority,
            execution_status: i.execution_status,
            decision_action: i.full_state?.decisionResult?.action ?? i.execution_status ?? '—',
            outcome: i.outcome,
            duration_seconds: i.duration_seconds,
        })),
        total: all.length,
    };
}

export async function getMetrics(): Promise<any> {
    if (usingRealDb) {
        const result = await (pool as Pool).query(`
            SELECT
                count(*)::int AS total,
                count(*) FILTER (WHERE outcome = 'resolved')::int AS resolved,
                count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
                count(*) FILTER (WHERE outcome = 'escalated')::int AS escalated,
                round(avg(duration_seconds) FILTER (WHERE outcome = 'resolved'))::int AS avg_mttr,
                round(avg(root_cause_confidence)::numeric, 2) AS avg_conf
            FROM incidents
        `);
        const row = result.rows[0];
        const total = row.total || 0;
        return {
            totalIncidents: total,
            resolvedAutomatically: row.resolved || 0,
            autoResolutionRate: total > 0 ? row.resolved / total : 0,
            averageMTTR: row.avg_mttr || 0,
            failedCount: row.failed || 0,
            escalatedCount: row.escalated || 0,
            avgRcaConfidence: parseFloat(row.avg_conf) || 0,
        };
    }

    const all = Array.from(incidentsStore.values());
    const total = all.length;
    const resolved = all.filter((i) => i.outcome === "resolved").length;
    const failed = all.filter((i) => i.outcome === "failed").length;
    const escalated = all.filter((i) => i.outcome === "escalated").length;

    const resolvedWithDuration = all.filter((i) => i.outcome === "resolved" && i.duration_seconds);
    const avgMTTR =
        resolvedWithDuration.length > 0
            ? Math.round(
                  resolvedWithDuration.reduce((s, i) => s + (i.duration_seconds || 0), 0) /
                      resolvedWithDuration.length
              )
            : 0;

    const confItems = all.filter((i) => i.root_cause_confidence != null);
    const avgConf =
        confItems.length > 0
            ? parseFloat(
                  (confItems.reduce((s, i) => s + (i.root_cause_confidence || 0), 0) / confItems.length).toFixed(2)
              )
            : 0;

    return {
        totalIncidents: total,
        resolvedAutomatically: resolved,
        autoResolutionRate: total > 0 ? resolved / total : 0,
        averageMTTR: avgMTTR,
        failedCount: failed,
        escalatedCount: escalated,
        avgRcaConfidence: avgConf,
    };
}

export async function closePool(): Promise<void> {
    if (usingRealDb) {
        await (pool as Pool).end();
        log.info("PostgreSQL pool closed");
        return;
    }
    log.info("In-memory database closed");
}
