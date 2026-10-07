/**
 * AutoOps AI — Held-out scenario properties (task.md T5)
 *
 * The generalisation experiment (T8) compares the LLM/RAG arm against the
 * rule-based arm on incident classes that have no pre-written remediation.
 * That comparison is only valid if two properties hold for every held-out
 * scenario, and both are easy to break accidentally:
 *
 *   1. DETECTED — the incident must actually be raised, or there is nothing
 *      to plan for and the scenario silently drops out of the benchmark.
 *   2. UNCOVERED — no remediation template may match, or the scenario is not
 *      held out at all and the experiment measures nothing.
 *
 * These tests pin both.
 */
import { describe, it, expect } from "vitest";
import { generateEvents, HELD_OUT_SCENARIOS, COVERED_SCENARIOS } from "../../simulator/log-producer";
import { createIncidentState } from "../../orchestrator/state";
import { monitoringAgent } from "../../agents/monitoring.agent";
import { deriveMetricSignal } from "../../agents/planning.agent";
import { TemplateService } from "../../services/template.service";
import { IncidentContext } from "../../services/enterprise-types";

const templateService = new TemplateService();
const ANOMALY_THRESHOLD = 0.7;

describe("held-out scenarios are detected", () => {
    for (const scenario of HELD_OUT_SCENARIOS) {
        it(`${scenario} crosses the anomaly threshold and raises an incident`, async () => {
            const state = createIncidentState(generateEvents(scenario, 20, "payment-api"));
            const result = await monitoringAgent(state);

            expect(result.issue).toBeDefined();
            expect(result.issue!.anomalyScore).toBeGreaterThanOrEqual(ANOMALY_THRESHOLD);
            // The novel type must win primaryType — not the filler log_entry noise.
            expect(result.issue!.type).toBe(scenario);
        });
    }
});

describe("held-out scenarios have no remediation template", () => {
    for (const scenario of HELD_OUT_SCENARIOS) {
        it(`${scenario} finds no template (this is what makes it held out)`, async () => {
            const state = createIncidentState(generateEvents(scenario, 20, "payment-api"));
            const result = await monitoringAgent(state);
            expect(result.issue).toBeDefined();

            const events = result.rawEvents;
            const { metric, metricValue } = deriveMetricSignal(events);
            const rawReasons = events
                .map((e) => e.data?.reason as string | undefined)
                .filter(Boolean)
                .join(" ");

            // RCA has no rule for these classes, so the category falls through
            // to the generic "unknown" bucket — mirror that here.
            const ctx: IncidentContext = {
                id: state.incidentId,
                incidentType: result.issue!.type,
                errorSignature: `unknown ${rawReasons}`.trim(),
                severity: result.issue!.severity as IncidentContext["severity"],
                affectedService: result.issue!.affectedService,
                namespace: "production",
                podName: "payment-api-abc",
                deploymentName: "payment-api",
                metric,
                metricValue,
            };

            expect(templateService.findTemplate(ctx)).toBeNull();
        });
    }
});

describe("the covered six remain covered", () => {
    it("held-out and covered scenario sets are disjoint", () => {
        const overlap = (HELD_OUT_SCENARIOS as readonly string[]).filter((s) =>
            (COVERED_SCENARIOS as readonly string[]).includes(s)
        );
        expect(overlap).toEqual([]);
    });

    it("cpu_throttling does not leak into the cpu_spike template despite carrying cpuUsage", () => {
        // Throttling reports LOW cpu usage — that's the diagnostic signal.
        // If this ever exceeds 90 the scenario stops being held out.
        const { metric, metricValue } = deriveMetricSignal(
            generateEvents("cpu_throttling", 20, "payment-api")
        );
        expect(metric).toBe("cpu");
        expect(metricValue).toBeLessThan(90);
    });
});
