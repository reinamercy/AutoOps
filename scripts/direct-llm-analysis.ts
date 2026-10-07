/**
 * Pre-specified analysis for the Direct-LLM baseline (secondary experiment).
 * Protocol: docs/protocols/direct-llm-baseline.md §7. No API calls.
 *
 *   npx tsx scripts/direct-llm-analysis.ts
 */
import fs from "fs";
import { loadResults } from "../src/evaluation/load-results";

const FULL = "scripts/eval-heldout-full-gptoss120b.json";
const DIRECT = "scripts/eval-heldout-direct-gptoss120b.json";

function wilson(k: number, n: number): [number, number] {
    if (!n) return [NaN, NaN];
    const z = 1.959964, p = k / n, d = 1 + (z * z) / n;
    const c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return [(c - h) / d, (c + h) / d];
}

function binomTwoSidedExact(k: number, n: number): number {
    if (n === 0) return 1;
    const logC = (n: number, k: number) => { let r = 0; for (let i = 0; i < k; i++) r += Math.log(n - i) - Math.log(i + 1); return r; };
    const pmf = (i: number) => Math.exp(logC(n, i) - n * Math.log(2));
    const t = pmf(k);
    let p = 0;
    for (let i = 0; i <= n; i++) if (pmf(i) <= t * (1 + 1e-9)) p += pmf(i);
    return Math.min(1, p);
}

function quantile(s: number[], q: number): number {
    const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? s[lo] : s[lo] + (pos - lo) * (s[hi] - s[lo]);
}

function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function bootMedian(xs: number[], reps = 10000): [number, number] {
    const r = mulberry32(99), meds: number[] = [];
    for (let k = 0; k < reps; k++) {
        const s = xs.map(() => xs[Math.floor(r() * xs.length)]).sort((a, b) => a - b);
        meds.push(quantile(s, 0.5));
    }
    meds.sort((a, b) => a - b);
    return [quantile(meds, 0.025), quantile(meds, 0.975)];
}

const pct = (k: number, n: number) => `${k}/${n} = ${(100 * k / n).toFixed(1)}%`;
const fmtP = (p: number) => (p < 0.001 ? p.toExponential(2) : p.toFixed(3));

function mcnemar(pairs: Array<[boolean, boolean]>) {
    let fullOnly = 0, directOnly = 0, both = 0, neither = 0;
    for (const [f, d] of pairs) {
        if (f && !d) fullOnly++; else if (d && !f) directOnly++; else if (f && d) both++; else neither++;
    }
    const n = fullOnly + directOnly;
    return { fullOnly, directOnly, both, neither, p: n ? binomTwoSidedExact(Math.min(fullOnly, directOnly), n) : 1 };
}

function main() {
    const full = loadResults(FULL);
    const direct = JSON.parse(fs.readFileSync(DIRECT, "utf8"));
    const rem = (direct.remaining || []).length;
    if (rem) console.log(`*** INCOMPLETE: ${direct.results.length}/${direct.results.length + rem} — figures are INTERIM ***`);

    const models = new Set(direct.results.map((r: any) => r.providerModel).filter(Boolean));
    console.log(`Direct arm provider models: ${[...models].join(", ") || "(none)"}`);
    console.log(`Protocol sha256: ${direct.meta.protocolSha256}`);

    const D = direct.results;
    const N = D.length;
    const strict = D.filter((r: any) => r.planScore.correct).length;
    const [lo, hi] = wilson(strict, N);
    const usable = D.filter((r: any) => r.usable);
    const statusCounts: Record<string, number> = {};
    for (const r of D) statusCounts[r.callStatus] = (statusCounts[r.callStatus] || 0) + 1;

    console.log(`\n[1] Strict correctness (ITT): ${pct(strict, N)}  Wilson 95% CI [${(100 * lo).toFixed(1)}, ${(100 * hi).toFixed(1)}]`);
    console.log(`[2] Usable model calls: ${usable.length}/${N}  call status: ${JSON.stringify(statusCounts)}`);
    console.log(`    Strict over usable: ${pct(usable.filter((r: any) => r.planScore.correct).length, usable.length || 1)}`);

    const fullModel = full.results.filter((r: any) => r.planSource === "llm");
    const lenD = usable.filter((r: any) => r.planScore.correctLenient).length;
    const precD = usable.reduce((a: number, r: any) => a + r.planScore.precision, 0) / (usable.length || 1);
    const lenF = fullModel.filter((r: any) => r.planScore.correctLenient).length;
    const precF = fullModel.reduce((a: number, r: any) => a + r.planScore.precision, 0) / (fullModel.length || 1);
    console.log(`[3] Over usable model plans — Direct: containment ${pct(lenD, usable.length || 1)}, mean precision ${precD.toFixed(3)}`);
    console.log(`                               Full:   containment ${pct(lenF, fullModel.length)}, mean precision ${precF.toFixed(3)}  (n=${fullModel.length})`);
    const stepsD = usable.map((r: any) => r.planSteps.length).sort((a: number, b: number) => a - b);
    const stepsF = fullModel.map((r: any) => r.planSteps.length).sort((a: number, b: number) => a - b);
    if (stepsD.length) console.log(`    Plan length: Direct mean ${(stepsD.reduce((a: number, b: number) => a + b, 0) / stepsD.length).toFixed(2)}, Full mean ${(stepsF.reduce((a: number, b: number) => a + b, 0) / stepsF.length).toFixed(2)}`);

    console.log(`[4] Per-class strict (ITT):            Direct    Full`);
    const fullByKey = new Map<string, any>(full.results.map((r: any) => [`${r.scenario}#${r.runIndex}`, r]));
    const classes = [...new Set(D.map((r: any) => r.scenario))].sort() as string[];
    for (const c of classes) {
        const dc = D.filter((r: any) => r.scenario === c);
        const fc = full.results.filter((r: any) => r.scenario === c);
        const pairs: Array<[boolean, boolean]> = dc.map((r: any) => [!!fullByKey.get(`${c}#${r.runIndex}`)?.planScore?.correct, r.planScore.correct]);
        const m = mcnemar(pairs);
        console.log(`    ${c.padEnd(16)} ${String(dc.filter((r: any) => r.planScore.correct).length).padStart(2)}/${dc.length}     ` +
            `${String(fc.filter((r: any) => r.planScore?.correct).length).padStart(2)}/${fc.length}   ` +
            `(full-only ${m.fullOnly}, direct-only ${m.directOnly}, exact p=${fmtP(m.p)}; descriptive)`);
    }

    const lat = D.filter((r: any) => r.usable).map((r: any) => r.modelLatencyMs).sort((a: number, b: number) => a - b);
    if (lat.length) {
        const [blo, bhi] = bootMedian(lat);
        console.log(`[5] Model-call latency (usable, ms): median ${quantile(lat, 0.5).toFixed(0)}  IQR [${quantile(lat, 0.25).toFixed(0)}, ${quantile(lat, 0.75).toFixed(0)}]  ` +
            `95% CI(median) [${blo.toFixed(0)}, ${bhi.toFixed(0)}]  — model call only, NOT comparable to pipeline latency`);
    }
    const tok = D.filter((r: any) => r.totalTokens);
    if (tok.length) console.log(`    Tokens: ${tok.length} calls, median ${quantile(tok.map((r: any) => r.totalTokens).sort((a: number, b: number) => a - b), 0.5)}, total ${tok.reduce((a: number, r: any) => a + r.totalTokens, 0)}`);

    const allPairs: Array<[boolean, boolean]> = [];
    const usablePairs: Array<[boolean, boolean]> = [];
    let unpaired = 0;
    for (const r of D) {
        const f = fullByKey.get(`${r.scenario}#${r.runIndex}`);
        if (!f || f.eventSeed !== r.eventSeed) { unpaired++; continue; }
        const pr: [boolean, boolean] = [!!f.planScore?.correct, !!r.planScore.correct];
        allPairs.push(pr);
        if (f.planSource === "llm" && r.usable) usablePairs.push(pr);
    }
    const m1 = mcnemar(allPairs), m2 = mcnemar(usablePairs);
    console.log(`\n[6] PRIMARY McNemar (ITT, n=${allPairs.length}, unpaired=${unpaired}): full-only ${m1.fullOnly}, direct-only ${m1.directOnly}, ` +
        `both ${m1.both}, neither ${m1.neither}, exact two-sided p=${fmtP(m1.p)}`);
    console.log(`[7] SECONDARY McNemar (both usable, n=${usablePairs.length}): full-only ${m2.fullOnly}, direct-only ${m2.directOnly}, ` +
        `both ${m2.both}, neither ${m2.neither}, exact two-sided p=${fmtP(m2.p)}`);
}

main();
