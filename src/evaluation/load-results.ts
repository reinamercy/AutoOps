/**
 * Guarded loader for evaluation result files.
 *
 * WHY THIS EXISTS
 * The llama-3.3-70b-versatile runs were superseded when the provider retired
 * that model, and their files remain in the repository as historical
 * artifacts. Nothing structural distinguishes them from current results — same
 * shape, same directory, adjacent filenames — so the only thing standing
 * between a superseded run and a number in the paper is remembering which is
 * which. This makes the loader refuse instead of relying on memory.
 */
import * as fs from "fs";

export interface LoadedResults {
    meta: Record<string, any>;
    results: any[];
    remaining?: { scenario: string; i: number }[];
}

export class SupersededResultsError extends Error {}

/**
 * `allowSuperseded` exists only for tooling that deliberately inspects
 * historical runs (e.g. regenerating their control arm for the record).
 * Analysis that feeds the manuscript must never set it.
 */
export function loadResults(path: string, allowSuperseded = false): LoadedResults {
    const d = JSON.parse(fs.readFileSync(path, "utf-8")) as LoadedResults;

    if (d.meta?.superseded && !allowSuperseded) {
        throw new SupersededResultsError(
            `\n✗ ${path} is marked SUPERSEDED and must not be used for reported figures.\n` +
            `  Reason: ${d.meta.supersededReason ?? "(none recorded)"}\n` +
            `  Superseded by: ${d.meta.supersededBy ?? "(unspecified)"}\n` +
            `  Pass allowSuperseded=true only to inspect the historical run itself.\n`
        );
    }

    const remaining = d.remaining?.length ?? 0;
    if (remaining > 0) {
        console.error(
            `⚠ ${path} is INCOMPLETE: ${d.results.length} of ${d.results.length + remaining} ` +
            `incidents recorded. Any figure derived from it is interim.`
        );
    }

    const models = new Set(d.results.map((r: any) => r.providerModel).filter(Boolean));
    if (models.size > 1) {
        throw new SupersededResultsError(
            `\n✗ ${path} contains results from MORE THAN ONE model: ${[...models].join(", ")}.\n` +
            `  Pooling models within one arm invalidates the comparison. Split the file.\n`
        );
    }

    return d;
}
