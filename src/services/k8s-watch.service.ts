/**
 * AutoOps AI — Kubernetes Cluster Watch Service
 * Polls `kubectl get pods -n <namespace> -o wide` on an interval and
 * broadcasts the raw text output over the existing WebSocket feed as a
 * `cluster_state_update` event, so the dashboard's Live Cluster Terminal
 * can render pod/replica state without a split-screen terminal.
 *
 * Self-schedules via setTimeout (not setInterval) so a slow or hung kubectl
 * call can never stack up overlapping polls.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "../config";
import { createChildLogger } from "../utils/logger";
import { isK8sAvailable } from "./k8s.client";
import { broadcast, setLastClusterState } from "./broadcast";

const execFileAsync = promisify(execFile);
const log = createChildLogger("K8sWatch");

let timer: NodeJS.Timeout | null = null;
let running = false;

async function pollOnce(): Promise<void> {
    const namespace = config.clusterWatch.namespace;

    // Re-checked every tick (not just at startup) — the cluster can become
    // reachable or unreachable at any point while the server is running.
    if (!isK8sAvailable()) {
        const payload = {
            namespace,
            output: "kubectl unavailable — no reachable Kubernetes cluster (EXECUTION_MODE=simulate, or the cluster probe failed at startup)",
            ok: false,
            timestamp: new Date().toISOString(),
        };
        setLastClusterState(payload);
        broadcast("cluster_state_update", payload);
        return;
    }

    try {
        // execFile with an argv array — never goes through a shell, so there's
        // no command-injection surface even though namespace is config-derived.
        const { stdout } = await execFileAsync(
            "kubectl",
            ["get", "pods", "-n", namespace, "-o", "wide"],
            { timeout: 5000 }
        );
        const payload = {
            namespace,
            output: stdout.trim() || `No resources found in ${namespace} namespace.`,
            ok: true,
            timestamp: new Date().toISOString(),
        };
        setLastClusterState(payload);
        broadcast("cluster_state_update", payload);
    } catch (err: unknown) {
        const error = err as { message: string; stderr?: string };
        const payload = {
            namespace,
            output: `Error: ${(error.stderr || error.message || "kubectl call failed").trim()}`,
            ok: false,
            timestamp: new Date().toISOString(),
        };
        setLastClusterState(payload);
        broadcast("cluster_state_update", payload);
        log.warn({ err: error.message }, "kubectl poll failed");
    }
}

export function startClusterWatch(): void {
    if (running) return;
    running = true;

    const tick = () => {
        if (!running) return;
        pollOnce().finally(() => {
            if (running) timer = setTimeout(tick, config.clusterWatch.pollIntervalMs);
        });
    };

    log.info(
        { namespace: config.clusterWatch.namespace, intervalMs: config.clusterWatch.pollIntervalMs },
        "🛰️  Cluster watch started — streaming kubectl output to /ws"
    );
    tick();
}

export function stopClusterWatch(): void {
    running = false;
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
}
