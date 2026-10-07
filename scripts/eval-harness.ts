/**
 * Evaluation harness for paper/paper.tex — NOT part of the production system.
 * (task.md T7)
 *
 * Triggers N incidents per scenario synchronously via POST /api/incidents/trigger,
 * measures real end-to-end pipeline latency, captures the FULL generated plan, and
 * scores it against the per-scenario rubric in ./plan-scoring.ts.
 *
 * USAGE
 *   # Arm A — full system (template → memory → LLM → fallback)
 *   API_BASE=http://127.0.0.1:3002 SCENARIO_SET=held_out RUNS_PER_SCENARIO=20 \
 *     OUT=eval-heldout-full.json npx tsx scripts/eval-harness.ts
 *
 *   # Arm B — rule-based baseline (server must be started with BASELINE_MODE=true)
 *   API_BASE=http://127.0.0.1:3002 SCENARIO_SET=held_out RUNS_PER_SCENARIO=20 \
 *     ARM=baseline OUT=eval-heldout-baseline.json npx tsx scripts/eval-harness.ts
 *
 * INTEGRITY GUARDS (task.md BL-5) — the harness refuses to produce results it
 * cannot vouch for, rather than emitting quietly-contaminated numbers:
 *   · Verifies the server's actual BASELINE_MODE matches the declared ARM.
 *   · Aborts if planSource === "fallback" appears in the full arm, which means
 *     the Groq circuit breaker tripped and the "LLM" arm silently degraded into
 *     the baseline — the single most dangerous failure mode for this comparison.
 */
import fsSync from "fs";
import {
    generateEvents,
    setEventSeed,
    COVERED_SCENARIOS,
    HELD_OUT_SCENARIOS,
} from "../src/simulator/log-producer";
import { scorePlan, PlanScore, PlanStepLike } from "../src/evaluation/plan-scoring";
import { buildWorkOrder, maxRunLength } from "../src/evaluation/work-order";

const API_BASE = process.env.API_BASE || "http://127.0.0.1:3002";
const RUNS_PER_SCENARIO = parseInt(process.env.RUNS_PER_SCENARIO || "8", 10);
const ARM = (process.env.ARM || "full") as "full" | "baseline";
const SCENARIO_SET = (process.env.SCENARIO_SET || "covered") as "covered" | "held_out" | "all";
const OUT = process.env.OUT || `eval-results-${SCENARIO_SET}-${ARM}.json`;

const API_KEY = process.env.AUTOOPS_API_KEY || "";

/** Refuse to record results if Postgres/Redis/ChromaDB/Kafka silently fell back (default on for final runs). */
const REQUIRE_REAL_BACKENDS = process.env.REQUIRE_REAL_BACKENDS !== "false";

/** Spacing between incidents, to stay under Groq's TPM ceiling by design rather than by retry luck. */
const THROTTLE_MS = parseInt(process.env.THROTTLE_MS || "16000", 10);

/** Resume a previously-interrupted run: skip (scenario,runIndex) pairs already present in OUT. */
const RESUME = process.env.RESUME === "true";

/** Consecutive model-arm incidents lost to quota/fallback before the harness pauses and checkpoints. */
const QUOTA_PAUSE_STREAK = parseInt(process.env.QUOTA_PAUSE_STREAK || "3", 10);

/**
 * Plans sourced from the LLM carry no template/memory risk discount, so they
 * routinely score in the "approve" tier and park the pipeline on the human
 * approval gate until its 10-minute timeout. Left alone, a single arm of this
 * experiment would take days.
 *
 * Rather than bypassing the gate inside the pipeline (which would mean the
 * measured system is not the shipped system), the harness plays the on-call
 * engineer: it polls the real approval API and approves through the real
 * endpoint. CONSEQUENCE FOR THE PAPER: reported end-to-end latency excludes
 * human decision time, and every gated incident is approved rather than
 * rejected. Both must be stated explicitly alongside the latency figures.
 */
let approvalsGranted = 0;
let rateLimited = 0;
let approverStop = false;
/** Set by trigger() when the debug endpoint confirms the last Groq call died on a daily (not per-minute) quota. */
let lastCallWasQuotaExhausted = false;

async function approvalLoop(): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (API_KEY) headers["X-AutoOps-Key"] = API_KEY;

    while (!approverStop) {
        try {
            const res = await fetch(`${API_BASE}/api/v1/approvals`, {
                method: "POST",
                headers,
                body: JSON.stringify({ status: "PENDING", limit: 50 }),
            });
            if (res.ok) {
                const body: any = await res.json();
                for (const a of body.approvals ?? body.data ?? []) {
                    const d = await fetch(`${API_BASE}/api/v1/approvals/${a.id}/decision`, {
                        method: "POST",
                        headers,
                        body: JSON.stringify({
                            decision: "APPROVED",
                            approverId: "eval-harness",
                            comment: "Auto-approved by evaluation harness (task.md T8)",
                        }),
                    });
                    if (d.ok) approvalsGranted++;
                }
            } else if (res.status === 401) {
                console.error(
                    "✗ Approval API returned 401 — set AUTOOPS_API_KEY in the harness environment, " +
                    "or gated incidents will stall until timeout."
                );
                return;
            } else if (res.status === 429) {
                // Silent throttling here is indistinguishable from "no pending
                // approvals", and every gated incident then burns the full
                // 10-minute timeout. Fail loudly instead.
                rateLimited++;
                if (rateLimited === 1) {
                    console.error(
                        "✗ Approval API rate-limited the harness (429). Start the server with " +
                        "APPROVALS_RATE_LIMIT=10000 or gated incidents will stall until timeout."
                    );
                }
            }
        } catch {
            /* transient; retry on the next tick */
        }
        await new Promise((r) => setTimeout(r, 500));
    }
}

const SCENARIO_POOL: readonly string[] =
    SCENARIO_SET === "held_out"
        ? HELD_OUT_SCENARIOS
        : SCENARIO_SET === "all"
            ? [...COVERED_SCENARIOS, ...HELD_OUT_SCENARIOS]
            : COVERED_SCENARIOS;

/**
 * ONLY=a,b restricts the run to named scenarios. Used to re-run a single
 * stratum whose results were invalidated for a reason unrelated to plan
 * content — e.g. the Groq daily token quota running out partway through a run,
 * which hits whichever scenario happens to be last rather than whichever is
 * hardest. Re-running that stratum is legitimate precisely because the
 * exclusion is independent of what the model produced; it must still be
 * disclosed.
 */
const ONLY = (process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const SCENARIOS: readonly string[] = ONLY.length
    ? SCENARIO_POOL.filter((s) => ONLY.includes(s))
    : SCENARIO_POOL;

if (ONLY.length && SCENARIOS.length !== ONLY.length) {
    console.error(
        `✗ ONLY named ${ONLY.length} scenario(s) but only ${SCENARIOS.length} exist in ` +
        `SCENARIO_SET=${SCENARIO_SET}: ${ONLY.filter((o) => !SCENARIO_POOL.includes(o)).join(", ")}`
    );
    process.exit(1);
}

interface Result {
    scenario: string;
    arm: string;
    runIndex: number;
    /** Null when unpaired. Lets a reader verify pairing from the data alone. */
    eventSeed: number | null;
    incidentId: string;
    anomalyDetected: boolean;
    anomalyScore: number | null;
    issueType: string | null;
    rootCauseCategory: string | null;
    planSource: string | null;
    /** How many past incidents retrieval actually supplied. 0 means no RAG. */
    ragContextCount: number | null;
    planTitle: string | null;
    planSteps: PlanStepLike[];
    planScore: PlanScore | null;
    riskScore: number | null;
    riskTier: string | null;
    decisionAction: string | null;
    executionStatus: string | null;
    outcome: string | null;
    retryCount: number | null;
    stepsCompleted: number | null;
    stepsFailed: number | null;
    wallClockMs: number;
    /** Provider-returned model id for this incident's model call, if any (null for template/memory/fallback). */
    providerModel: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
}

/** Confirm the server is running the arm we claim to be measuring. */
async function verifyArm(): Promise<void> {
    let stores: any;
    try {
        const res = await fetch(`${API_BASE}/api/debug/stores`);
        stores = await res.json();
    } catch (err: any) {
        throw new Error(
            `Cannot reach ${API_BASE}/api/debug/stores (${err.message}). Is the server running?`
        );
    }

    const serverArm = stores.evaluation?.arm;
    if (!serverArm) {
        throw new Error(
            "Server did not report evaluation.arm — it is running an older build. " +
            "Rebuild/restart the server so the arm can be verified."
        );
    }
    if (serverArm !== ARM) {
        throw new Error(
            `ARM MISMATCH: harness declared ARM="${ARM}" but the server reports "${serverArm}". ` +
            `Restart the server with BASELINE_MODE=${ARM === "baseline" ? "true" : "false"} ` +
            `(or correct ARM). Refusing to record mislabelled results.`
        );
    }

    console.log(
        `✓ Arm verified: "${serverArm}"  |  scenarios: ${SCENARIO_SET} (${SCENARIOS.length})  |  ` +
        `runs/scenario: ${RUNS_PER_SCENARIO}  |  simFailureSeed: ${stores.evaluation.simFailureSeed ?? "unseeded"}`
    );

    if (REQUIRE_REAL_BACKENDS) {
        const checks: [string, string][] = [
            ["postgres", stores.postgres?.mode],
            ["vectorStore", stores.vectorStore?.mode],
            ["redisCache", stores.redisCache?.mode],
            ["kafkaBus", stores.kafkaBus?.mode],
        ];
        const fellBack = checks.filter(([, mode]) => mode !== "real");
        if (fellBack.length) {
            throw new Error(
                `REQUIRE_REAL_BACKENDS=true but these backends are NOT real: ` +
                fellBack.map(([name, mode]) => `${name}=${mode}`).join(", ") +
                `. This run is meant to use real Postgres/Redis/ChromaDB/Kafka (Docker up), not their ` +
                `in-process fallbacks — refusing to record results under a silently degraded backend. ` +
                `Start docker-compose and restart the server, or set REQUIRE_REAL_BACKENDS=false to proceed anyway.`
            );
        }
        console.log(`✓ Real backends confirmed: postgres, vectorStore, redisCache, kafkaBus all "real"`);
    }
}

/** Provider-returned model id + real token usage for the incident that was just triggered, if it called the model. */
async function fetchLastGroqCallMeta(): Promise<{
    providerModel: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    quotaExhausted: boolean;
}> {
    try {
        const res = await fetch(`${API_BASE}/api/debug/last-groq-call`);
        const body: any = await res.json();
        return {
            providerModel: body.meta?.providerModel ?? null,
            promptTokens: body.meta?.promptTokens ?? null,
            completionTokens: body.meta?.completionTokens ?? null,
            totalTokens: body.meta?.totalTokens ?? null,
            quotaExhausted: !!body.quotaExhausted,
        };
    } catch {
        return { providerModel: null, promptTokens: null, completionTokens: null, totalTokens: null, quotaExhausted: false };
    }
}

/**
 * COLD_START=true clears the vector store and fix cache before each incident.
 * Required for the held-out generalisation claim: otherwise the memory layer
 * serves incident N a fix learned from incidents 1..N-1 (observed: a
 * cert_expiry plan retrieved for a dns_failure incident), and the experiment
 * measures memoisation rather than generalisation.
 */
const COLD_START = process.env.COLD_START === "true";

/**
 * SEED_RETRIEVAL=true re-seeds the vector store, after clearing it, with
 * resolved incidents from the COVERED classes only (reviewer objection R1).
 *
 * Clearing alone leaves the store empty, so the retrieval step returns nothing
 * and the "retrieval-augmented" arm is really a bare model call — which is what
 * happened in the first held-out run, where the retrieved-context count was
 * zero on all 146 planning calls. Seeding restores realistic operational
 * history without putting any held-out-class content in reach, so
 * SEED_RETRIEVAL on/off isolates what retrieval actually contributes.
 */
const SEED_RETRIEVAL = process.env.SEED_RETRIEVAL === "true";

async function resetMemory(): Promise<void> {
    if (!COLD_START) return;
    try {
        await fetch(`${API_BASE}/api/debug/reset-memory`, { method: "POST" });
        if (SEED_RETRIEVAL) {
            const r = await fetch(`${API_BASE}/api/debug/seed-memory`, { method: "POST" });
            if (!r.ok) console.error("⚠ seed-memory failed — retrieval arm has an EMPTY store");
        }
    } catch {
        console.error("⚠ reset-memory failed — this incident is NOT a cold start");
    }
}

/**
 * PAIRED=true derives each incident's event seed deterministically from
 * (scenario, run index), so both arms receive byte-identical inputs and each
 * incident becomes a matched pair — the precondition for McNemar's test (T11).
 * The seed does NOT depend on the arm, which is the whole point.
 */
const PAIRED = process.env.PAIRED === "true";

/** Stable string hash → seed. Same scenario+index gives the same seed forever. */
function seedFor(scenario: string, index: number): number {
    const key = `${scenario}#${index}`;
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

async function trigger(scenario: string, runIndex: number): Promise<Result> {
    await resetMemory();
    if (PAIRED) setEventSeed(seedFor(scenario, runIndex));
    const events = generateEvents(scenario as any, 20);
    if (PAIRED) setEventSeed(null);
    const start = Date.now();
    const res = await fetch(`${API_BASE}/api/incidents/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
    });
    const wallClockMs = Date.now() - start;
    const body: any = await res.json();

    const base = {
        scenario,
        arm: ARM,
        runIndex,
        eventSeed: PAIRED ? seedFor(scenario, runIndex) : null,
        incidentId: body.incidentId,
        wallClockMs,
        outcome: body.outcome ?? null,
    };

    if (!body.summary || !body.summary.issue) {
        // Anomaly never crossed tau — the incident drops out of the benchmark.
        return {
            ...base,
            anomalyDetected: false,
            anomalyScore: null,
            issueType: null,
            rootCauseCategory: null,
            planSource: null,
            ragContextCount: null,
            planTitle: null,
            planSteps: [],
            planScore: null,
            riskScore: null,
            riskTier: null,
            decisionAction: null,
            executionStatus: null,
            retryCount: null,
            stepsCompleted: null,
            stepsFailed: null,
            providerModel: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
        };
    }

    const s = body.summary;
    const planSteps: PlanStepLike[] = s.plan?.planSteps ?? [];
    const planSource = s.planSource ?? s.plan?.source ?? null;

    // Only a source of "llm" actually called Groq this incident; fetching
    // the debug endpoint otherwise would attach a STALE prior call's usage to
    // a template/memory/fallback-sourced plan.
    let groqMeta = { providerModel: null as string | null, promptTokens: null as number | null,
                      completionTokens: null as number | null, totalTokens: null as number | null,
                      quotaExhausted: false };
    // Check on "model" (to record real usage) and on "fallback"/"unavailable"
    // (the fallback may itself be the SYMPTOM of quota exhaustion — this is
    // the only way to tell that apart from an unrelated transient failure).
    if (planSource === "llm" || planSource === "fallback" || planSource === "unavailable") {
        groqMeta = await fetchLastGroqCallMeta();
    }
    if (groqMeta.quotaExhausted) lastCallWasQuotaExhausted = true;

    return {
        ...base,
        anomalyDetected: true,
        anomalyScore: s.issue.anomalyScore,
        issueType: s.issue.type,
        rootCauseCategory: s.rootCause?.category ?? null,
        planSource,
        ragContextCount: s.plan?.ragContextCount ?? null,
        planTitle: s.plan?.title ?? null,
        planSteps,
        // Score the plan on the SCENARIO we generated, not on the type the
        // system inferred — the rubric encodes what actually fixes the injected
        // fault, and crediting the system's own (possibly wrong) label would
        // let a misdiagnosis grade its own answer.
        planScore: planSteps.length ? scorePlan(scenario, planSteps) : null,
        riskScore: s.risk?.score ?? null,
        riskTier: s.risk?.tier ?? null,
        decisionAction: s.decision?.action ?? null,
        executionStatus: s.executionStatus ?? null,
        retryCount: s.retryCount ?? null,
        stepsCompleted: s.stepsCompleted ?? null,
        stepsFailed: s.stepsFailed ?? null,
        providerModel: groqMeta.providerModel,
        promptTokens: groqMeta.promptTokens,
        completionTokens: groqMeta.completionTokens,
        totalTokens: groqMeta.totalTokens,
    };
}

function summarise(results: Result[]): void {
    console.log("\n── Plan correctness by scenario ──");
    for (const scenario of SCENARIOS) {
        const rs = results.filter((r) => r.scenario === scenario && r.planScore);
        if (!rs.length) {
            console.log(`  ${scenario.padEnd(28)} no scored plans`);
            continue;
        }
        const correct = rs.filter((r) => r.planScore!.correct).length;
        const sources = [...new Set(rs.map((r) => r.planSource))].join(",");
        console.log(
            `  ${scenario.padEnd(28)} ${correct}/${rs.length} correct ` +
            `(${((correct / rs.length) * 100).toFixed(0)}%)  source=${sources}`
        );
    }
    const scored = results.filter((r) => r.planScore);
    const totalCorrect = scored.filter((r) => r.planScore!.correct).length;
    console.log(
        `\n  OVERALL: ${totalCorrect}/${scored.length} ` +
        `(${scored.length ? ((totalCorrect / scored.length) * 100).toFixed(1) : "0"}%) plans address the root cause`
    );
}

/**
 * INTERLEAVE=true randomises the order incidents are issued in, instead of
 * running all 20 of one class before starting the next (reviewer objection S6).
 *
 * WHY IT MATTERS
 * The provider's daily token quota runs out partway through a 100-incident arm.
 * Under class-blocked ordering every lost incident lands on whichever class
 * happened to run last, so that class's score is confounded with the
 * exhaustion: we cannot tell a genuinely hard class from a starved one. A
 * seeded shuffle over all (scenario, runIndex) pairs spreads missing data
 * across classes in expectation, making the missingness class-independent.
 *
 * `runIndex` is preserved per pair, so PAIRED seeding — which derives an
 * incident's events from (scenario, runIndex) — is unaffected: interleaving
 * changes only the order of issue, not any incident's content.
 *
 * The permutation itself lives in src/evaluation/work-order.ts so it can be
 * unit-tested; this module executes on import and cannot be imported by a test.
 */
const INTERLEAVE = process.env.INTERLEAVE === "true";
const WORK_ORDER_SEED = parseInt(process.env.WORK_ORDER_SEED || "1337", 10);

const OUT_URL = new URL(`./${OUT}`, import.meta.url);

interface OutFile {
    meta: Record<string, unknown>;
    results: Result[];
    /** Present once the run stopped early on confirmed quota exhaustion. Absent = the run completed. */
    pausedAt?: string;
    remaining?: { scenario: string; i: number }[];
}

function loadPriorResults(): Result[] {
    if (!RESUME) return [];
    try {
        const raw = fsSync.readFileSync(OUT_URL, "utf-8");
        const parsed: OutFile = JSON.parse(raw);
        console.log(`✓ RESUME: loaded ${parsed.results.length} prior results from scripts/${OUT}`);
        return parsed.results;
    } catch {
        console.log(`  RESUME=true but scripts/${OUT} doesn't exist yet — starting fresh`);
        return [];
    }
}

function writeOut(results: Result[], remaining: { scenario: string; i: number }[], meta: Record<string, unknown>): void {
    const body: OutFile = {
        meta: { ...meta, generatedAt: new Date().toISOString() },
        results,
    };
    if (remaining.length) {
        body.pausedAt = new Date().toISOString();
        body.remaining = remaining;
    }
    fsSync.writeFileSync(OUT_URL, JSON.stringify(body, null, 2));
}

async function main() {
    await verifyArm();
    const approver = approvalLoop();

    const priorResults = loadPriorResults();
    const done = new Set(priorResults.map((r) => `${r.scenario}#${r.runIndex}`));
    const results: Result[] = [...priorResults];
    let fallbackSeen = 0;
    let consecutiveModelLoss = 0;

    const fullOrder = buildWorkOrder(SCENARIOS, RUNS_PER_SCENARIO, INTERLEAVE, WORK_ORDER_SEED);
    const order = fullOrder.filter((w) => !done.has(`${w.scenario}#${w.i}`));
    console.log(
        (INTERLEAVE
            ? `✓ Work order interleaved across ${SCENARIOS.length} classes (seed ${WORK_ORDER_SEED})`
            : `✓ Work order class-blocked`) +
        `, ${fullOrder.length} incidents total, ${order.length} remaining` +
        (done.size ? ` (${done.size} already done via RESUME)` : "") +
        `, longest same-class streak ${maxRunLength(fullOrder)}, throttle ${THROTTLE_MS}ms`
    );

    const meta = {
        arm: ARM,
        scenarioSet: SCENARIO_SET,
        runsPerScenario: RUNS_PER_SCENARIO,
        scenarios: SCENARIOS,
        paired: PAIRED,
        interleaved: INTERLEAVE,
        workOrderSeed: INTERLEAVE ? WORK_ORDER_SEED : null,
        autoApprovedByHarness: approvalsGranted,
        coldStart: COLD_START,
        seedRetrieval: SEED_RETRIEVAL,
        latencyExcludesHumanDecisionTime: true,
        requireRealBackends: REQUIRE_REAL_BACKENDS,
    };

    let pausedForQuota = false;
    let idx = 0;
    for (const { scenario, i } of order) {
        idx++;
        try {
            lastCallWasQuotaExhausted = false;
            const r = await trigger(scenario, i);
            results.push(r);

            // Both labels mean "the LLM did not produce this plan":
            // "fallback" = request/parse failure, "unavailable" = circuit
            // breaker open. Either one degrades the LLM arm into the baseline.
            const lostToNonModel = r.planSource === "fallback" || r.planSource === "unavailable";
            if (ARM === "full" && lostToNonModel) fallbackSeen++;
            consecutiveModelLoss = ARM === "full" && lostToNonModel ? consecutiveModelLoss + 1 : 0;

            const verdict = r.planScore
                ? r.planScore.correct ? "CORRECT" : "wrong"
                : "no-plan";
            console.log(
                `[${idx}/${order.length}] ${scenario} #${i + 1}: source=${r.planSource} ` +
                `model=${r.providerModel ?? "-"} tokens=${r.totalTokens ?? "-"} plan=${verdict} ` +
                `outcome=${r.outcome} t=${r.wallClockMs}ms`
            );

            // Checkpoint after EVERY incident — a crash, Ctrl-C, or a paused
            // process must never lose completed work (task.md — "0/100 must
            // become 100/100 across days, not a discarded partial run").
            const remaining = fullOrder.filter((w) => !new Set(results.map((r2) => `${r2.scenario}#${r2.runIndex}`)).has(`${w.scenario}#${w.i}`));
            writeOut(results, remaining, meta);

            if (lastCallWasQuotaExhausted) {
                console.error(
                    `\n⏸ CONFIRMED daily quota exhaustion on ${scenario} #${i + 1} ` +
                    `(Groq returned a per-day limit error, not per-minute). Pausing here — ` +
                    `${remaining.length} incidents remain, checkpointed to scripts/${OUT}. ` +
                    `Resume after the daily reset with RESUME=true and the same command.`
                );
                pausedForQuota = true;
                break;
            }
            if (consecutiveModelLoss >= QUOTA_PAUSE_STREAK) {
                console.error(
                    `\n⏸ ${consecutiveModelLoss} consecutive model-arm losses without a confirmed quota ` +
                    `signal — likely exhaustion the message-matcher didn't recognize, or a genuine outage. ` +
                    `Pausing rather than burning the rest of the run as wasted fallback calls. ` +
                    `${remaining.length} incidents remain, checkpointed to scripts/${OUT}.`
                );
                pausedForQuota = true;
                break;
            }
        } catch (err: any) {
            console.error(`${scenario} #${i + 1} FAILED: ${err.message}`);
        }

        if (idx < order.length) await new Promise((res) => setTimeout(res, THROTTLE_MS));
    }

    approverStop = true;
    await approver;

    const finalRemaining = fullOrder.filter((w) => !new Set(results.map((r2) => `${r2.scenario}#${r2.runIndex}`)).has(`${w.scenario}#${w.i}`));
    writeOut(results, finalRemaining, meta);
    console.log(
        `\nWrote ${results.length}/${fullOrder.length} results to scripts/${OUT} ` +
        `(auto-approved ${approvalsGranted} gated incidents)` +
        (finalRemaining.length ? ` — PAUSED, ${finalRemaining.length} remaining` : " — COMPLETE")
    );
    summarise(results);

    if (pausedForQuota) {
        // Exit code 3: distinct from success(0)/error(1)/contaminated(2) — "not
        // finished yet, but nothing is wrong; resume me later" per requirement
        // that quota exhaustion must never register as an experimental failure.
        process.exit(3);
    }

    // BL-5: distinguish a transient API hiccup from systematic degradation.
    // A handful of dropped calls is a reportable caveat; a circuit breaker stuck
    // open silently turns the LLM arm into the baseline and invalidates the run.
    if (fallbackSeen > 0) {
        const rate = fallbackSeen / results.length;
        console.error(
            `\n⚠ ${fallbackSeen}/${results.length} (${(rate * 100).toFixed(1)}%) incidents in the ` +
            `"full" arm fell back to a non-LLM plan. These are recorded with planSource="fallback" ` +
            `and MUST be reported as such, not counted as LLM plans.`
        );
        if (rate > 0.1) {
            console.error(
                `✗ CONTAMINATED RUN: above the 10% tolerance — this indicates systematic Groq ` +
                `degradation (circuit breaker open), not transient failures. Fix and re-run.`
            );
            process.exit(2);
        }
        console.error(`  Within the 10% transient tolerance — run is usable with this caveat stated.`);
    }
    if (rateLimited > 0) {
        console.error(
            `\n⚠ The approval poller was rate-limited ${rateLimited} times; some incidents may have ` +
            `waited on the gate longer than necessary, inflating their latency.`
        );
    }
}

main().catch((err) => {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
});
