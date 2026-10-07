/**
 * AutoOps AI — Seed corpus integrity (reviewer objection R1)
 *
 * The retrieval ablation compares a warm vector store against an empty one to
 * isolate what retrieval contributes on held-out incident classes. That
 * comparison is only meaningful if the warm store contains NOTHING about any
 * held-out class — otherwise retrieval is handing the model the answer and the
 * "generalisation" result collapses into memorisation.
 *
 * These tests are the guarantee. If someone later adds a convenient
 * cert-expiry example to the corpus, this fails loudly.
 */
import { describe, it, expect } from "vitest";
import {
    RETRIEVAL_SEED_CORPUS,
    HELD_OUT_TOKENS,
} from "../../evaluation/retrieval-corpus";
import { COVERED_SCENARIOS, HELD_OUT_SCENARIOS } from "../../simulator/log-producer";
import { HELD_OUT_RUBRICS } from "../../evaluation/plan-scoring";

describe("seed corpus cannot leak held-out classes", () => {
    for (const token of HELD_OUT_TOKENS) {
        it(`no corpus entry mentions "${token}"`, () => {
            const offenders = RETRIEVAL_SEED_CORPUS.filter(
                (e) =>
                    e.description.toLowerCase().includes(token) ||
                    JSON.stringify(e.metadata).toLowerCase().includes(token)
            ).map((e) => e.id);
            expect(offenders, `${offenders.join(", ")} leak "${token}"`).toEqual([]);
        });
    }

    it("no entry names a held-out scenario", () => {
        for (const scenario of HELD_OUT_SCENARIOS) {
            const hit = RETRIEVAL_SEED_CORPUS.filter((e) =>
                `${e.description} ${JSON.stringify(e.metadata)}`.toLowerCase().includes(scenario)
            );
            expect(hit.map((e) => e.id), `leaks ${scenario}`).toEqual([]);
        }
    });

    it("does not contain any held-out class's required remediation as a recipe", () => {
        // The corpus may legitimately mention an action that also happens to
        // fix a held-out class (e.g. apply_config), but it must never pair that
        // action with a held-out fault description. The token tests above cover
        // the fault side; this asserts the corpus is anchored to covered faults.
        for (const entry of RETRIEVAL_SEED_CORPUS) {
            const type = String(entry.metadata.incidentType || "");
            expect(
                (COVERED_SCENARIOS as readonly string[]).includes(type) ||
                ["pod_crash", "error_spike"].includes(type),
                `${entry.id} has incidentType "${type}", which is not a covered class`
            ).toBe(true);
        }
        // Sanity: the held-out rubrics still exist, so this test stays meaningful.
        expect(Object.keys(HELD_OUT_RUBRICS)).toHaveLength(5);
    });
});

describe("seed corpus is usable as retrieval history", () => {
    it("has two entries per covered class", () => {
        expect(RETRIEVAL_SEED_CORPUS).toHaveLength(12);
    });

    it("every entry has a non-trivial description and unique id", () => {
        const ids = new Set<string>();
        for (const e of RETRIEVAL_SEED_CORPUS) {
            expect(e.description.length).toBeGreaterThan(80);
            expect(ids.has(e.id), `duplicate id ${e.id}`).toBe(false);
            ids.add(e.id);
        }
    });

    it("every entry records a resolved outcome, so it is a usable precedent", () => {
        for (const e of RETRIEVAL_SEED_CORPUS) {
            expect(e.metadata.outcome).toBe("resolved");
        }
    });
});
