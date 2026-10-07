/**
 * Statistical-unit sensitivity for Experiment 1: the five held-out classes,
 * not the 100 incidents, are the units of generalization. No API calls.
 *
 *   npx tsx scripts/class-sensitivity.ts [scripts/eval-heldout-full-gptoss120b.json]
 */
import { loadResults } from "../src/evaluation/load-results";

const file = process.argv[2] || "scripts/eval-heldout-full-gptoss120b.json";
const d = loadResults(file);
const classes = [...new Set(d.results.map((r: any) => r.scenario))].sort() as string[];
const per = classes.map((c) => {
    const rs = d.results.filter((r: any) => r.scenario === c);
    return { c, k: rs.filter((r: any) => r.planScore?.correct).length, n: rs.length };
});
const rates = per.map((p) => p.k / p.n);
const sorted = [...rates].sort((a, b) => a - b);
const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

console.log(`${file} (arm=${d.meta.arm})`);
for (const p of per) console.log(`  ${p.c.padEnd(16)} ${p.k}/${p.n} = ${pct(p.k / p.n)}`);
console.log(`\nMacro-average class accuracy: ${pct(rates.reduce((a, b) => a + b, 0) / rates.length)}`);
console.log(`Median class accuracy:        ${pct(median)}`);
console.log(`Range across classes:         ${pct(sorted[0])} – ${pct(sorted[sorted.length - 1])}`);

const K = per.reduce((a, p) => a + p.k, 0), N = per.reduce((a, p) => a + p.n, 0);
console.log(`\nLeave-one-class-out overall strict correctness:`);
const loco = per.map((p) => ({ c: p.c, k: K - p.k, n: N - p.n }));
for (const l of loco) console.log(`  omit ${l.c.padEnd(16)} ${l.k}/${l.n} = ${pct(l.k / l.n)}`);
const lr = loco.map((l) => l.k / l.n);
console.log(`  min ${pct(Math.min(...lr))}, max ${pct(Math.max(...lr))}`);
