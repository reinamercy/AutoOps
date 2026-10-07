/**
 * AutoOps AI — Length-matched random planner (reviewer objection R2/R3)
 *
 * WHY THIS EXISTS
 * Plan correctness was originally scored on containment: a plan counted as
 * correct if it contained at least one required action anywhere. Observed LLM
 * plans average 4.74 steps against the rule-based arm's exactly 2.00, and with
 * a 10-action vocabulary a 5-step plan hits a specific required action ~50% of
 * the time by chance. Under containment, therefore, part of the LLM arm's
 * advantage is simply that it writes longer plans.
 *
 * This arm quantifies that. It draws actions uniformly at random from the same
 * vocabulary, at the SAME per-incident plan lengths the LLM arm produced, and
 * scores them with the same rubric. It is the control that says how much of the
 * headline number is reasoning and how much is verbosity.
 *
 * It needs no server and no API calls: it consumes an existing results file for
 * the length distribution and emits a scored results file in the same shape.
 *
 * USAGE
 *   npx tsx scripts/random-planner-arm.ts scripts/eval-heldout-full.json \
 *     [repeats] > /dev/null   # writes eval-heldout-random.json
 */
import * as fs from "fs";
import { scorePlan, PlanStepLike } from "../src/evaluation/plan-scoring";

/** The executor's full action vocabulary (execution.agent.ts). */
const VOCABULARY = [
    "restart_service",
    "scale_deployment",
    "rolling_restart",
    "rollback_deployment",
    "update_resource_limits",
    "clear_disk_space",
    "flush_connection_pool",
    "apply_config",
    "verify_health",
    "trigger_pipeline",
];

/** Seeded PRNG so the control arm is reproducible like every other arm. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Sample k distinct actions uniformly without replacement. */
function randomPlan(k: number, rnd: () => number): PlanStepLike[] {
    const pool = [...VOCABULARY];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, Math.min(k, pool.length)).map((action, i) => ({
        action,
        description: `randomly selected action ${i + 1}`,
        parameters: {},
    }));
}

function main() {
    const src = process.argv[2];
    const repeats = parseInt(process.argv[3] || "1", 10);
    if (!src) {
        console.error("usage: npx tsx scripts/random-planner-arm.ts <results.json> [repeats]");
        process.exit(1);
    }

    const raw = JSON.parse(fs.readFileSync(src, "utf8"));
    const source = raw.results ?? raw;
    const rnd = mulberry32(42);

    const results: any[] = [];
    for (let rep = 0; rep < repeats; rep++) {
        for (const r of source) {
            const k = Array.isArray(r.planSteps) && r.planSteps.length ? r.planSteps.length : 2;
            const planSteps = randomPlan(k, rnd);
            results.push({
                scenario: r.scenario,
                arm: "random",
                runIndex: r.runIndex ?? results.length,
                eventSeed: r.eventSeed ?? null,
                incidentId: `random-${rep}-${r.incidentId ?? results.length}`,
                anomalyDetected: true,
                anomalyScore: r.anomalyScore ?? null,
                issueType: r.issueType ?? null,
                rootCauseCategory: r.rootCauseCategory ?? null,
                planSource: "random",
                planTitle: `Random ${k}-action plan`,
                planSteps,
                planScore: scorePlan(r.scenario, planSteps),
                riskScore: null,
                riskTier: null,
                decisionAction: null,
                executionStatus: null,
                outcome: null,
                retryCount: null,
                stepsCompleted: null,
                stepsFailed: null,
                // A random planner does no work; reporting a latency would
                // invite a meaningless speed comparison.
                wallClockMs: 0,
            });
        }
    }

    // Explicit output path, because deriving it from the source silently
    // collides across source arms: running this against a second source
    // overwrites the first source's control, destroying a superseded
    // artifact that may no longer be regenerable.
    const out = process.argv[4] || src.replace(/([^/]+)\.json$/, "eval-random-matched.json");
    fs.writeFileSync(
        out,
        JSON.stringify(
            {
                meta: {
                    arm: "random",
                    lengthMatchedTo: src,
                    repeats,
                    vocabularySize: VOCABULARY.length,
                    generatedAt: new Date().toISOString(),
                    note:
                        "Length-matched random control for reviewer objection R2. " +
                        "Actions drawn uniformly without replacement at the same " +
                        "per-incident plan lengths as the source arm.",
                },
                results,
            },
            null,
            2
        )
    );

    const strict = results.filter((r) => r.planScore.correct).length;
    const lenient = results.filter((r) => r.planScore.correctLenient).length;
    console.error(
        `Random control (n=${results.length}, length-matched): ` +
        `lenient ${lenient}/${results.length} (${((lenient / results.length) * 100).toFixed(1)}%), ` +
        `strict ${strict}/${results.length} (${((strict / results.length) * 100).toFixed(1)}%)`
    );
    console.error(`Wrote ${out}`);
}

main();
