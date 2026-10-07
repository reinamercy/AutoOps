/**
 * AutoOps AI — Scenario labelling (task.md BL-1)
 *
 * Every row of the paper's per-scenario results table is keyed on the incident
 * type the Monitoring Agent assigns. If a generator emits an event type that
 * outranks its own primary signal, the incident is silently filed under the
 * wrong label and the corresponding table row is wrong.
 *
 * This is not hypothetical: `service_down` used to emit 70% `pod_crash` filler,
 * and because `primaryType` resolves by PRIORITY (a chain of `.find()` calls
 * headed by `pod_crash`) rather than by majority, a single such event was
 * enough to relabel the whole incident. Every `service_down` row in the
 * benchmark was actually a `pod_crash`.
 *
 * These tests pin the label each generator is supposed to produce.
 */
import { describe, it, expect } from "vitest";
import { generateEvents, COVERED_SCENARIOS } from "../../simulator/log-producer";
import { createIncidentState } from "../../orchestrator/state";
import { monitoringAgent } from "../../agents/monitoring.agent";

/**
 * The incident type each covered scenario must resolve to. Where this differs
 * from the scenario name it reflects a deliberate modelling choice, not a bug:
 * an OOM kill IS observed as a crashing pod, and an error-rate spike IS an
 * error spike — the distinguishing signal is carried in the event `data`,
 * which is what the template predicates key on.
 */
const EXPECTED_TYPE: Record<string, string> = {
    oom_kill: "pod_crash",
    high_error_rate: "error_spike",
    cpu_spike: "cpu_spike",
    disk_full: "disk_full",
    connection_pool_exhaustion: "connection_pool_exhaustion",
    service_down: "service_down",
};

describe("covered scenarios are labelled with the fault that was injected", () => {
    for (const scenario of COVERED_SCENARIOS) {
        it(`${scenario} → issue.type === "${EXPECTED_TYPE[scenario]}"`, async () => {
            const state = createIncidentState(generateEvents(scenario, 20, "payment-api"));
            const result = await monitoringAgent(state);

            expect(result.issue, `${scenario} raised no incident at all`).toBeDefined();
            expect(result.issue!.type).toBe(EXPECTED_TYPE[scenario]);
        });
    }

    it("service_down emits no pod_crash events, which would outrank it", () => {
        // Guards the exact regression: primaryType is priority-based, so even
        // ONE pod_crash event here silently relabels the incident.
        const events = generateEvents("service_down", 20, "payment-api");
        expect(events.filter((e) => e.eventType === "pod_crash")).toEqual([]);
        expect(events.some((e) => e.eventType === "service_down")).toBe(true);
    });

    it("every covered scenario has a declared expected type", () => {
        for (const s of COVERED_SCENARIOS) {
            expect(EXPECTED_TYPE[s], `no expected type declared for ${s}`).toBeDefined();
        }
    });
});
