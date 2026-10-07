/**
 * AutoOps AI — Plan-source reachability tests
 *
 * Guards the integration bug documented in task.md (B3): the template tier of
 * the four-stage planning chain was unreachable for every resource-pressure
 * incident, because the Planning agent never populated the metric/metricValue
 * pair the templates match on. The symptom was that `template` never appeared
 * as a plan source across a 102-incident benchmark.
 *
 * These tests run the real generator output through the real metric-derivation
 * and the real template matcher — the exact path the agent takes, minus the
 * orchestrator plumbing.
 */
import { describe, it, expect } from "vitest";
import { generateEvents } from "../../simulator/log-producer";
import { deriveMetricSignal } from "../../agents/planning.agent";
import { TemplateService } from "../../services/template.service";
import { IncidentContext } from "../../services/enterprise-types";

const templateService = new TemplateService();

/** Mirrors the context the Planning agent builds (planning.agent.ts). */
function contextFor(
    scenario: Parameters<typeof generateEvents>[0],
    incidentType: string,
    rootCauseCategory: string
): IncidentContext {
    const events = generateEvents(scenario, 20, "payment-api");
    const rawReasons = events
        .map((e) => e.data?.reason as string | undefined)
        .filter(Boolean)
        .join(" ");
    const { metric, metricValue } = deriveMetricSignal(events);

    return {
        id: "inc-test",
        incidentType,
        errorSignature: `${rootCauseCategory} ${rawReasons}`.trim(),
        severity: "critical",
        affectedService: "payment-api",
        namespace: "production",
        podName: "payment-api-abc",
        deploymentName: "payment-api",
        metric,
        metricValue,
    };
}

describe("deriveMetricSignal", () => {
    it("extracts cpu utilisation from real cpu_spike events", () => {
        const { metric, metricValue } = deriveMetricSignal(
            generateEvents("cpu_spike", 20, "payment-api")
        );
        expect(metric).toBe("cpu");
        expect(metricValue).toBeGreaterThanOrEqual(90);
    });

    it("extracts disk utilisation from real disk_full events", () => {
        const { metric, metricValue } = deriveMetricSignal(
            generateEvents("disk_full", 20, "payment-api")
        );
        expect(metric).toBe("disk");
        expect(metricValue).toBeGreaterThanOrEqual(95);
    });

    it("extracts pool utilisation from real connection-pool events", () => {
        const { metric, metricValue } = deriveMetricSignal(
            generateEvents("connection_pool_exhaustion", 20, "payment-api")
        );
        expect(metric).toBe("connection_pool");
        expect(metricValue).toBeGreaterThanOrEqual(90);
    });

    it("computes memory percentage from K8s quantity strings on OOM events", () => {
        const { metric, metricValue } = deriveMetricSignal(
            generateEvents("oom_kill", 20, "payment-api")
        );
        expect(metric).toBe("memory");
        // generator emits 490-511Mi against a 512Mi limit
        expect(metricValue).toBeGreaterThan(85);
        expect(metricValue).toBeLessThanOrEqual(100);
    });

    it("returns an empty signal when no metric-bearing event is present", () => {
        expect(deriveMetricSignal([])).toEqual({});
    });
});

describe("template reachability on real generator output", () => {
    it("cpu_spike reaches the template tier (was unreachable)", () => {
        const ctx = contextFor("cpu_spike", "cpu_spike", "resource_exhaustion");
        const result = templateService.findTemplate(ctx);
        expect(result).not.toBeNull();
        expect(result!.templateId).toBe("tpl-high-cpu-pod");
    });

    it("oom_kill reaches the template tier (was unreachable)", () => {
        const ctx = contextFor("oom_kill", "pod_crash", "memory_leak");
        const result = templateService.findTemplate(ctx);
        expect(result).not.toBeNull();
        expect(result!.templateId).toBe("tpl-high-memory-pod");
    });
});
