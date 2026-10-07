/**
 * AutoOps AI — Log Simulator / Producer
 * Generates realistic log events and publishes to Kafka or directly to pipeline.
 */
import { v4 as uuidv4 } from "uuid";
import { RawEvent } from "../orchestrator/state";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger("Simulator");

/**
 * Deterministic event generation (task.md T11).
 *
 * McNemar's test compares two arms on the SAME inputs; with independently
 * randomised events per arm the data is unpaired and McNemar is simply not
 * applicable. Seeding the generator lets the evaluation harness hand both arms
 * byte-identical event batches, so each incident becomes a matched pair.
 *
 * Unseeded (the default, and all production/demo use) this is exactly
 * `Math.random()`, so nothing outside the harness changes behaviour.
 */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

let seededRng: (() => number) | null = null;

/** Seed (or, with null, unseed) the generator. Harness-only. */
export function setEventSeed(seed: number | null): void {
    seededRng = seed === null ? null : mulberry32(seed);
}

/** Replaces Math.random() throughout this module. */
function rnd(): number {
    return seededRng ? seededRng() : Math.random();
}

/**
 * Event ids must also be deterministic under a seed, or two arms given the
 * same seed still produce different payloads.
 */
function eventId(): string {
    if (!seededRng) return `evt-${uuidv4().slice(0, 8)}`;
    return `evt-${Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, "0")}`;
}

/**
 * Wall-clock time is the last source of divergence: two arms run minutes apart
 * would otherwise produce different timestamps from the same seed. Under a seed
 * we anchor to a fixed epoch so payloads are byte-identical. Relative spacing
 * is preserved either way, which is what the Monitoring Agent's
 * rapid-succession rule actually depends on.
 */
const SEEDED_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

function nowMs(): number {
    return seededRng ? SEEDED_EPOCH_MS : Date.now();
}

const SERVICES = [
    "payment-api", "auth-service", "user-service",
    "order-service", "notification-service", "api-gateway",
];

const NAMESPACES = ["production", "staging"];

/**
 * The six scenarios the original benchmark (paper Table III) is built from.
 * Every one is covered by either a remediation template or a category-specific
 * hardcoded fallback plan.
 */
export const COVERED_SCENARIOS = [
    "oom_kill",
    "high_error_rate",
    "cpu_spike",
    "disk_full",
    "connection_pool_exhaustion",
    "service_down",
] as const;

/**
 * Held-out incident types for the generalisation experiment.
 *
 * These deliberately have NO matching remediation template and NO seeded
 * memory entry, and their RCA category falls through to the generic
 * "unknown" bucket — so the rule-based arm (BASELINE_MODE) can only answer
 * them with the `default` fallback plan (restart_service + verify_health),
 * which is wrong for all five. The LLM/RAG arm is the only path that can
 * produce a correct plan.
 *
 * IMPORTANT — what is and isn't held out: these types DO have detection
 * signatures (see monitoring.agent.ts). Detection coverage and remediation
 * coverage are separate things: a real operations team routinely monitors an
 * incident class it has no runbook for. Holding out detection as well would
 * mean the incident is never raised at all and there would be nothing to
 * compare. The signatures are identical for both arms, so they cannot bias
 * the comparison.
 */
export const HELD_OUT_SCENARIOS = [
    "cert_expiry",
    "dns_failure",
    "config_drift",
    "cpu_throttling",
    "db_deadlock",
] as const;

type Scenario =
    | (typeof COVERED_SCENARIOS)[number]
    | (typeof HELD_OUT_SCENARIOS)[number]
    | "random";

/**
 * Generate a batch of events for a given scenario.
 */
export function generateEvents(
    scenario: Scenario = "random",
    count: number = 20,
    targetService?: string
): RawEvent[] {
    const service = targetService || SERVICES[Math.floor(rnd() * SERVICES.length)];
    const generators: Record<Scenario, () => RawEvent[]> = {
        oom_kill: () => generateOOMKillEvents(service, count),
        high_error_rate: () => generateErrorRateEvents(service, count),
        cpu_spike: () => generateCPUSpikeEvents(service, count),
        disk_full: () => generateDiskFullEvents(service, count),
        connection_pool_exhaustion: () => generateConnectionPoolEvents(service, count),
        service_down: () => generateServiceDownEvents(service, count),
        cert_expiry: () => generateCertExpiryEvents(service, count),
        dns_failure: () => generateDnsFailureEvents(service, count),
        config_drift: () => generateConfigDriftEvents(service, count),
        cpu_throttling: () => generateCpuThrottlingEvents(service, count),
        db_deadlock: () => generateDeadlockEvents(service, count),
        random: () => generateRandomEvents(count),
    };

    const events = generators[scenario]();
    log.info({ scenario, count: events.length, service }, "Events generated");
    return events;
}

function baseEvent(service: string, overrides: Partial<RawEvent> = {}): RawEvent {
    return {
        eventId: eventId(),
        timestamp: new Date(nowMs() - rnd() * 60000).toISOString(),
        source: {
            type: "kubernetes",
            service,
            namespace: "production",
            pod: `${service}-${rnd().toString(36).slice(2, 8)}`,
        },
        eventType: "unknown",
        severity: "medium",
        data: {},
        ...overrides,
    };
}

function generateOOMKillEvents(service: string, count: number): RawEvent[] {
    const events: RawEvent[] = [];
    // Main OOMKill events
    for (let i = 0; i < Math.ceil(count * 0.4); i++) {
        events.push(baseEvent(service, {
            eventType: "pod_crash",
            severity: "critical",
            data: {
                reason: "OOMKilled",
                exitCode: 137,
                restartCount: 3 + Math.floor(rnd() * 8),
                memoryLimit: "512Mi",
                memoryUsage: `${490 + Math.floor(rnd() * 22)}Mi`,
            },
        }));
    }
    // Supporting metric events
    for (let i = 0; i < Math.ceil(count * 0.3); i++) {
        events.push(baseEvent(service, {
            eventType: "metric_alert",
            severity: "high",
            data: {
                metric: "container_memory_usage_bytes",
                value: 500 + Math.floor(rnd() * 50),
                threshold: 480,
                unit: "Mi",
            },
        }));
    }
    // Noise events
    for (let i = 0; i < count - events.length; i++) {
        events.push(baseEvent(service, {
            eventType: "log_entry",
            severity: "info",
            data: { message: "Request processed", latency: rnd() * 200 },
        }));
    }
    return events;
}

function generateErrorRateEvents(service: string, count: number): RawEvent[] {
    const events: RawEvent[] = [];
    for (let i = 0; i < Math.ceil(count * 0.5); i++) {
        events.push(baseEvent(service, {
            eventType: "error_spike",
            severity: "high",
            data: {
                errorRate: 0.15 + rnd() * 0.3,
                statusCode: [500, 502, 503][Math.floor(rnd() * 3)],
                endpoint: ["/api/payments", "/api/orders", "/api/users"][Math.floor(rnd() * 3)],
                errorCount: 50 + Math.floor(rnd() * 200),
            },
        }));
    }
    for (let i = events.length; i < count; i++) {
        events.push(baseEvent(service, {
            eventType: "log_entry",
            severity: "medium",
            data: { message: "HTTP 5xx error", statusCode: 500 },
        }));
    }
    return events;
}

function generateCPUSpikeEvents(service: string, count: number): RawEvent[] {
    const events: RawEvent[] = [];
    for (let i = 0; i < Math.ceil(count * 0.4); i++) {
        events.push(baseEvent(service, {
            eventType: "cpu_spike",
            severity: "high",
            data: {
                cpuUsage: 90 + Math.floor(rnd() * 10),
                cpuLimit: "1000m",
                throttlingPercent: 20 + Math.floor(rnd() * 40),
            },
        }));
    }
    for (let i = events.length; i < count; i++) {
        events.push(baseEvent(service, {
            eventType: "metric_alert",
            severity: "medium",
            data: { metric: "cpu_usage", value: 85 + rnd() * 15 },
        }));
    }
    return events;
}

function generateDiskFullEvents(service: string, count: number): RawEvent[] {
    const events: RawEvent[] = [];
    for (let i = 0; i < Math.ceil(count * 0.3); i++) {
        events.push(baseEvent(service, {
            eventType: "disk_full",
            severity: "critical",
            data: { diskUsage: 95 + Math.floor(rnd() * 5), volume: "/var/log", totalGB: 100, freeGB: 2 },
        }));
    }
    for (let i = events.length; i < count; i++) {
        events.push(baseEvent(service, {
            eventType: "log_entry",
            severity: "medium",
            data: { message: "Disk space warning" },
        }));
    }
    return events;
}

function generateConnectionPoolEvents(service: string, count: number): RawEvent[] {
    const events: RawEvent[] = [];
    for (let i = 0; i < Math.ceil(count * 0.4); i++) {
        events.push(baseEvent(service, {
            eventType: "connection_pool_exhaustion",
            severity: "high",
            data: { poolUsage: 90 + Math.floor(rnd() * 10), maxConnections: 100, activeConnections: 95 },
        }));
    }
    for (let i = events.length; i < count; i++) {
        events.push(baseEvent(service, {
            eventType: "metric_alert",
            severity: "medium",
            data: { metric: "db_pool_active", value: 90 + rnd() * 10 },
        }));
    }
    return events;
}

/**
 * A total service outage, observed as failing health checks.
 *
 * The filler events are deliberately `log_entry`, not `pod_crash` (task.md
 * BL-1). `monitoringAgent`'s `primaryType` resolves by PRIORITY, not majority —
 * it is a chain of `.find()` calls headed by `pod_crash` — so a single
 * `pod_crash` event anywhere in the batch relabels the whole incident as
 * `pod_crash`, whatever the proportions. The previous version emitted 70%
 * `pod_crash` filler, so every `service_down` incident in the benchmark was
 * recorded as `pod_crash`: one of the six rows in the paper's Table III was
 * mislabelled, and the documented `service_down` template/memory bypass in
 * planning.agent.ts never executed once.
 *
 * Pod crashes are a separate incident class with their own scenario; mixing
 * them in here conflated two faults under one label. The 50%-primary +
 * high-severity-filler shape now matches every other generator in this file.
 */
function generateServiceDownEvents(service: string, count: number): RawEvent[] {
    const events: RawEvent[] = [];
    for (let i = 0; i < Math.ceil(count * 0.5); i++) {
        events.push(baseEvent(service, {
            eventType: "service_down",
            severity: "critical",
            data: {
                status: "down",
                lastHealthCheck: new Date(nowMs() - 120000).toISOString(),
                consecutiveFailures: 10,
            },
        }));
    }
    for (let i = events.length; i < count; i++) {
        events.push(baseEvent(service, {
            eventType: "log_entry",
            severity: "high",
            data: {
                level: "ERROR",
                message: `Health check failed for ${service}: connection refused`,
                endpoint: "/health",
            },
        }));
    }
    return events;
}

// ── Held-out incident generators ──────────────────────────────────
//
// Field names below are chosen to avoid colliding with any existing
// template predicate or metric derivation:
//   · no memoryUsage/memoryLimit  → cannot reach tpl-high-memory-pod
//   · no diskUsage / poolUsage    → cannot reach the disk/pool paths
//   · no resourceType             → cannot reach tpl-pvc-not-bound
//   · no CrashLoopBackOff / ImagePullBackOff / Pending in any `reason`
//                                 → cannot reach tpl-pod-crashloopbackoff
//                                   or tpl-imagepullbackoff
// cpu_throttling deliberately reports LOW cpuUsage (that is the whole point
// of throttling — the limit is too tight, not the load too high), which also
// keeps it below tpl-high-cpu-pod's >= 90 predicate.

function generateCertExpiryEvents(service: string, count: number): RawEvent[] {
    const events: RawEvent[] = [];
    for (let i = 0; i < Math.ceil(count * 0.5); i++) {
        events.push(baseEvent(service, {
            eventType: "cert_expiry",
            severity: "critical",
            data: {
                certCommonName: `${service}.production.svc.cluster.local`,
                daysRemaining: -1 - Math.floor(rnd() * 3),
                issuer: "internal-ca",
                tlsHandshakeFailures: 40 + Math.floor(rnd() * 120),
            },
        }));
    }
    for (let i = events.length; i < count; i++) {
        events.push(baseEvent(service, {
            eventType: "log_entry",
            severity: "high",
            data: { message: "TLS handshake failed: certificate has expired" },
        }));
    }
    return events;
}

function generateDnsFailureEvents(service: string, count: number): RawEvent[] {
    const events: RawEvent[] = [];
    for (let i = 0; i < Math.ceil(count * 0.5); i++) {
        events.push(baseEvent(service, {
            eventType: "dns_failure",
            severity: "critical",
            data: {
                failedHostname: "postgres.production.svc.cluster.local",
                nxdomainCount: 30 + Math.floor(rnd() * 60),
                upstreamResolver: "10.96.0.10",
                resolutionErrorRate: 0.7 + rnd() * 0.29,
            },
        }));
    }
    for (let i = events.length; i < count; i++) {
        events.push(baseEvent(service, {
            eventType: "log_entry",
            severity: "high",
            data: { message: "dial tcp: lookup postgres on 10.96.0.10:53: no such host" },
        }));
    }
    return events;
}

function generateConfigDriftEvents(service: string, count: number): RawEvent[] {
    const events: RawEvent[] = [];
    for (let i = 0; i < Math.ceil(count * 0.5); i++) {
        events.push(baseEvent(service, {
            eventType: "config_drift",
            severity: "critical",
            data: {
                driftedKeys: ["spec.replicas", "env.LOG_LEVEL", "env.FEATURE_FLAGS"],
                expectedChecksum: "sha256:4f1a9c",
                actualChecksum: "sha256:b73e02",
                driftDetectedFields: 3,
            },
        }));
    }
    for (let i = events.length; i < count; i++) {
        events.push(baseEvent(service, {
            eventType: "log_entry",
            severity: "high",
            data: { message: "live manifest diverged from desired state in git" },
        }));
    }
    return events;
}

function generateCpuThrottlingEvents(service: string, count: number): RawEvent[] {
    const events: RawEvent[] = [];
    for (let i = 0; i < Math.ceil(count * 0.5); i++) {
        events.push(baseEvent(service, {
            eventType: "cpu_throttling",
            severity: "critical",
            data: {
                throttledPeriods: 600 + Math.floor(rnd() * 500),
                throttlePercent: 55 + Math.floor(rnd() * 35),
                cpuUsage: 35 + Math.floor(rnd() * 20), // low on purpose
                cpuLimit: "200m",
            },
        }));
    }
    for (let i = events.length; i < count; i++) {
        events.push(baseEvent(service, {
            eventType: "log_entry",
            severity: "high",
            data: { message: "container CPU throttled: cfs_throttled_periods rising" },
        }));
    }
    return events;
}

function generateDeadlockEvents(service: string, count: number): RawEvent[] {
    const events: RawEvent[] = [];
    for (let i = 0; i < Math.ceil(count * 0.5); i++) {
        events.push(baseEvent(service, {
            eventType: "db_deadlock",
            severity: "critical",
            data: {
                deadlockCount: 5 + Math.floor(rnd() * 12),
                lockWaitMs: 30000 + Math.floor(rnd() * 30000),
                blockingPid: 4000 + Math.floor(rnd() * 900),
                blockedQueries: 15 + Math.floor(rnd() * 25),
            },
        }));
    }
    for (let i = events.length; i < count; i++) {
        events.push(baseEvent(service, {
            eventType: "log_entry",
            severity: "high",
            data: { message: "deadlock detected; transaction rolled back" },
        }));
    }
    return events;
}

function generateRandomEvents(count: number): RawEvent[] {
    // Draws from the covered six only — the held-out set must never leak into
    // `random`, or the original benchmark's composition would silently change.
    const scenarios: Scenario[] = [...COVERED_SCENARIOS];
    const scenario = scenarios[Math.floor(rnd() * scenarios.length)];
    const service = SERVICES[Math.floor(rnd() * SERVICES.length)];
    return generateEvents(scenario, count, service);
}

/**
 * CLI entry — generate and print events or run standalone.
 */
if (require.main === module) {
    const events = generateEvents("oom_kill", 30, "payment-api");
    console.log(JSON.stringify(events, null, 2));
    console.log(`\n✅ Generated ${events.length} events`);
}
