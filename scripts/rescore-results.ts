/**
 * AutoOps AI — Re-materialise plan scores into the released result files
 * (reviewer objection S7)
 *
 * THE PROBLEM THIS SOLVES
 * Each result file stores a `planScore` computed by whatever rubric was in
 * force when the run executed. The rubric has since been corrected (containment
 * -> strict, precision over non-diagnostic steps), and the paper's figures are
 * derived by re-scoring stored plan content, not by reading those fields. A
 * reader who opens eval-heldout-full.json therefore sees `correct: true` on 82
 * incidents where the paper reports 55 — the same data, two rubrics, no note
 * saying so.
 *
 * THE FIX
 * Re-score every record from its stored `planSteps` with the current rubric and
 * write the result to `planScore`, preserving the original verbatim under
 * `planScoreAsRun`. Nothing observed is altered: `planSteps` is the raw record
 * and is never touched, and scoring is a pure function of it, so this only
 * removes a stale derived field. `meta.rubric` then states which rubric the
 * stored scores correspond to.
 *
 * Idempotent: a file already carrying `planScoreAsRun` keeps the original it
 * recorded the first time, so repeated runs cannot chain-overwrite it.
 *
 * USAGE
 *   npx tsx scripts/rescore-results.ts                 # report only, no writes
 *   npx tsx scripts/rescore-results.ts --write         # rewrite in place
 */
import * as fs from "fs";
import * as path from "path";
import { scorePlan, RUBRIC_VERSION } from "../src/evaluation/plan-scoring";

const WRITE = process.argv.includes("--write");
const DIR = path.join(__dirname);

/**
 * Runs executed before the template-vocabulary and plan-source-attribution
 * defects were fixed (Section "Defects the Evaluation Exposed"). Their plans
 * are not comparable with the reported runs, so they are marked superseded
 * rather than re-scored — re-scoring would stamp a legitimate-looking 0% onto
 * records whose planner was broken for reasons unrelated to plan quality.
 */
const SUPERSEDED: Record<string, string> = {
    "eval-results-full.json":
        "Superseded. Executed before the template action vocabulary was aligned " +
        "and before plan-source attribution was fixed, so template plans were " +
        "non-dispatchable and fallback plans were mislabelled model-sourced. " +
        "Retained for audit only; not used for any figure in the paper.",
    "eval-results-baseline.json":
        "Superseded. Baseline companion to eval-results-full.json, from the same " +
        "pre-fix build. Retained for audit only; not used for any figure.",
};

/** Every released per-incident record file. */
const FILES = fs
    .readdirSync(DIR)
    .filter((f) => f.startsWith("eval-") && f.endsWith(".json"))
    .sort();

let changedFiles = 0;

for (const file of FILES) {
    const full = path.join(DIR, file);
    const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    // The oldest files are a bare array of records with no meta block. Wrap
    // them so provenance has somewhere to live.
    const doc = Array.isArray(parsed) ? { meta: {} as any, results: parsed } : parsed;
    if (!doc.meta) doc.meta = {};
    const results = doc.results;
    if (!Array.isArray(results)) continue;

    if (SUPERSEDED[file]) {
        doc.meta.superseded = SUPERSEDED[file];
        console.log(`${file.padEnd(38)} n=${String(results.length).padStart(4)}  marked superseded, not re-scored`);
        if (WRITE) {
            fs.writeFileSync(full, JSON.stringify(doc, null, 2));
            changedFiles++;
        }
        continue;
    }

    let strict = 0;
    let lenient = 0;
    let moved = 0;

    for (const r of results) {
        const rescored = scorePlan(r.scenario, r.planSteps || []);
        // Preserve the as-run score once, never overwrite an existing one.
        if (r.planScore && r.planScoreAsRun === undefined) {
            r.planScoreAsRun = r.planScore;
            moved++;
        }
        r.planScore = rescored;
        if (rescored.correct) strict++;
        if (rescored.correctLenient) lenient++;
    }

    const n = results.length;
    {
        doc.meta.rubric = {
            version: RUBRIC_VERSION,
            rescoredAt: new Date().toISOString(),
            note:
                "planScore is derived from planSteps by src/evaluation/plan-scoring.ts " +
                "at the version above. planScoreAsRun, where present, is the score " +
                "recorded at run time under an earlier rubric and is retained for " +
                "audit only — the paper's figures use planScore.",
        };
    }

    console.log(
        `${file.padEnd(38)} n=${String(n).padStart(4)}  ` +
        `strict=${String(strict).padStart(4)}  lenient=${String(lenient).padStart(4)}` +
        (moved ? `  (preserved ${moved} as-run scores)` : "  (already current)")
    );

    if (WRITE) {
        fs.writeFileSync(full, JSON.stringify(doc, null, 2));
        changedFiles++;
    }
}

console.log(
    WRITE
        ? `\nRewrote ${changedFiles} file(s) at rubric ${RUBRIC_VERSION}.`
        : `\nDry run — no files written. Re-run with --write to apply.`
);
