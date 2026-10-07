/**
 * AutoOps AI — Seeded event determinism (task.md T11)
 *
 * McNemar's test compares two arms on the SAME inputs. If each arm generates
 * its own randomised events the data is unpaired and McNemar does not apply —
 * which was exactly the state of the T8 run. These tests prove that a seed
 * yields byte-identical event batches, so the harness can hand both arms
 * matched inputs and the paired test becomes legitimate.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
    generateEvents,
    setEventSeed,
    COVERED_SCENARIOS,
    HELD_OUT_SCENARIOS,
} from "../../simulator/log-producer";

afterEach(() => setEventSeed(null));

const ALL = [...COVERED_SCENARIOS, ...HELD_OUT_SCENARIOS];

describe("seeded generation is byte-identical", () => {
    for (const scenario of ALL) {
        it(`${scenario}: same seed → identical payload`, () => {
            setEventSeed(12345);
            const a = generateEvents(scenario, 20);
            setEventSeed(12345);
            const b = generateEvents(scenario, 20);

            // Full structural equality, including eventId and timestamp —
            // anything less and the two arms are not truly paired.
            expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        });
    }

    it("different seeds produce different payloads", () => {
        setEventSeed(1);
        const a = generateEvents("cert_expiry", 20);
        setEventSeed(2);
        const b = generateEvents("cert_expiry", 20);
        expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    });

    it("the target service is itself seed-determined", () => {
        // If the service differed between arms the incidents would not be
        // comparable even with identical event data.
        setEventSeed(999);
        const a = generateEvents("oom_kill", 20);
        setEventSeed(999);
        const b = generateEvents("oom_kill", 20);
        expect(a[0].source.service).toBe(b[0].source.service);
    });
});

describe("unseeded generation stays random", () => {
    it("two unseeded batches differ", () => {
        setEventSeed(null);
        const a = generateEvents("oom_kill", 20);
        const b = generateEvents("oom_kill", 20);
        // Guards against the seeding change accidentally freezing production
        // and demo behaviour.
        expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    });

    it("unseeded event ids remain uuid-shaped", () => {
        setEventSeed(null);
        const [e] = generateEvents("oom_kill", 20);
        expect(e.eventId).toMatch(/^evt-[0-9a-f]{8}$/);
    });
});

describe("seeding does not change incident semantics", () => {
    it("seeded held-out events still carry their detection signal", () => {
        setEventSeed(4242);
        const events = generateEvents("db_deadlock", 20);
        expect(events.some((e) => e.eventType === "db_deadlock")).toBe(true);
        expect(
            events.some((e) => typeof e.data.deadlockCount === "number" && e.data.deadlockCount >= 3)
        ).toBe(true);
    });

    it("seeded service_down still emits no pod_crash (BL-1)", () => {
        setEventSeed(7);
        const events = generateEvents("service_down", 20);
        expect(events.filter((e) => e.eventType === "pod_crash")).toEqual([]);
    });
});
