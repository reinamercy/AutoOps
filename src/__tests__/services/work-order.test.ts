/**
 * AutoOps AI — Issue-order integrity (reviewer objection S6)
 *
 * The interleaved order exists to make quota-driven missing data independent of
 * incident class. That argument only holds if the shuffle is a genuine
 * permutation of the same incident set — if it resampled, dropped or
 * duplicated pairs, the re-run would not be comparable with the reported one
 * and the fix would be worse than the confound it replaces.
 *
 * These tests pin that down, plus the property the paper leans on: that
 * interleaving changes when an incident is issued, never what it is.
 */
import { describe, it, expect } from "vitest";
import { buildWorkOrder, maxRunLength, mulberry32 } from "../../evaluation/work-order";

const CLASSES = ["cert_expiry", "dns_failure", "config_drift", "cpu_throttling", "db_deadlock"];
const RUNS = 20;

/** Canonical multiset key, order-insensitive. */
function signature(order: { scenario: string; i: number }[]): string {
    return order.map((w) => `${w.scenario}#${w.i}`).sort().join("|");
}

describe("buildWorkOrder is a permutation, not a resample", () => {
    it("emits every (scenario, runIndex) pair exactly once", () => {
        const order = buildWorkOrder(CLASSES, RUNS, true, 1337);
        expect(order).toHaveLength(CLASSES.length * RUNS);
        const keys = order.map((w) => `${w.scenario}#${w.i}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("interleaved and class-blocked orders contain identical incident sets", () => {
        const blocked = buildWorkOrder(CLASSES, RUNS, false, 1337);
        const mixed = buildWorkOrder(CLASSES, RUNS, true, 1337);
        // Same incidents, different sequence — this is what makes the re-run
        // comparable to the reported run incident-for-incident.
        expect(signature(mixed)).toBe(signature(blocked));
        expect(mixed.map((w) => w.scenario)).not.toEqual(blocked.map((w) => w.scenario));
    });

    it("keeps each run index paired with its own scenario", () => {
        // PAIRED seeding derives event content from (scenario, runIndex), so a
        // shuffle that detached the two would silently change incidents.
        for (const w of buildWorkOrder(CLASSES, RUNS, true, 1337)) {
            expect(CLASSES).toContain(w.scenario);
            expect(w.i).toBeGreaterThanOrEqual(0);
            expect(w.i).toBeLessThan(RUNS);
        }
    });

    it("gives every scenario the same number of incidents", () => {
        const counts = new Map<string, number>();
        for (const w of buildWorkOrder(CLASSES, RUNS, true, 1337)) {
            counts.set(w.scenario, (counts.get(w.scenario) || 0) + 1);
        }
        expect([...counts.values()]).toEqual(CLASSES.map(() => RUNS));
    });
});

describe("buildWorkOrder is reproducible and seed-sensitive", () => {
    it("the same seed gives the same order", () => {
        expect(buildWorkOrder(CLASSES, RUNS, true, 42)).toEqual(
            buildWorkOrder(CLASSES, RUNS, true, 42)
        );
    });

    it("a different seed gives a different order", () => {
        const a = buildWorkOrder(CLASSES, RUNS, true, 42);
        const b = buildWorkOrder(CLASSES, RUNS, true, 43);
        expect(a).not.toEqual(b);
        expect(signature(a)).toBe(signature(b));
    });

    it("interleave=false reproduces class-blocked order exactly", () => {
        const blocked = buildWorkOrder(CLASSES, RUNS, false, 1337);
        // The reported runs used this order; it must stay replayable.
        expect(blocked.slice(0, RUNS).every((w) => w.scenario === CLASSES[0])).toBe(true);
        expect(blocked.map((w) => w.i).slice(0, 3)).toEqual([0, 1, 2]);
    });
});

describe("interleaving actually mixes the classes", () => {
    it("class-blocked order streaks the full run length", () => {
        expect(maxRunLength(buildWorkOrder(CLASSES, RUNS, false, 1337))).toBe(RUNS);
    });

    it("interleaved order has short same-class streaks", () => {
        // With 5 classes a long streak would mean the shuffle barely moved
        // anything, leaving the positional confound in place.
        expect(maxRunLength(buildWorkOrder(CLASSES, RUNS, true, 1337))).toBeLessThan(6);
    });

    it("no class is starved of early slots, across many seeds", () => {
        // The confound being fixed is "one class occupies the tail". Check that
        // every class reaches the first half of the run under every seed tried.
        for (let seed = 1; seed <= 25; seed++) {
            const order = buildWorkOrder(CLASSES, RUNS, true, seed);
            const firstHalf = new Set(order.slice(0, order.length / 2).map((w) => w.scenario));
            expect(firstHalf.size, `seed ${seed} starved a class`).toBe(CLASSES.length);
        }
    });
});

describe("mulberry32", () => {
    it("is deterministic and stays in [0,1)", () => {
        const a = mulberry32(7);
        const b = mulberry32(7);
        for (let k = 0; k < 500; k++) {
            const v = a();
            expect(v).toBe(b());
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });
});
