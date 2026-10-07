/**
 * AutoOps AI — Template Service
 * Deterministic, pre-validated fix templates for common DevOps incidents.
 * These templates reduce LLM dependency by up to 70% and are far more
 * reliable than LLM-generated fixes.
 *
 * Templates are checked FIRST in the planning pipeline, before memory
 * and before Groq LLM.
 *
 * ACTION VOCABULARY CONTRACT — do not break this.
 * Every step that CHANGES cluster state must use an action name the Execution
 * Agent dispatches on: restart_service, scale_deployment, rolling_restart,
 * rollback_deployment, update_resource_limits, clear_disk_space,
 * flush_connection_pool, apply_config, verify_health, trigger_pipeline.
 *
 * These steps originally carried free-text labels ("scale up", "rollback",
 * "restart deployment") alongside their kubectl command. That reads well but
 * breaks execution: `runK8sAction` switches on `step.action`, so an unrecognised
 * name falls to `default` and returns success:false — meaning template plans
 * could not execute against a real cluster at all. The defect stayed invisible
 * because simulate mode ends with `outputs[step.action] || "✓ … completed"` and
 * reports success:true for ANY action, so unknown steps were rubber-stamped.
 * The tier with the highest trust (confidence 0.95, −25 risk discount, capped
 * at `notify` so it needs the least human oversight) was therefore the tier
 * producing the least executable plans.
 *
 * Read-only diagnostic steps (`kubectl describe/get/top/logs`) keep their
 * descriptive labels: they mutate nothing, and there is no canonical action for
 * "inspect". They still hit the executor's default branch — see task.md.
 */
import { createChildLogger } from "../utils/logger";
import { FixStep, IncidentContext, TemplateFix } from "./enterprise-types";

const log = createChildLogger("TemplateService");

// ── Template Definitions ──

interface TemplateDefinition {
    templateId: string;
    name: string;
    match: (incident: IncidentContext) => boolean;
    buildSteps: (incident: IncidentContext) => FixStep[];
    blastRadius: number;
    hasRollbackPlan: boolean;
}

const TEMPLATES: TemplateDefinition[] = [
    // Template 1 — pod-crashloopbackoff
    {
        templateId: "tpl-pod-crashloopbackoff",
        name: "Pod CrashLoopBackOff Recovery",
        match: (inc) =>
            inc.incidentType === "pod_crash" &&
            (inc.errorSignature.includes("CrashLoopBackOff") ||
             inc.errorSignature.includes("crashloop") ||
             inc.errorSignature.includes("application_crash")),
        buildSteps: (inc) => [
            {
                action: "describe pod",
                command: `kubectl describe pod ${inc.podName || "affected-pod"} -n ${inc.namespace || "default"}`,
                description: "Inspect pod events and status",
                estimatedDurationSec: 10,
            },
            {
                action: "check logs",
                command: `kubectl logs ${inc.podName || "affected-pod"} -n ${inc.namespace || "default"} --previous`,
                description: "Check previous container logs for crash reason",
                estimatedDurationSec: 10,
            },
            {
                action: "rolling_restart",
                command: `kubectl rollout restart deployment/${inc.deploymentName || inc.affectedService} -n ${inc.namespace || "default"}`,
                description: "Rolling restart the deployment",
                estimatedDurationSec: 60,
                rollbackCommand: `kubectl rollout undo deployment/${inc.deploymentName || inc.affectedService} -n ${inc.namespace || "default"}`,
            },
        ],
        blastRadius: 2,
        hasRollbackPlan: true,
    },

    // Template 2 — high-memory-pod
    {
        templateId: "tpl-high-memory-pod",
        name: "High Memory Usage Pod Scaling",
        // Matches the incident types the Monitoring agent actually emits for
        // memory pressure (pod_crash/oom_killed), plus the generic
        // resource_pressure label. Previously required resource_pressure
        // alone, which the detector never produces — the template was
        // unreachable.
        match: (inc) =>
            (inc.incidentType === "resource_pressure" ||
                inc.incidentType === "pod_crash" ||
                inc.incidentType === "oom_killed") &&
            inc.metric === "memory" &&
            inc.metricValue !== undefined &&
            inc.metricValue > 85,
        buildSteps: (inc) => {
            const currentReplicas = 3; // Default assumption
            return [
                {
                    action: "check memory",
                    command: `kubectl top pod -n ${inc.namespace || "default"} --sort-by=memory`,
                    description: "Check current memory usage across pods",
                    estimatedDurationSec: 10,
                },
                {
                    action: "scale_deployment",
                    command: `kubectl scale deployment/${inc.deploymentName || inc.affectedService} --replicas=${currentReplicas + 1} -n ${inc.namespace || "default"}`,
                    description: "Scale up deployment to distribute memory load",
                    estimatedDurationSec: 30,
                    rollbackCommand: `kubectl scale deployment/${inc.deploymentName || inc.affectedService} --replicas=${currentReplicas} -n ${inc.namespace || "default"}`,
                },
            ];
        },
        blastRadius: 1,
        hasRollbackPlan: true,
    },

    // Template 3 — high-cpu-pod
    {
        templateId: "tpl-high-cpu-pod",
        name: "High CPU Usage Pod Recovery",
        // As above: cpu_spike is the type the detector emits. Threshold is
        // >= 90 to match the detector's own cpu_spike pattern (minValue 90),
        // which fires at exactly 90.
        match: (inc) =>
            (inc.incidentType === "resource_pressure" || inc.incidentType === "cpu_spike") &&
            inc.metric === "cpu" &&
            inc.metricValue !== undefined &&
            inc.metricValue >= 90,
        buildSteps: (inc) => {
            const currentReplicas = 3;
            return [
                {
                    action: "check cpu",
                    command: `kubectl top pod -n ${inc.namespace || "default"} --sort-by=cpu`,
                    description: "Check current CPU usage across pods",
                    estimatedDurationSec: 10,
                },
                {
                    action: "check hpa",
                    command: `kubectl get hpa -n ${inc.namespace || "default"}`,
                    description: "Check if HPA is configured and responding",
                    estimatedDurationSec: 10,
                },
                {
                    action: "scale_deployment",
                    command: `kubectl scale deployment/${inc.deploymentName || inc.affectedService} --replicas=${currentReplicas + 2} -n ${inc.namespace || "default"}`,
                    description: "Scale up deployment to handle CPU load",
                    estimatedDurationSec: 30,
                    rollbackCommand: `kubectl scale deployment/${inc.deploymentName || inc.affectedService} --replicas=${currentReplicas} -n ${inc.namespace || "default"}`,
                },
            ];
        },
        blastRadius: 1,
        hasRollbackPlan: true,
    },

    // Template 4 — deployment-imagepullbackoff
    {
        templateId: "tpl-imagepullbackoff",
        name: "ImagePullBackOff Recovery",
        match: (inc) =>
            inc.errorSignature.includes("ImagePullBackOff") ||
            inc.errorSignature.includes("ErrImagePull"),
        buildSteps: (inc) => [
            {
                action: "check image",
                command: `kubectl describe pod ${inc.podName || "affected-pod"} -n ${inc.namespace || "default"}`,
                description: "Inspect pod to identify image pull failure reason",
                estimatedDurationSec: 10,
            },
            {
                action: "rollback_deployment",
                command: `kubectl rollout undo deployment/${inc.deploymentName || inc.affectedService} -n ${inc.namespace || "default"}`,
                description: "Rollback to the previous working image",
                estimatedDurationSec: 60,
            },
        ],
        blastRadius: 2,
        hasRollbackPlan: true,
    },

    // Template 5 — service-endpoints-not-ready
    {
        templateId: "tpl-service-no-endpoints",
        name: "Service Endpoints Not Ready",
        match: (inc) =>
            inc.incidentType === "service_unavailable" ||
            inc.incidentType === "service_down",
        buildSteps: (inc) => [
            {
                action: "check endpoints",
                command: `kubectl get endpoints ${inc.affectedService} -n ${inc.namespace || "default"}`,
                description: "Check if service has healthy endpoints",
                estimatedDurationSec: 10,
            },
            {
                action: "describe service",
                command: `kubectl describe svc ${inc.affectedService} -n ${inc.namespace || "default"}`,
                description: "Inspect service configuration and selectors",
                estimatedDurationSec: 10,
            },
            {
                action: "rolling_restart",
                command: `kubectl rollout restart deployment/${inc.deploymentName || inc.affectedService} -n ${inc.namespace || "default"}`,
                description: "Restart deployment to register new endpoints",
                estimatedDurationSec: 60,
                rollbackCommand: `kubectl rollout undo deployment/${inc.deploymentName || inc.affectedService} -n ${inc.namespace || "default"}`,
            },
        ],
        blastRadius: 2,
        hasRollbackPlan: true,
    },

    // Template 6 — pvc-not-bound
    {
        templateId: "tpl-pvc-not-bound",
        name: "PVC Not Bound Recovery",
        match: (inc) =>
            inc.errorSignature.includes("Pending") &&
            inc.resourceType === "PVC",
        buildSteps: (inc) => [
            {
                action: "describe pvc",
                command: `kubectl describe pvc -n ${inc.namespace || "default"}`,
                description: "Inspect PVC status and events",
                estimatedDurationSec: 10,
            },
            {
                action: "check storage class",
                command: `kubectl get storageclass`,
                description: "Verify available storage classes",
                estimatedDurationSec: 10,
            },
        ],
        blastRadius: 1,
        hasRollbackPlan: false,
    },
];

// ── Template Service ──

export class TemplateService {
    /**
     * Find a matching template for the given incident context.
     * Returns null if no template matches.
     */
    findTemplate(incident: IncidentContext): TemplateFix | null {
        for (const template of TEMPLATES) {
            try {
                if (template.match(incident)) {
                    const fixSteps = template.buildSteps(incident);

                    log.info(
                        {
                            templateId: template.templateId,
                            incidentType: incident.incidentType,
                            service: incident.affectedService,
                        },
                        `Template matched: ${template.name}`
                    );

                    return {
                        templateId: template.templateId,
                        name: template.name,
                        fixSteps,
                        confidence: 0.95, // Templates are pre-validated
                        blastRadius: template.blastRadius,
                        hasRollbackPlan: template.hasRollbackPlan,
                    };
                }
            } catch (err: unknown) {
                const error = err as Error;
                log.warn(
                    { templateId: template.templateId, error: error.message },
                    "Template match evaluation failed"
                );
            }
        }

        log.info(
            { incidentType: incident.incidentType },
            "No template matched"
        );
        return null;
    }
}
