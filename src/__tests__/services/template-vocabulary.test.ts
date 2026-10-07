/**
 * AutoOps AI — Template action-vocabulary contract
 *
 * The Execution Agent dispatches on `step.action` via a switch; an unrecognised
 * name falls through to `default` and returns success:false, so a template step
 * whose action is outside the canonical taxonomy CANNOT run against a real
 * cluster. This was live: templates emitted "scale up", "rollback" and
 * "restart deployment", and the defect was masked because simulate mode ends
 * with `outputs[step.action] || "✓ … completed"` and reports success for any
 * action whatsoever.
 *
 * These tests pin the contract so the failure cannot return silently.
 */
import { describe, it, expect } from "vitest";
import { TemplateService } from "../../services/template.service";
import { IncidentContext } from "../../services/enterprise-types";

/** Actions the Execution Agent can actually dispatch. */
const CANONICAL_ACTIONS = new Set([
    "restart_service",
    "scale_deployment",
    "rolling_restart",
    "rollback_deployment",
    "update_resource_limits",
    "clear_disk_space",
    "flush_connection_pool",
    "apply_config",
    "verify_health",
    "trigger_pipeline",
]);

/**
 * Read-only inspections. They change nothing, so they cannot cause a bad
 * remediation — but they are the ONLY actions allowed outside the taxonomy.
 */
const DIAGNOSTIC_PREFIXES = ["check ", "describe "];

const isDiagnostic = (action: string) =>
    DIAGNOSTIC_PREFIXES.some((p) => action.startsWith(p));

/** Build a full context from the few fields that decide which template fires. */
function ctxFor(overrides: Partial<IncidentContext>): IncidentContext {
    return {
        id: "test",
        namespace: "production",
        podName: "svc-abc",
        deploymentName: "svc",
        affectedService: "svc",
        severity: "critical",
        incidentType: "pod_crash",
        errorSignature: "",
        ...overrides,
    } as IncidentContext;
}

/** Contexts chosen to make each template fire. */
const CONTEXTS: Array<[string, Partial<IncidentContext>]> = [
    ["tpl-pod-crashloopbackoff", { incidentType: "pod_crash", errorSignature: "CrashLoopBackOff" }],
    ["tpl-high-memory-pod", { incidentType: "pod_crash", errorSignature: "OOMKilled", metric: "memory", metricValue: 95 }],
    ["tpl-high-cpu-pod", { incidentType: "cpu_spike", errorSignature: "cpu", metric: "cpu", metricValue: 95 }],
    ["tpl-imagepullbackoff", { incidentType: "pod_crash", errorSignature: "ImagePullBackOff" }],
    ["tpl-service-no-endpoints", { incidentType: "service_down", errorSignature: "no endpoints" }],
];

describe("template steps use the executor's action vocabulary", () => {
    const svc = new TemplateService();

    for (const [label, ctx] of CONTEXTS) {
        it(`${label}: every state-changing step is dispatchable`, () => {
            const tpl = svc.findTemplate(ctxFor(ctx));
            expect(tpl, `${label} did not match its own context`).not.toBeNull();

            for (const step of tpl!.fixSteps) {
                if (isDiagnostic(step.action)) continue;
                expect(
                    CANONICAL_ACTIONS.has(step.action),
                    `"${step.action}" in ${label} is not dispatchable by the ` +
                    `Execution Agent — it would fail against a real cluster ` +
                    `while simulate mode reports success.`
                ).toBe(true);
            }
        });
    }

    it("the three previously-broken labels are gone everywhere", () => {
        const broken = ["scale up", "rollback", "restart deployment"];
        for (const [label, ctx] of CONTEXTS) {
            const tpl = svc.findTemplate(ctxFor(ctx));
            if (!tpl) continue;
            for (const step of tpl.fixSteps) {
                expect(broken, `${label} still emits "${step.action}"`)
                    .not.toContain(step.action);
            }
        }
    });

    it("every template step still carries an executable kubectl command", () => {
        for (const [, ctx] of CONTEXTS) {
            const tpl = svc.findTemplate(ctxFor(ctx));
            if (!tpl) continue;
            for (const step of tpl.fixSteps) {
                expect(step.command.length).toBeGreaterThan(0);
            }
        }
    });
});
