/**
 * AutoOps AI — Issue order for an evaluation run (reviewer objection S6)
 *
 * THE PROBLEM THIS SOLVES
 * The reported held-out run issued incidents class-blocked: all 20 of one class
 * before starting the next. The provider's daily token quota runs out partway
 * through a 100-incident arm, so every lost incident landed on whichever class
 * happened to run last — 13 of 14 fell in `db_deadlock` alone. That class's
 * score therefore mixes a genuine class-level failure with starvation, and no
 * amount of analysis on the surviving records can separate the two.
 *
 * THE FIX
 * Issue the same set of (scenario, runIndex) pairs in a seeded random order.
 * Quota loss then falls across classes in expectation instead of by position,
 * which makes the missingness class-independent.
 *
 * WHAT THIS DOES NOT CHANGE
 * `runIndex` travels with its scenario, so an incident's content is untouched:
 * PAIRED seeding derives each incident's events from (scenario, runIndex), not
 * from its position in the run. Interleaving therefore reorders *when* each
 * incident is issued without altering *what* any incident is — the two runs
 * remain comparable incident-for-incident.
 *
 * Lives here rather than in the harness so it can be unit-tested; the harness
 * executes on import, which makes it unimportable from a test.
 */

export interface WorkItem {
    scenario: string;
    /** Run index within the scenario. Determines the incident's content. */
    i: number;
}

/** Seeded PRNG, same generator used for simulated failures and event content. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Build the issue order for `runsPerScenario` incidents of each scenario.
 *
 * `interleave: false` reproduces the class-blocked order the reported runs
 * used, so an old run can still be replicated exactly.
 */
export function buildWorkOrder(
    scenarios: readonly string[],
    runsPerScenario: number,
    interleave: boolean,
    seed: number
): WorkItem[] {
    const pairs: WorkItem[] = [];
    for (const scenario of scenarios) {
        for (let i = 0; i < runsPerScenario; i++) pairs.push({ scenario, i });
    }
    if (!interleave) return pairs;

    // Fisher-Yates over the full cross-product, so the result is a permutation
    // of exactly the same incidents — never a resample.
    const rnd = mulberry32(seed);
    for (let k = pairs.length - 1; k > 0; k--) {
        const j = Math.floor(rnd() * (k + 1));
        [pairs[k], pairs[j]] = [pairs[j], pairs[k]];
    }
    return pairs;
}

/**
 * Largest number of consecutive items belonging to one scenario. A
 * class-blocked order over c classes gives `runsPerScenario`; a well-mixed
 * order gives a small number. Reported by the harness so a run's own log
 * records how mixed its order actually was.
 */
export function maxRunLength(order: readonly WorkItem[]): number {
    let best = 0;
    let cur = 0;
    for (let k = 0; k < order.length; k++) {
        cur = k > 0 && order[k].scenario === order[k - 1].scenario ? cur + 1 : 1;
        if (cur > best) best = cur;
    }
    return best;
}
