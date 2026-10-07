/**
 * AutoOps AI — Per-class paired McNemar exact test (reviewer objection:
 * Fisher's exact test was being applied to PAIRED data in Experiment 2).
 *
 * WHY THIS EXISTS
 * Both arms of Experiment 2 run with PAIRED=true — every (scenario, runIndex)
 * incident receives byte-identical simulated event content in both arms. That
 * makes every full-vs-baseline comparison a matched-pairs comparison, and
 * Fisher's exact test assumes two INDEPENDENT samples. Applying it here
 * understates how extreme a given split actually is (or, for a tie, produces
 * the same p=1.00 by coincidence) and is the wrong test regardless of whether
 * the resulting number happens to look similar. McNemar's exact test
 * (binomial on the discordant pairs only) is the correct one and is what
 * `analyze-results.ts` already uses for the AGGREGATE arm comparison; this
 * script applies the same test per class and per class-subset, which nothing
 * previously did on a re-runnable basis.
 *
 *   npx tsx scripts/paired-class-mcnemar.ts scripts/eval-covered-full-gptoss120b.json \
 *                                           scripts/eval-covered-baseline-gptoss120b.json
 */
import { loadResults } from "../src/evaluation/load-results";

/** Two-sided exact binomial test at p=0.5, by direct summation (no external dep). */
function binomTwoSidedExact(k: number, n: number): number {
    if (n === 0) return 1;
    const logChoose = (n: number, k: number): number => {
        let r = 0;
        for (let i = 0; i < k; i++) r += Math.log(n - i) - Math.log(i + 1);
        return r;
    };
    const pmf = (k: number): number => Math.exp(logChoose(n, k) - n * Math.log(2));
    const target = pmf(k);
    let p = 0;
    for (let i = 0; i <= n; i++) {
        const pi = pmf(i);
        // Two-sided: sum every outcome at least as extreme (as-or-less-likely
        // under H0) as the observed one, the standard exact-binomial convention.
        if (pi <= target * (1 + 1e-9)) p += pi;
    }
    return Math.min(1, p);
}

function mcnemar(
    full: { results: any[] },
    base: { results: any[] },
    filter: (r: any) => boolean
): { fullOnly: number; baseOnly: number; concordant: number; n: number; p: number } {
    const key = (r: any) => `${r.scenario}#${r.runIndex}`;
    const f = new Map(full.results.filter(filter).map((r) => [key(r), r]));
    const b = new Map(base.results.filter(filter).map((r) => [key(r), r]));
    let fullOnly = 0, baseOnly = 0, concordant = 0;
    let n = 0;
    for (const [k, fr] of f) {
        const br = b.get(k);
        if (!br) continue;
        n++;
        const fc = !!fr.planScore?.correct;
        const bc = !!br.planScore?.correct;
        if (fc && !bc) fullOnly++;
        else if (bc && !fc) baseOnly++;
        else concordant++;
    }
    const discordant = fullOnly + baseOnly;
    const p = discordant === 0 ? 1 : binomTwoSidedExact(Math.min(fullOnly, baseOnly), discordant);
    return { fullOnly, baseOnly, concordant, n, p };
}

function fmtP(p: number): string {
    return p < 0.01 ? p.toExponential(1) : p.toFixed(2);
}

function main() {
    const [fullPath, basePath] = process.argv.slice(2);
    if (!fullPath || !basePath) {
        console.error("usage: paired-class-mcnemar.ts <full.json> <baseline.json>");
        process.exit(1);
    }
    const full = loadResults(fullPath);
    const base = loadResults(basePath);

    console.log(`\nPaired McNemar exact (binomial on discordant pairs) — replaces Fisher's\n` +
        `exact test wherever the compared arms share PAIRED incident content.\n`);

    const classes = [...new Set(full.results.map((r: any) => r.scenario))].sort();
    for (const cls of classes) {
        const { fullOnly, baseOnly, concordant, n, p } = mcnemar(full, base, (r) => r.scenario === cls);
        console.log(
            `  ${cls.padEnd(28)} n=${n.toString().padStart(3)}  full-only=${fullOnly.toString().padStart(2)}  ` +
            `baseline-only=${baseOnly.toString().padStart(2)}  concordant=${concordant.toString().padStart(2)}  p=${fmtP(p)}`
        );
    }

    console.log();
    const nonTemplate = ["high_error_rate", "disk_full", "connection_pool_exhaustion"];
    const sub = mcnemar(full, base, (r) => nonTemplate.includes(r.scenario));
    console.log(
        `  ${"NON-TEMPLATE SUBTOTAL".padEnd(28)} n=${sub.n}  full-only=${sub.fullOnly}  ` +
        `baseline-only=${sub.baseOnly}  concordant=${sub.concordant}  p=${fmtP(sub.p)}`
    );
    const agg = mcnemar(full, base, () => true);
    console.log(
        `  ${"AGGREGATE".padEnd(28)} n=${agg.n}  full-only=${agg.fullOnly}  ` +
        `baseline-only=${agg.baseOnly}  concordant=${agg.concordant}  p=${fmtP(agg.p)}`
    );
}

main();
