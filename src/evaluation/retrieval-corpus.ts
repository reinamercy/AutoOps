/**
 * AutoOps AI — Seed corpus for the retrieval ablation (reviewer objection R1)
 *
 * THE PROBLEM THIS SOLVES
 * The held-out experiment clears the vector store before every incident so an
 * incident cannot be served a fix learned from an earlier incident of the same
 * class. That is necessary — without it the experiment measures memorisation.
 * But it also empties the store completely, so the retrieval step returns
 * nothing: across all 146 planning calls in that run, the retrieved-context
 * count was zero every time. The experiment therefore measured a bare language
 * model, not retrieval-augmented planning, while the paper claimed the latter.
 *
 * THE FIX
 * Seed the store with resolved incidents drawn ONLY from the six COVERED
 * classes. Retrieval then has genuine operational history to draw on, exactly
 * as a deployed system would after weeks of use, while containing nothing about
 * any held-out class — so there is no same-class leakage. Comparing this
 * condition against an empty store isolates what retrieval contributes.
 *
 * The corpus is fixed and hand-written rather than harvested from a previous
 * run, so the ablation is deterministic and does not depend on run order.
 */

export interface SeedIncident {
    id: string;
    /** The text that gets embedded and retrieved. */
    description: string;
    metadata: Record<string, unknown>;
}

/**
 * Twelve resolved incidents, two per covered class. Wording mirrors what the
 * Feedback agent actually persists: the incident type, the affected service,
 * the diagnosed cause and the remediation that worked.
 */
export const RETRIEVAL_SEED_CORPUS: SeedIncident[] = [
    {
        id: "seed-oom-1",
        description:
            "pod_crash in payment-api: container OOMKilled with exit code 137, memory usage 502Mi against a 512Mi limit. " +
            "Root cause memory_leak. Resolved by update_resource_limits raising the memory limit to 1Gi, then verify_health.",
        metadata: { incidentType: "pod_crash", service: "payment-api", outcome: "resolved", category: "memory_leak" },
    },
    {
        id: "seed-oom-2",
        description:
            "pod_crash in order-service: repeated OOMKilled restarts, restartCount 7. Root cause memory_leak. " +
            "Resolved by rolling_restart followed by update_resource_limits and verify_health.",
        metadata: { incidentType: "pod_crash", service: "order-service", outcome: "resolved", category: "memory_leak" },
    },
    {
        id: "seed-err-1",
        description:
            "error_spike in order-service: HTTP 500 error rate 0.31 on /api/orders following a deployment. " +
            "Root cause deployment_regression. Resolved by rollback_deployment to the previous revision, then verify_health.",
        metadata: { incidentType: "error_spike", service: "order-service", outcome: "resolved", category: "deployment_regression" },
    },
    {
        id: "seed-err-2",
        description:
            "error_spike in api-gateway: 502 responses from upstream, error rate 0.22. Root cause deployment_regression. " +
            "Resolved by rollback_deployment and verify_health.",
        metadata: { incidentType: "error_spike", service: "api-gateway", outcome: "resolved", category: "deployment_regression" },
    },
    {
        id: "seed-cpu-1",
        description:
            "cpu_spike in auth-service: sustained cpuUsage 96% across replicas. Root cause resource_exhaustion. " +
            "Resolved by scale_deployment to 6 replicas and verify_health.",
        metadata: { incidentType: "cpu_spike", service: "auth-service", outcome: "resolved", category: "resource_exhaustion" },
    },
    {
        id: "seed-cpu-2",
        description:
            "cpu_spike in notification-service: cpuUsage 93% with request latency climbing. Root cause resource_exhaustion. " +
            "Resolved by update_resource_limits raising the CPU limit, then verify_health.",
        metadata: { incidentType: "cpu_spike", service: "notification-service", outcome: "resolved", category: "resource_exhaustion" },
    },
    {
        id: "seed-disk-1",
        description:
            "disk_full in payment-api: diskUsage 97% on /var/log, writes failing. " +
            "Resolved by clear_disk_space removing rotated logs and temp files, freeing 13GB, then verify_health.",
        metadata: { incidentType: "disk_full", service: "payment-api", outcome: "resolved", category: "resource_exhaustion" },
    },
    {
        id: "seed-disk-2",
        description:
            "disk_full in user-service: diskUsage 96%, volume nearly exhausted. " +
            "Resolved by clear_disk_space and verify_health. Scaling replicas was explicitly not effective here.",
        metadata: { incidentType: "disk_full", service: "user-service", outcome: "resolved", category: "resource_exhaustion" },
    },
    {
        id: "seed-pool-1",
        description:
            "connection_pool_exhaustion in auth-service: poolUsage 98%, 95 of 100 connections active, requests queuing. " +
            "Resolved by flush_connection_pool recycling idle connections, then verify_health.",
        metadata: { incidentType: "connection_pool_exhaustion", service: "auth-service", outcome: "resolved", category: "resource_exhaustion" },
    },
    {
        id: "seed-pool-2",
        description:
            "connection_pool_exhaustion in payment-api: pool saturated against the database. " +
            "Resolved by flush_connection_pool and scale_deployment to spread load, then verify_health.",
        metadata: { incidentType: "connection_pool_exhaustion", service: "payment-api", outcome: "resolved", category: "resource_exhaustion" },
    },
    {
        id: "seed-down-1",
        description:
            "service_down in api-gateway: health checks failing, status down, 10 consecutive failures. " +
            "Root cause service_failure. Resolved by restart_service and verify_health.",
        metadata: { incidentType: "service_down", service: "api-gateway", outcome: "resolved", category: "service_failure" },
    },
    {
        id: "seed-down-2",
        description:
            "service_down in user-service: no endpoints ready, connection refused on /health. " +
            "Root cause service_failure. Resolved by rolling_restart of the deployment, then verify_health.",
        metadata: { incidentType: "service_down", service: "user-service", outcome: "resolved", category: "service_failure" },
    },
];

/** Guard: the corpus must never mention a held-out class, or retrieval leaks. */
export const HELD_OUT_TOKENS = [
    "cert_expiry",
    "certificate",
    "tls",
    "dns_failure",
    "nxdomain",
    "resolver",
    "config_drift",
    "drift",
    "cpu_throttling",
    "throttl",
    "db_deadlock",
    "deadlock",
];
