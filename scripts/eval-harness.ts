/**
 * Evaluation harness for paper/paper.tex — NOT part of the production system.
 * Triggers N incidents per scenario synchronously via POST /api/incidents/trigger,
 * measures real end-to-end pipeline latency, and writes results to eval-results.json.
 */
import { generateEvents } from "../src/simulator/log-producer";

const API_BASE = process.env.API_BASE || "http://127.0.0.1:3002";
const SCENARIOS = [
    "oom_kill",
    "high_error_rate",
    "cpu_spike",
    "disk_full",
    "connection_pool_exhaustion",
    "service_down",
] as const;
const RUNS_PER_SCENARIO = parseInt(process.env.RUNS_PER_SCENARIO || "8", 10);

interface Result {
    scenario: string;
    incidentId: string;
    anomalyDetected: boolean;
    anomalyScore: number | null;
    rootCauseCategory: string | null;
    planSource: string | null;
    riskScore: number | null;
    riskTier: string | null;
    decisionAction: string | null;
    executionStatus: string | null;
    outcome: string | null;
    retryCount: number | null;
    stepsCompleted: number | null;
    stepsFailed: number | null;
    wallClockMs: number;
}

async function trigger(scenario: string): Promise<Result> {
    const events = generateEvents(scenario as any, 20);
    const start = Date.now();
    const res = await fetch(`${API_BASE}/api/incidents/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
    });
    const wallClockMs = Date.now() - start;
    const body: any = await res.json();

    if (!body.summary || !body.summary.issue) {
        return {
            scenario,
            incidentId: body.incidentId,
            anomalyDetected: false,
            anomalyScore: null,
            rootCauseCategory: null,
            planSource: null,
            riskScore: null,
            riskTier: null,
            decisionAction: null,
            executionStatus: null,
            outcome: body.outcome,
            retryCount: null,
            stepsCompleted: null,
            stepsFailed: null,
            wallClockMs,
        };
    }

    return {
        scenario,
        incidentId: body.incidentId,
        anomalyDetected: true,
        anomalyScore: body.summary.issue.anomalyScore,
        rootCauseCategory: body.summary.rootCause?.category ?? null,
        planSource: body.summary.plan?.source ?? null,
        riskScore: null, // not in the trigger summary; fetched via debug store if needed
        riskTier: null,
        decisionAction: null,
        executionStatus: body.summary.executionStatus,
        outcome: body.outcome,
        retryCount: body.summary.retryCount,
        stepsCompleted: body.summary.stepsCompleted,
        stepsFailed: body.summary.stepsFailed,
        wallClockMs,
    };
}

async function main() {
    const results: Result[] = [];
    for (const scenario of SCENARIOS) {
        for (let i = 0; i < RUNS_PER_SCENARIO; i++) {
            try {
                const r = await trigger(scenario);
                results.push(r);
                console.log(
                    `${scenario} #${i + 1}: outcome=${r.outcome} source=${r.planSource} status=${r.executionStatus} t=${r.wallClockMs}ms`
                );
            } catch (err: any) {
                console.error(`${scenario} #${i + 1} FAILED: ${err.message}`);
            }
        }
    }

    const fs = await import("fs");
    fs.writeFileSync(
        new URL("./eval-results.json", import.meta.url),
        JSON.stringify(results, null, 2)
    );
    console.log(`\nWrote ${results.length} results to scripts/eval-results.json`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
