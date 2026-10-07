#!/usr/bin/env bash
# AutoOps AI — regenerate EVERY number the paper quotes, from the final
# gpt-oss-120b dataset only. No API calls; safe to re-run.
#
# The point of a single driver is that the paper's figures cannot come from a
# half-updated mix of runs: one command regenerates the random control from
# the final plan lengths and then recomputes every statistic downstream of it.
#
#   bash scripts/finalize-analysis.sh 2>&1 | tee /tmp/final-analysis.txt
set -uo pipefail
cd "$(dirname "$0")/.."

FULL=scripts/eval-heldout-full-gptoss120b.json
BASE=scripts/eval-heldout-baseline-gptoss120b.json
RAND=scripts/eval-heldout-random-gptoss120b.json
COV_FULL=scripts/eval-covered-full-gptoss120b.json
COV_BASE=scripts/eval-covered-baseline-gptoss120b.json

hdr() { printf '\n\n%s\n%s\n%s\n' "########################################################################" "## $1" "########################################################################"; }

# ── Completeness gate ─────────────────────────────────────────────
# Refuse to produce "final" numbers from a partial run. The whole reason this
# rerun exists is that the previous one reported figures over incomplete data.
hdr "0. COMPLETENESS CHECK"
node -e '
const fs=require("fs");
let bad=0;
for (const f of process.argv.slice(1)) {
  if (!fs.existsSync(f)) { console.log(`  MISSING   ${f}`); bad=1; continue; }
  const d=JSON.parse(fs.readFileSync(f,"utf8"));
  const rem=(d.remaining||[]).length;
  const n=d.results.length;
  console.log(`  ${rem?"INCOMPLETE":"complete  "} ${f}  ${n}/${n+rem}`);
  if (rem) bad=1;
}
if (bad) { console.log("\n  *** NOT FINAL: figures below are INTERIM. Do not put them in the paper. ***"); }
else { console.log("\n  All arms complete — figures below are publication-final."); }
' "$FULL" "$BASE"

# ── 1. Random control, regenerated from the FINAL plan lengths ────
hdr "1. RANDOM CONTROL (regenerated from final gpt-oss-120b plan lengths)"
# Explicit output path: the default derives the name from the source and would
# clobber the superseded llama-era control at scripts/eval-random-matched.json.
npx tsx scripts/random-planner-arm.ts "$FULL" 20 "$RAND" || echo "  (random-planner-arm failed)"

# ── 2. Rates, intervals, Fisher, McNemar ──────────────────────────
hdr "2. RATES / INTERVALS / FISHER / McNEMAR  (held-out)"
npx tsx scripts/analyze-results.ts "$FULL" "$BASE" || echo "  (analyze-results failed)"

# Deliberately NOT running analyze-results.ts (Fisher/McNemar) against the
# random control here. That is the pooled-arm test item #3 replaced for being
# statistically wrong (a random draw compared as if it were a second N=2000
# experimental arm), and it additionally computes a McNemar test on
# RESOLUTION OUTCOME against the random arm, which is meaningless — the
# random control has no executor, so outcome="none" for all 2000 rows, and
# the "test" is comparing a real outcome to the absence of one. Section 3 is
# the correct replacement.

# ── 3. Incident-level Monte Carlo null (replaces pooled random test) ──
hdr "3. MONTE CARLO NULL (incident-level, length-matched)"
npx tsx scripts/montecarlo-null.ts "$FULL" 20000 || echo "  (montecarlo-null failed)"

# ── 4. Risk-gate decomposition and sensitivity ────────────────────
hdr "4. RISK GATE: DECOMPOSITION, SATURATION, SENSITIVITY, ROUTING"
# --ablation-tex regenerates the data file behind the paper's Fig. 2, so the
# figure's bars always come from this run rather than hand-typed values.
npx tsx scripts/risk-decomposition.ts "$FULL" "$BASE" \
  --ablation-tex=paper/figures/risk_ablation_data.tex || echo "  (risk-decomposition failed)"

# ── 5. Experiment 2, if it has been rerun ─────────────────────────
if [ -f "$COV_FULL" ] && [ -f "$COV_BASE" ]; then
  hdr "5. EXPERIMENT 2 (covered classes)"
  npx tsx scripts/analyze-results.ts "$COV_FULL" "$COV_BASE" || true
  npx tsx scripts/risk-decomposition.ts "$COV_FULL" "$COV_BASE" || true
  echo
  echo "-- Per-class paired McNemar (both arms are PAIRED — Fisher on this data would be wrong) --"
  npx tsx scripts/paired-class-mcnemar.ts "$COV_FULL" "$COV_BASE" || true
  hdr "5b. EXPERIMENT 2 PLANNING-SOURCE DISTRIBUTION"
  node -e '
  const fs=require("fs");
  for (const f of process.argv.slice(1)) {
    const d=JSON.parse(fs.readFileSync(f,"utf8"));
    const by={}, corr={};
    for (const r of d.results) {
      const s=r.planSource||"none";
      by[s]=(by[s]||0)+1;
      if (r.planScore) { corr[s]=corr[s]||[0,0]; corr[s][1]++; if(r.planScore.correct) corr[s][0]++; }
    }
    console.log(`\n  ${f}  (arm=${d.meta.arm})`);
    console.log("   source distribution:", JSON.stringify(by));
    for (const s of Object.keys(corr)) console.log(`   strict correct by source: ${s} = ${corr[s][0]}/${corr[s][1]}`);
  }' "$COV_FULL" "$COV_BASE"
else
  hdr "5. EXPERIMENT 2 — not yet rerun on gpt-oss-120b (skipped)"
fi

# ── 6. Provenance: every reported number must come from one model ──
hdr "6. MODEL PROVENANCE AUDIT"
node -e '
const fs=require("fs");
for (const f of process.argv.slice(1)) {
  if (!fs.existsSync(f)) continue;
  const d=JSON.parse(fs.readFileSync(f,"utf8"));
  const models=new Set(d.results.map(r=>r.providerModel).filter(Boolean));
  const tok=d.results.filter(r=>r.totalTokens);
  console.log(`  ${f}`);
  console.log(`     provider models: ${models.size?[...models].join(", "):"(none — no model calls in this arm)"}`);
  console.log(`     model calls with recorded usage: ${tok.length}`);
  console.log(`     cumulative recorded tokens: ${tok.reduce((a,r)=>a+r.totalTokens,0).toLocaleString()}`);
  if (models.size>1) console.log("     *** MORE THAN ONE MODEL IN ONE ARM — results must not be pooled. ***");
}' "$FULL" "$BASE" "$COV_FULL" "$COV_BASE"

echo
echo "Done. Nothing above may enter the manuscript unless section 0 says all arms are complete."
