/**
 * AutoOps AI — Incident-level Monte Carlo null for plan correctness,
 * plus skew-robust latency statistics. No API calls; reads frozen results.
 *
 * WHY THIS REPLACES THE PREVIOUS RANDOM-CONTROL TEST
 * The earlier analysis drew 2,000 random plans and compared the LLM arm's
 * 100 incidents against them with Fisher's exact test, as though the control
 * were a second experimental arm with N=2,000. That is the wrong null in two
 * ways. It reports a confidence interval whose width reflects how many random
 * plans we chose to draw rather than anything about the system, and it
 * compares against a pooled rate instead of against the distribution of
 * outcomes an experiment of THIS size could produce by chance.
 *
 * The correct null is at the level of the experiment, not the plan: draw one
 * length-matched random plan for each of the n real incidents, score the whole
 * synthetic experiment with the same rubric, and repeat. That yields the
 * distribution of total correct counts a chance planner would achieve on an
 * n-incident run, against which the observed count is a percentile. The
 * resulting p-value needs no distributional assumption and no independence
 * claim across a pooled arm.
 *
 * Length matching is per incident: replicate r's plan for incident i has the
 * same number of steps as the real plan for incident i, so the null inherits
 * the real arm's verbosity exactly.
 *
 *   npx tsx scripts/montecarlo-null.ts scripts/eval-heldout-full-gptoss120b.json [replicates]
 */
import * as fs from "fs";
import { loadResults } from "../src/evaluation/load-results";
import { scorePlan, PlanStepLike, RUBRIC_VERSION } from "../src/evaluation/plan-scoring";

const VOCABULARY = [
    "restart_service", "scale_deployment", "rolling_restart", "rollback_deployment",
    "update_resource_limits", "clear_disk_space", "flush_connection_pool",
    "apply_config", "verify_health", "trigger_pipeline",
];

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

function randomPlan(k: number, rnd: () => number): PlanStepLike[] {
    const pool = [...VOCABULARY];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, Math.min(k, pool.length)).map((action) => ({
        action,
        description: `random control step: ${action}`,
    }));
}

// ── Skew-robust summary statistics ──
function quantile(sorted: number[], q: number): number {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

/** Percentile bootstrap CI for the median — API latency is right-skewed, so the
 *  mean and a normal CI both misdescribe it. */
function bootstrapMedianCI(xs: number[], reps = 10000, seed = 99): [number, number] {
    const rnd = mulberry32(seed);
    const meds: number[] = [];
    for (let r = 0; r < reps; r++) {
        const s: number[] = [];
        for (let i = 0; i < xs.length; i++) s.push(xs[Math.floor(rnd() * xs.length)]);
        s.sort((a, b) => a - b);
        meds.push(quantile(s, 0.5));
    }
    meds.sort((a, b) => a - b);
    return [quantile(meds, 0.025), quantile(meds, 0.975)];
}

function describe(label: string, xs: number[]): void {
    if (!xs.length) { console.log(`  ${label.padEnd(26)} (no observations)`); return; }
    const s = [...xs].sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const [lo, hi] = bootstrapMedianCI(s);
    console.log(
        `  ${label.padEnd(26)} n=${String(s.length).padStart(3)}  ` +
        `median=${quantile(s, 0.5).toFixed(0).padStart(6)}  ` +
        `IQR=[${quantile(s, 0.25).toFixed(0)}, ${quantile(s, 0.75).toFixed(0)}]  ` +
        `95%CI(med)=[${lo.toFixed(0)}, ${hi.toFixed(0)}]  ` +
        `mean=${mean.toFixed(0)}  min=${s[0].toFixed(0)}  max=${s[s.length - 1].toFixed(0)}`
    );
}

function main() {
    const file = process.argv[2];
    const REPLICATES = parseInt(process.argv[3] || "20000", 10);
    if (!file) { console.error("usage: montecarlo-null.ts <results.json> [replicates]"); process.exit(1); }

    const d: any = loadResults(file);
    const scored = d.results.filter((r: any) => r.planScore && r.planSteps?.length);

    console.log(`\n${"=".repeat(72)}`);
    console.log(`${file}  (arm=${d.meta.arm}, rubric=${RUBRIC_VERSION})`);
    console.log(`${"=".repeat(72)}`);
    if (d.remaining?.length) {
        console.log(`\n*** INCOMPLETE: ${d.results.length} of ${d.results.length + d.remaining.length} ` +
            `incidents recorded. Figures below are INTERIM. ***`);
    }

    // ── Observed ──
    // Intent-to-treat over every recorded incident, including those whose model
    // call was lost (they score as incorrect), matching the paper's convention.
    const nTotal = d.results.length;
    const observedCorrect = d.results.filter((r: any) => r.planScore?.correct).length;
    console.log(`\n[Observed] strict-correct: ${observedCorrect}/${nTotal} = ` +
        `${(100 * observedCorrect / nTotal).toFixed(1)}%  (ITT over all recorded incidents)`);

    // ── Monte Carlo null ──
    // One length-matched random plan per real incident; repeat the whole
    // n-incident experiment REPLICATES times.
    const lengths = scored.map((r: any) => ({ scenario: r.scenario, k: r.planSteps.length }));
    const rnd = mulberry32(20260924);
    const totals: number[] = [];
    for (let rep = 0; rep < REPLICATES; rep++) {
        let correct = 0;
        for (const { scenario, k } of lengths) {
            const s = scorePlan(scenario, randomPlan(k, rnd));
            if (s.correct) correct++;
        }
        totals.push(correct);
    }
    totals.sort((a, b) => a - b);

    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    // One-sided: P(null >= observed). +1/+1 keeps the estimate from ever being
    // exactly 0, which would overstate certainty at finite replicate counts.
    const atLeast = totals.filter((t) => t >= observedCorrect).length;
    const p = (atLeast + 1) / (totals.length + 1);

    console.log(`\n[Monte Carlo null] ${REPLICATES} replicates of the full ` +
        `${lengths.length}-incident experiment, length-matched per incident`);
    console.log(`  null mean correct:   ${mean.toFixed(2)} / ${lengths.length} ` +
        `(${(100 * mean / lengths.length).toFixed(1)}%)`);
    console.log(`  null median:         ${quantile(totals, 0.5).toFixed(0)}`);
    console.log(`  null 95% interval:   [${quantile(totals, 0.025).toFixed(0)}, ${quantile(totals, 0.975).toFixed(0)}]`);
    console.log(`  null range:          [${totals[0]}, ${totals[totals.length - 1]}]`);
    console.log(`  observed:            ${observedCorrect}`);
    console.log(`  replicates >= obs:   ${atLeast}`);
    // Report the finite-sample estimate itself, (b+1)/(B+1) — not an ad-hoc
    // bound. With b=0 this is the smallest p the simulation can resolve.
    console.log(`  one-sided p:         (b+1)/(B+1) = (${atLeast}+1)/(${totals.length}+1) = ${p.toExponential(2)}`);

    // ── Per-class null ──
    console.log(`\n[Per-class] observed vs null mean:`);
    const classes = [...new Set(lengths.map((l) => l.scenario))].sort();
    for (const cls of classes) {
        const clsAll = d.results.filter((r: any) => r.scenario === cls);
        const obs = clsAll.filter((r: any) => r.planScore?.correct).length;
        const clsLengths = lengths.filter((l) => l.scenario === cls);
        const r2 = mulberry32(777);
        let sum = 0;
        const REP2 = 5000;
        for (let rep = 0; rep < REP2; rep++)
            for (const { scenario, k } of clsLengths)
                if (scorePlan(scenario, randomPlan(k, r2)).correct) sum++;
        const nullRate = clsLengths.length ? sum / (REP2 * clsLengths.length) : 0;
        console.log(`  ${cls.padEnd(18)} observed ${obs}/${clsAll.length}` +
            `  null ${(100 * nullRate).toFixed(1)}%  (scored n=${clsLengths.length})`);
    }

    // ── Latency (#7): medians and IQRs, not means ──
    console.log(`\n[Latency] end-to-end wall clock, ms — skew-robust summary:`);
    describe("all recorded", d.results.map((r: any) => r.wallClockMs));
    const bySource = new Map<string, number[]>();
    for (const r of d.results) {
        if (!bySource.has(r.planSource)) bySource.set(r.planSource, []);
        bySource.get(r.planSource)!.push(r.wallClockMs);
    }
    for (const [src, xs] of [...bySource.entries()].sort()) describe(`source=${src}`, xs);

    console.log(`\n[Plan length] steps per plan:`);
    describe("all scored plans", scored.map((r: any) => r.planSteps.length));

    console.log(`\n[Tokens] per model call:`);
    describe("total tokens", d.results.filter((r: any) => r.totalTokens).map((r: any) => r.totalTokens));
    const tk = d.results.filter((r: any) => r.totalTokens);
    if (tk.length) {
        console.log(`  cumulative tokens across ${tk.length} model calls: ` +
            tk.reduce((a: number, r: any) => a + r.totalTokens, 0).toLocaleString());
    }
}

main();
