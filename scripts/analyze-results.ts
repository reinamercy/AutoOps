/**
 * AutoOps AI — Results analysis (task.md T10, groundwork for T11/T12)
 *
 * Reads one or more eval-harness output files and reports every figure the
 * paper quotes with an interval, not as a bare point estimate:
 *   · latency  → mean ± 95% CI (Student t, so small N is not flattered)
 *   · rates    → Wilson score interval (correct at the 0%/100% boundaries,
 *                where the normal approximation produces nonsense such as
 *                [1.0, 1.0] or intervals extending past 1)
 *
 * USAGE
 *   npx tsx scripts/analyze-results.ts scripts/eval-heldout-full.json \
 *                                      scripts/eval-heldout-baseline.json
 */
import * as fs from "fs";
import { loadResults } from "../src/evaluation/load-results";
import { scorePlan } from "../src/evaluation/plan-scoring";

interface AnyResult {
    scenario: string;
    arm: string;
    wallClockMs: number;
    planSource: string | null;
    outcome: string | null;
    anomalyDetected: boolean;
    planScore?: { correct: boolean; correctLenient?: boolean; precision?: number; score: number } | null;
}

// ── Statistics ────────────────────────────────────────────────

/** Two-sided t critical value at alpha = 0.05. Table lookup + asymptote. */
function tCrit95(df: number): number {
    const table: Record<number, number> = {
        1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
        8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160,
        14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093,
        20: 2.086, 21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060,
        26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042, 40: 2.021,
        50: 2.009, 60: 2.000, 80: 1.990, 100: 1.984, 120: 1.980,
    };
    if (df <= 0) return NaN;
    if (table[df]) return table[df];
    const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
    for (const k of keys) if (df < k) return table[k];
    return 1.96;
}

export function meanCI95(xs: number[]): { mean: number; lo: number; hi: number; n: number; sd: number } {
    const n = xs.length;
    if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, n: 0, sd: NaN };
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    if (n === 1) return { mean, lo: NaN, hi: NaN, n, sd: NaN };
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    const sd = Math.sqrt(variance);
    const margin = tCrit95(n - 1) * (sd / Math.sqrt(n));
    return { mean, lo: mean - margin, hi: mean + margin, n, sd };
}

/** Wilson score interval — valid at 0 and 1, unlike the normal approximation. */
export function wilsonCI95(successes: number, n: number): { p: number; lo: number; hi: number } {
    if (n === 0) return { p: NaN, lo: NaN, hi: NaN };
    const z = 1.96;
    const p = successes / n;
    const denom = 1 + (z * z) / n;
    const centre = (p + (z * z) / (2 * n)) / denom;
    const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
    return { p, lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

const PER_PROTOCOL = process.env.PER_PROTOCOL === "true";
/** LENIENT=true scores on containment only, to show what verbosity buys. */
const LENIENT = process.env.LENIENT === "true";

// ── Fisher's exact test (reviewer objection R7) ──────────────
//
// The two-proportion z-test we previously reported assumes the normal
// approximation holds. With one arm at exactly 0/100 that assumption fails and
// the resulting z (11.79) is not interpretable. Fisher's exact test conditions
// on the margins and is valid at the boundary, so it is what we now report.

function lnFactorial(n: number): number {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
}

/** P(exactly this table) under the hypergeometric null. */
function lnHypergeom(a: number, b: number, c: number, d: number): number {
    const n = a + b + c + d;
    return (
        lnFactorial(a + b) + lnFactorial(c + d) + lnFactorial(a + c) + lnFactorial(b + d) -
        lnFactorial(n) - lnFactorial(a) - lnFactorial(b) - lnFactorial(c) - lnFactorial(d)
    );
}

/**
 * Two-sided Fisher's exact p: sum the probabilities of every table with the
 * same margins that is no more likely than the observed one.
 */
export function fisherExact2x2(a: number, b: number, c: number, d: number): number {
    const r1 = a + b, r2 = c + d, c1 = a + c;
    const obs = lnHypergeom(a, b, c, d);
    const lo = Math.max(0, c1 - r2), hi = Math.min(r1, c1);
    let p = 0;
    for (let x = lo; x <= hi; x++) {
        const l = lnHypergeom(x, r1 - x, c1 - x, r2 - (c1 - x));
        // 1e-9 tolerance so the observed table is not excluded by rounding.
        if (l <= obs + 1e-9) p += Math.exp(l);
    }
    return Math.min(1, p);
}

/** Primary metric is strict (precision-aware); LENIENT=true selects containment. */
const isCorrect = (r: AnyResult): boolean =>
    LENIENT ? !!(r.planScore as any)?.correctLenient : !!r.planScore?.correct;

const pct = (x: number) => (isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);

// ── Report ────────────────────────────────────────────────────

function load(path: string): { arm: string; results: AnyResult[] } {
    const raw: any = loadResults(path);
    const results: AnyResult[] = raw.results ?? raw;
    const arm = raw.meta?.arm ?? results[0]?.arm ?? path;

    // Re-score from the stored plan steps rather than trusting the score the
    // harness wrote. The steps are the raw observation; the score is derived
    // from a rubric that may since have been corrected. Re-deriving means a
    // rubric fix does not require re-running the experiment (and cannot leave
    // stale scores silently in circulation).
    for (const r of results) {
        const steps = (r as any).planSteps;
        r.planScore = Array.isArray(steps) && steps.length
            ? scorePlan(r.scenario, steps)
            : null;
    }

    // PER_PROTOCOL=true drops incidents whose plan did not come from the layer
    // the arm is meant to exercise. In the full arm that means dropping
    // `fallback`/`unavailable` incidents, which occur when the Groq daily token
    // quota is exhausted — an exclusion caused by billing, not by plan content.
    // Report this ALONGSIDE the intent-to-treat figure, never instead of it:
    // dropping failures always flatters an arm, and the reader must see both.
    if (PER_PROTOCOL && arm === "full") {
        const kept = results.filter((r) => r.planSource === "llm" || r.planSource === "memory");
        const dropped = results.length - kept.length;
        if (dropped) {
            console.log(
                `\n[per-protocol] ${path}: excluded ${dropped}/${results.length} non-LLM-sourced ` +
                `incidents (quota exhaustion). Intent-to-treat figures are reported separately.`
            );
        }
        return { arm, results: kept };
    }
    return { arm, results };
}

function report(path: string) {
    const { arm, results } = load(path);
    console.log(`\n${"═".repeat(72)}\n${path}   [arm: ${arm}]   n = ${results.length}`);

    const scored = results.filter((r) => r.planScore);
    if (scored.length) {
        const correct = scored.filter((r) => isCorrect(r)).length;
        const ci = wilsonCI95(correct, scored.length);
        const lenient = scored.filter((r) => !!(r.planScore as any).correctLenient).length;
        const lci = wilsonCI95(lenient, scored.length);
        const mp = scored.reduce((a, r) => a + ((r.planScore as any).precision ?? 0), 0) / scored.length;
        console.log(
            `\nPlan correctness (STRICT, precision-aware): ${correct}/${scored.length} = ` +
            `${pct(ci.p)} [95% CI ${pct(ci.lo)}–${pct(ci.hi)}]`
        );
        console.log(
            `Plan correctness (LENIENT, containment):     ${lenient}/${scored.length} = ` +
            `${pct(lci.p)} [95% CI ${pct(lci.lo)}–${pct(lci.hi)}]`
        );
        console.log(`Mean action precision: ${mp.toFixed(3)}`);
    } else {
        console.log("\nPlan correctness: no scored plans in this file.");
    }

    const lat = meanCI95(results.map((r) => r.wallClockMs));
    console.log(
        `End-to-end latency: ${lat.mean.toFixed(0)} ms ` +
        (isNaN(lat.lo) ? "(CI undefined, n<2)" : `± ${(lat.hi - lat.mean).toFixed(0)} ` +
            `[95% CI ${lat.lo.toFixed(0)}–${lat.hi.toFixed(0)} ms]  sd=${lat.sd.toFixed(0)}  n=${lat.n}`)
    );

    const sources = new Map<string, number>();
    for (const r of results) sources.set(r.planSource ?? "none", (sources.get(r.planSource ?? "none") ?? 0) + 1);
    console.log(`Plan sources: ${[...sources].map(([k, v]) => `${k}=${v}`).join("  ")}`);

    const outcomes = new Map<string, number>();
    for (const r of results) outcomes.set(r.outcome ?? "none", (outcomes.get(r.outcome ?? "none") ?? 0) + 1);
    console.log(`Outcomes: ${[...outcomes].map(([k, v]) => `${k}=${v}`).join("  ")}`);

    // Per-source latency (task.md T9 / T13). The paper's "memory-cache speedup
    // did not replicate" claim rested on comparing LLM-sourced against
    // memory-sourced latency — but per BL-6 the LLM-labelled rows were
    // mislabelled fallback plans, so that comparison never measured what it
    // claimed. This is the genuine version: it is also the evidence for
    // contribution (ii), that cheaper sources are actually cheaper.
    const bySource = new Map<string, number[]>();
    for (const r of results) {
        const k = r.planSource ?? "none";
        if (!bySource.has(k)) bySource.set(k, []);
        bySource.get(k)!.push(r.wallClockMs);
    }
    if (bySource.size > 1) {
        console.log("\nLatency by plan source (mean ± 95% CI):");
        const order = ["template", "memory", "llm", "fallback", "unavailable", "none"];
        for (const src of order) {
            const xs = bySource.get(src);
            if (!xs?.length) continue;
            const s = meanCI95(xs);
            const scored = results.filter(
                (r) => (r.planSource ?? "none") === src && r.planScore
            );
            const corr = scored.filter((r) => isCorrect(r)).length;
            console.log(
                `  ${src.padEnd(12)} n=${String(s.n).padStart(3)}  ` +
                `${s.mean.toFixed(0).padStart(6)} ms` +
                (isNaN(s.lo) ? "" : ` [${s.lo.toFixed(0)}–${s.hi.toFixed(0)}]`) +
                (scored.length ? `   correct ${corr}/${scored.length}` : "")
            );
        }
    }

    console.log("\nPer scenario:");
    for (const scenario of [...new Set(results.map((r) => r.scenario))]) {
        const rs = results.filter((r) => r.scenario === scenario);
        const sc = rs.filter((r) => r.planScore);
        const c = sc.filter((r) => isCorrect(r)).length;
        const l = meanCI95(rs.map((r) => r.wallClockMs));
        const ci = sc.length ? wilsonCI95(c, sc.length) : null;
        console.log(
            `  ${scenario.padEnd(28)} correct ${c}/${sc.length}` +
            (ci ? ` (${pct(ci.p)} [${pct(ci.lo)}–${pct(ci.hi)}])` : "") +
            `  latency ${l.mean.toFixed(0)}ms`
        );
    }
}

/** Unpaired two-proportion comparison for the two arms (feeds T12). */
function compare(aPath: string, bPath: string) {
    const A = load(aPath), B = load(bPath);
    const aS = A.results.filter((r) => r.planScore), bS = B.results.filter((r) => r.planScore);
    if (!aS.length || !bS.length) return;

    const aC = aS.filter((r) => isCorrect(r)).length;
    const bC = bS.filter((r) => isCorrect(r)).length;
    const aCI = wilsonCI95(aC, aS.length), bCI = wilsonCI95(bC, bS.length);

    // Fisher's exact test (R7). Valid at the 0%/100% boundary, where the
    // normal approximation behind a z-test is not.
    const pval = fisherExact2x2(aC, aS.length - aC, bC, bS.length - bC);

    console.log(`\n${"═".repeat(72)}\nARM COMPARISON — plan correctness (${LENIENT ? "LENIENT/containment" : "STRICT/precision-aware"})`);
    console.log(`  ${A.arm.padEnd(10)} ${aC}/${aS.length} = ${pct(aCI.p)} [${pct(aCI.lo)}–${pct(aCI.hi)}]`);
    console.log(`  ${B.arm.padEnd(10)} ${bC}/${bS.length} = ${pct(bCI.p)} [${pct(bCI.lo)}–${pct(bCI.hi)}]`);
    console.log(
        `  difference: ${pct(aCI.p - bCI.p)}   Fisher exact p ` +
        (pval < 1e-6 ? "< 0.000001" : `= ${pval.toPrecision(3)}`)
    );
    console.log(`  ${pval < 0.05 ? "→ significant at alpha = 0.05" : "→ NOT significant at alpha = 0.05"}`);
}

/**
 * McNemar's test on matched pairs (task.md T11).
 *
 * Only valid when both arms saw the same inputs. We verify that from the data
 * itself — matching on (scenario, runIndex) and requiring identical eventSeed —
 * and refuse to report a p-value otherwise. Running McNemar on independently
 * randomised arms is a real statistical error, not a technicality, and the
 * paper's original "statistically indistinguishable" claim had no test at all.
 */
function mcnemar(aPath: string, bPath: string, metric: "plan" | "resolution") {
    const A = load(aPath), B = load(bPath);

    const key = (r: AnyResult) => `${r.scenario}#${(r as any).runIndex}`;
    const bByKey = new Map(B.results.map((r) => [key(r), r]));

    let b = 0, c = 0, concordant = 0, unpairable = 0;
    for (const ra of A.results) {
        const rb = bByKey.get(key(ra));
        if (!rb) { unpairable++; continue; }
        const sa = (ra as any).eventSeed, sb = (rb as any).eventSeed;
        if (sa == null || sb == null || sa !== sb) { unpairable++; continue; }

        const ok = (r: AnyResult) =>
            metric === "plan"
                ? isCorrect(r)
                : r.outcome === "resolved";

        const oa = ok(ra), ob = ok(rb);
        if (oa && !ob) b++;
        else if (!oa && ob) c++;
        else concordant++;
    }

    console.log(`\n${"═".repeat(72)}\nMcNEMAR — ${metric === "plan" ? "plan correctness" : "resolution"}`);

    if (unpairable) {
        console.log(
            `  ✗ NOT APPLICABLE: ${unpairable} incident(s) could not be matched on ` +
            `(scenario, runIndex, eventSeed).\n` +
            `    These arms were not run with PAIRED=true on the same seeds, so the data is\n` +
            `    UNPAIRED and McNemar's test does not apply. Use the two-proportion test above,\n` +
            `    or re-run both arms with PAIRED=true.`
        );
        return;
    }

    const n = b + c;
    console.log(`  discordant pairs: full-only=${b}  baseline-only=${c}  concordant=${concordant}`);
    if (n === 0) {
        console.log("  No discordant pairs — the arms agree on every matched incident; p = 1.0.");
        return;
    }

    // Exact binomial two-sided test; correct for small n, where the
    // chi-square approximation is unreliable.
    const logC = (nn: number, k: number) => {
        let s = 0;
        for (let i = 1; i <= k; i++) s += Math.log(nn - k + i) - Math.log(i);
        return s;
    };
    let tail = 0;
    const lo = Math.min(b, c);
    for (let k = 0; k <= lo; k++) tail += Math.exp(logC(n, k) - n * Math.LN2);
    const p = Math.min(1, 2 * tail);

    console.log(`  exact binomial (two-sided): p ${p < 1e-6 ? "< 0.000001" : `= ${p.toPrecision(3)}`}`);
    console.log(`  ${p < 0.05 ? "→ significant at alpha = 0.05" : "→ NOT significant at alpha = 0.05"}`);
}

function main() {
    const paths = process.argv.slice(2);
    if (!paths.length) {
        console.error("usage: npx tsx scripts/analyze-results.ts <results.json> [results2.json]");
        process.exit(1);
    }
    for (const p of paths) report(p);
    if (paths.length === 2) {
        compare(paths[0], paths[1]);
        mcnemar(paths[0], paths[1], "plan");
        mcnemar(paths[0], paths[1], "resolution");
    }
}

main();
