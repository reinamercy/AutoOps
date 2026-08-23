/**
 * AutoOps AI — Kubernetes Client
 * Real @kubernetes/client-node calls for the subset of remediation actions
 * that map cleanly onto the K8s API: restart_service, scale_deployment,
 * update_resource_limits, verify_health. Everything else (rollback_deployment,
 * clear_disk_space, flush_connection_pool, apply_config, trigger_pipeline,
 * rolling_restart) stays simulated in execution.agent.ts — they're app-level/
 * CI concerns, not things a Deployment patch can express.
 *
 * Connects from local kubeconfig (KUBECONFIG env or ~/.kube/config) or
 * in-cluster config when running inside a pod. If neither is available,
 * isK8sAvailable() reports false and execution.agent.ts falls back to
 * simulation — same graceful-degradation pattern as the other backends.
 */
import * as k8s from "@kubernetes/client-node";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger("K8sClient");

let appsApi: k8s.AppsV1Api | null = null;

function getClient(): k8s.AppsV1Api | null {
    return appsApi;
}

export function isK8sAvailable(): boolean {
    return appsApi !== null;
}

/**
 * Load kubeconfig and probe the cluster once at startup. KubeConfig.loadFromDefault()
 * never throws — with no KUBECONFIG env, no ~/.kube/config, and no in-cluster
 * service account token, it silently falls back to a dummy http://localhost:8080
 * target instead of failing. A live API call is the only way to actually tell
 * whether a cluster is reachable.
 */
export async function initK8s(): Promise<void> {
    try {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const candidate = kc.makeApiClient(k8s.AppsV1Api);

        await Promise.race([
            candidate.listNamespacedDeployment({ namespace: "default", limit: 1 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Kubernetes API probe timeout")), 3000)),
        ]);

        appsApi = candidate;
        log.info({ context: kc.getCurrentContext() }, "✅ Kubernetes cluster reachable");
    } catch (err: unknown) {
        const error = err as Error;
        appsApi = null;
        log.warn({ error: error.message }, "⚠️ Kubernetes cluster unreachable — execution will fall back to simulation");
    }
}

export interface ActionResult {
    success: boolean;
    output: string;
}

/** dryRun:"All" is a genuine server-side dry run (K8s validates + would-apply without persisting), used for EXECUTION_MODE=shadow. */
function dryRunFlag(shadow: boolean): string | undefined {
    return shadow ? "All" : undefined;
}

export async function restartService(service: string, namespace: string, shadow: boolean): Promise<ActionResult> {
    const api = getClient();
    if (!api) return { success: false, output: "Kubernetes client not available" };

    try {
        // Read first: JSON Patch "add" on /annotations replaces the whole map, so we
        // must merge with whatever's already there rather than clobber it.
        const current = await api.readNamespacedDeployment({ name: service, namespace });
        const existingAnnotations = current.spec?.template?.metadata?.annotations || {};
        const mergedAnnotations = { ...existingAnnotations, "kubectl.kubernetes.io/restartedAt": new Date().toISOString() };

        const patch = [
            { op: "add", path: "/spec/template/metadata/annotations", value: mergedAnnotations },
        ];
        const result = await api.patchNamespacedDeployment(
            { name: service, namespace, body: patch, dryRun: dryRunFlag(shadow) }
        );
        const label = shadow ? "[DRY RUN] " : "";
        return {
            success: true,
            output: `${label}deployment.apps/${service} restarted (rollout-restart annotation applied)\ngeneration: ${result.metadata?.generation}`,
        };
    } catch (err: unknown) {
        const error = err as Error;
        return { success: false, output: `Error: restart_service failed — ${error.message}` };
    }
}

export async function scaleDeployment(
    service: string,
    namespace: string,
    replicas: number,
    shadow: boolean
): Promise<ActionResult> {
    const api = getClient();
    if (!api) return { success: false, output: "Kubernetes client not available" };

    try {
        // Deployment.spec.replicas always exists (defaults to 1), so "replace" is safe.
        const patch = [{ op: "replace", path: "/spec/replicas", value: replicas }];
        const result = await api.patchNamespacedDeployment(
            { name: service, namespace, body: patch, dryRun: dryRunFlag(shadow) }
        );
        const label = shadow ? "[DRY RUN] " : "";
        return {
            success: true,
            output: `${label}deployment.apps/${service} scaled\nreplicas: ${result.spec?.replicas}`,
        };
    } catch (err: unknown) {
        const error = err as Error;
        return { success: false, output: `Error: scale_deployment failed — ${error.message}` };
    }
}

export async function updateResourceLimits(
    service: string,
    namespace: string,
    memoryLimit: string | undefined,
    cpuLimit: string | undefined,
    shadow: boolean
): Promise<ActionResult> {
    const api = getClient();
    if (!api) return { success: false, output: "Kubernetes client not available" };

    try {
        // Read first: we need the first container's index/existing limits so we merge
        // rather than clobber (e.g. setting only memory shouldn't drop an existing cpu limit).
        const current = await api.readNamespacedDeployment({ name: service, namespace });
        const container = current.spec?.template?.spec?.containers?.[0];
        if (!container) {
            return { success: false, output: `Error: update_resource_limits — could not resolve a container for ${service}` };
        }

        const mergedLimits: Record<string, string> = { ...(container.resources?.limits || {}) };
        if (memoryLimit) mergedLimits.memory = memoryLimit;
        if (cpuLimit) mergedLimits.cpu = cpuLimit;

        const patch = [
            { op: "add", path: "/spec/template/spec/containers/0/resources/limits", value: mergedLimits },
        ];
        await api.patchNamespacedDeployment(
            { name: service, namespace, body: patch, dryRun: dryRunFlag(shadow) }
        );
        const label = shadow ? "[DRY RUN] " : "";
        return {
            success: true,
            output: `${label}deployment.apps/${service} configured\nlimits: ${JSON.stringify(mergedLimits)}\napplied to ${namespace}`,
        };
    } catch (err: unknown) {
        const error = err as Error;
        return { success: false, output: `Error: update_resource_limits failed — ${error.message}` };
    }
}

export async function verifyHealth(service: string, namespace: string): Promise<ActionResult> {
    const api = getClient();
    if (!api) return { success: false, output: "Kubernetes client not available" };

    try {
        const deployment = await api.readNamespacedDeployment({ name: service, namespace });
        const desired = deployment.spec?.replicas ?? 0;
        const ready = deployment.status?.readyReplicas ?? 0;
        const healthy = ready >= desired && desired > 0;
        return {
            success: healthy,
            output: `deployment.apps/${service}: ${ready}/${desired} replicas ready\n${healthy ? "healthy ✓" : "not yet healthy"}`,
        };
    } catch (err: unknown) {
        const error = err as Error;
        return { success: false, output: `Error: verify_health failed — ${error.message}` };
    }
}
