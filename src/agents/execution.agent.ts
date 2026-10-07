/**
 * Agent 5: Execution Agent
 * Executes remediation plan steps with realistic K8s/Docker-style output.
 * Supports simulate, shadow, and live modes.
 * Broadcasts per-step events for real-time UI updates.
 */
import { IncidentState, StepResult, PlanStep } from "../orchestrator/state";
import { config } from "../config";
import { createChildLogger } from "../utils/logger";
import { CommandValidatorService } from "../services/command-validator.service";
import { broadcast, broadcastLog } from "../services/broadcast";
import * as k8sClient from "../services/k8s.client";

const log = createChildLogger("ExecutionAgent");
const commandValidator = new CommandValidatorService();

// Actions that map onto real K8s API calls (see services/k8s.client.ts for why
// only these four — the rest are app-level/CI concerns a Deployment patch
// can't express, and stay simulated even in shadow/live mode).
const K8S_BACKED_ACTIONS = new Set(["restart_service", "scale_deployment", "update_resource_limits", "verify_health"]);

// ── Reproducible simulated failures ───────────────────────────────
// Every resolution-rate figure the evaluation reports is a function of these
// draws, so a benchmark run has to be repeatable. Set SIM_FAILURE_SEED to a
// number for a deterministic sequence (mulberry32); leave it unset and this
// falls back to Math.random(), preserving the previous behaviour.
export const SIM_FAILURE_RATE = parseFloat(process.env.SIM_FAILURE_RATE || "0.05");

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

const seededRng = process.env.SIM_FAILURE_SEED
    ? mulberry32(parseInt(process.env.SIM_FAILURE_SEED, 10))
    : null;

const simFailureRng = (): number => (seededRng ? seededRng() : Math.random());

/**
 * Route a step through the real Kubernetes client. shadow=true uses the API's
 * server-side dryRun:"All" — a genuine dry run, not a hardcoded string.
 */
async function runK8sAction(step: PlanStep, shadow: boolean): Promise<{ success: boolean; output: string }> {
    const svc = step.parameters.service || step.parameters.deploymentName || step.parameters.name || step.parameters.target || "target-service";
    const ns = step.parameters.namespace || "production";

    switch (step.action) {
        case "restart_service":
            return k8sClient.restartService(svc, ns, shadow);
        case "scale_deployment":
            return k8sClient.scaleDeployment(svc, ns, step.parameters.replicas || step.parameters.replicaCount || 3, shadow);
        case "update_resource_limits":
            return k8sClient.updateResourceLimits(svc, ns, step.parameters.memoryLimit || step.parameters.memory, step.parameters.cpuLimit, shadow);
        case "verify_health":
            return k8sClient.verifyHealth(svc, ns);
        default:
            return { success: false, output: `Error: ${step.action} has no Kubernetes-backed implementation` };
    }
}

// ── Realistic K8s/Docker Output Simulator ────────

async function simulateAction(step: PlanStep, incidentId: string, stepNum: number, totalSteps: number): Promise<{ success: boolean; output: string }> {
    const delays: Record<string, number> = {
        restart_service: 2000,
        scale_deployment: 1500,
        rolling_restart: 3000,
        rollback_deployment: 2500,
        update_resource_limits: 1000,
        clear_disk_space: 2000,
        flush_connection_pool: 800,
        apply_config: 1200,
        verify_health: 1000,
        trigger_pipeline: 2000,
    };

    const delay = delays[step.action] || 1000;

    // Broadcast step start
    broadcast("execution_step", {
        incidentId,
        stepId: step.stepId,
        stepNum,
        totalSteps,
        action: step.action,
        description: step.description,
        status: "running",
    });
    broadcastLog("execution", "info", `Step ${stepNum}/${totalSteps}: ${step.action} → running...`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    // 5% chance of failure to demonstrate retry resilience.
    // Seeded when SIM_FAILURE_SEED is set so a benchmark run is reproducible
    // (every outcome figure in the paper depends on these draws).
    const shouldFail = simFailureRng() < SIM_FAILURE_RATE;
    if (shouldFail) {
        const output = `Error: ${step.action} failed — connection timeout after ${step.timeoutSeconds}s`;
        broadcast("execution_step", {
            incidentId,
            stepId: step.stepId,
            stepNum,
            totalSteps,
            action: step.action,
            status: "failed",
            output,
        });
        broadcastLog("execution", "error", `Step ${stepNum}/${totalSteps}: ${step.action} → FAILED`);
        return { success: false, output };
    }

    const svc = step.parameters.service || step.parameters.deploymentName || step.parameters.name || step.parameters.target || "target-service";
    const replicas = step.parameters.replicas || step.parameters.replicaCount || 3;
    const ns = step.parameters.namespace || "production";

    const outputs: Record<string, string> = {
        restart_service: `deployment.apps/${svc} restarted\nwaiting for rollout...\ndeployment "${svc}" successfully rolled out\npods: 3/3 running`,
        scale_deployment: `deployment.apps/${svc} scaled\nreplicas: ${replicas}\npods: ${replicas}/${replicas} ready`,
        rolling_restart: `deployment.apps/${svc} restarted (rolling)\nold pods: terminating → new pods: pending → running\n✓ 0 downtime. ${replicas}/3 pods healthy`,
        rollback_deployment: `deployment.apps/${svc} rolled back\nrev: 4 → rev: 3\npods: 3/3 running on previous revision`,
        update_resource_limits: `deployment.apps/${svc} configured\nmemory: ${step.parameters.memoryLimit || step.parameters.memory || "768Mi"}\ncpu: ${step.parameters.cpuLimit || "500m"}\napplied to ${ns}`,
        clear_disk_space: `removed /var/log/*.gz (${step.parameters.freeSpaceGB || 12}GB freed)\nremoved /tmp/* (1.2GB freed)\ndf: /dev/sda1 ${100 - (step.parameters.diskUsage || 45)}% used`,
        flush_connection_pool: `pool flushed for ${svc}\nactive connections: 95 → 0\nnew pool initialized: 0/100 connections\npool ready`,
        apply_config: `configmap/${svc}-config updated\ndeployment.apps/${svc} rolled out (config reload)\nconfiguration applied to ${ns}`,
        verify_health: `GET /health HTTP/1.1 → 200 OK\n{"status":"healthy","uptime":42,"version":"1.4.2"}\nservice ${svc} is healthy ✓`,
        trigger_pipeline: `pipeline triggered: ${svc}-deploy\nbuild: queued → running\nstage 1/3: build (30s)\nstage 2/3: test (45s)\nstage 3/3: deploy → initiated`,
    };

    const output = outputs[step.action] || `✓ ${step.action} completed on ${svc}`;

    broadcast("execution_step", {
        incidentId,
        stepId: step.stepId,
        stepNum,
        totalSteps,
        action: step.action,
        status: "success",
        output,
        durationMs: delay,
    });
    broadcastLog("execution", "info", `Step ${stepNum}/${totalSteps}: ${step.action} → ✅ done (${(delay / 1000).toFixed(1)}s)`);

    return { success: true, output };
}

// ── Main Agent ────────────────────────────────────

export async function executionAgent(state: IncidentState): Promise<IncidentState> {
    log.info({ incidentId: state.incidentId, mode: config.agents.executionMode }, "▶ Execution Agent started");
    state.currentAgent = "execution";
    state.workflowStatus = "executing";
    state.executionStatus = "running";
    state.updatedAt = new Date().toISOString();

    // === Safety Gate: Validate all commands before executing ===
    if (state.plan && state.plan.steps.length > 0) {
        const fixSteps = state.plan.steps.map((s) => ({
            action: s.action,
            command: s.description || s.action,
            estimatedDurationSec: s.timeoutSeconds,
            rollbackCommand: s.rollback,
        }));

        const validation = commandValidator.validate(fixSteps);
        if (!validation.safe) {
            log.error("HARD_BLOCKED command detected", {
                incidentId: state.incidentId,
                reason: validation.reason,
                blockedSteps: validation.blockedSteps,
            });
            broadcastLog("execution", "error",
                `HARD_BLOCKED: ${validation.reason}`,
                { blockedSteps: validation.blockedSteps?.map((b: any) => b.pattern) }
            );
            broadcast("execution_step", {
                incidentId: state.incidentId,
                stepId: 0,
                stepNum: 0,
                totalSteps: fixSteps.length,
                action: "command_validation",
                status: "blocked",
                output: `Blocked: ${validation.reason}`,
            });
            state.executionStatus = "failed";
            state.stepsFailed.push({
                stepId: 0,
                action: "command_validation",
                status: "failed",
                error: `Blocked: ${validation.reason}`,
                completedAt: new Date().toISOString(),
            });
            return state;
        }
    }

    if (!state.plan || state.plan.steps.length === 0) {
        log.warn("No plan or empty steps, marking as failed");
        broadcastLog("execution", "warn", "No remediation plan available — execution skipped");
        state.executionStatus = "failed";
        state.stepsFailed.push({
            stepId: 0,
            action: "no_plan",
            status: "failed",
            error: "No remediation plan available",
            completedAt: new Date().toISOString(),
        });
        return state;
    }

    const steps = state.plan.steps;
    const completed: StepResult[] = [];
    const failed: StepResult[] = [];

    broadcastLog("execution", "info",
        `Starting execution: ${steps.length} steps (mode: ${config.agents.executionMode})`,
        { planTitle: state.plan.title, riskLevel: state.plan.riskLevel }
    );
    log.info({ totalSteps: steps.length }, "Executing remediation plan...");

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepNum = i + 1;

        log.info({ stepId: step.stepId, action: step.action }, `  ⚙️  Step ${stepNum}/${steps.length}: ${step.action}`);

        try {
            let result: { success: boolean; output: string };

            const mode = config.agents.executionMode;
            const useK8s = mode !== "simulate" && K8S_BACKED_ACTIONS.has(step.action) && k8sClient.isK8sAvailable();

            if (mode === "simulate") {
                result = await simulateAction(step, state.incidentId, stepNum, steps.length);
            } else if (useK8s) {
                broadcast("execution_step", {
                    incidentId: state.incidentId,
                    stepId: step.stepId,
                    stepNum,
                    totalSteps: steps.length,
                    action: step.action,
                    status: "running",
                });
                broadcastLog("execution", "info", `Step ${stepNum}/${steps.length}: ${step.action} → running on Kubernetes (${mode})...`);

                result = await runK8sAction(step, mode === "shadow");

                broadcast("execution_step", {
                    incidentId: state.incidentId,
                    stepId: step.stepId,
                    stepNum,
                    totalSteps: steps.length,
                    action: step.action,
                    status: result.success ? "success" : "failed",
                    output: result.output,
                });
                broadcastLog("execution", result.success ? "info" : "error",
                    `Step ${stepNum}/${steps.length}: ${step.action} → ${result.success ? "✅ done (Kubernetes)" : "FAILED"}`
                );
            } else if (mode === "shadow") {
                // Non-K8s-mapped action, or no cluster configured — nothing real to dry-run.
                broadcast("execution_step", {
                    incidentId: state.incidentId,
                    stepId: step.stepId,
                    stepNum,
                    totalSteps: steps.length,
                    action: step.action,
                    status: "shadow",
                    output: `[SHADOW MODE] Would execute: ${step.description || step.action}`,
                });
                broadcastLog("execution", "info", `Step ${stepNum}/${steps.length}: ${step.action} → [SHADOW]`);
                result = { success: true, output: `[SHADOW MODE] ${step.action}` };
            } else {
                // Live mode, but this action has no K8s-backed implementation and/or no
                // cluster is configured — fall back to realistic simulation.
                log.warn({ action: step.action, k8sAvailable: k8sClient.isK8sAvailable() }, "Live execution mode — no K8s-backed implementation for this action, using simulation");
                result = await simulateAction(step, state.incidentId, stepNum, steps.length);
            }

            if (result.success) {
                completed.push({
                    stepId: step.stepId,
                    action: step.action,
                    status: "success",
                    result: result.output,
                    completedAt: new Date().toISOString(),
                });
                log.info({ stepId: step.stepId }, `  ✅ Step ${stepNum} completed`);
            } else {
                failed.push({
                    stepId: step.stepId,
                    action: step.action,
                    status: "failed",
                    error: result.output,
                    completedAt: new Date().toISOString(),
                });
                log.error({ stepId: step.stepId, error: result.output }, `  ❌ Step ${stepNum} failed`);
                break;
            }
        } catch (err: any) {
            broadcast("execution_step", {
                incidentId: state.incidentId,
                stepId: step.stepId,
                stepNum,
                totalSteps: steps.length,
                action: step.action,
                status: "failed",
                output: err.message,
            });
            failed.push({
                stepId: step.stepId,
                action: step.action,
                status: "failed",
                error: err.message,
                completedAt: new Date().toISOString(),
            });
            log.error({ stepId: step.stepId, err: err.message }, `  ❌ Step ${stepNum} exception`);
            break;
        }
    }

    state.stepsCompleted = [...state.stepsCompleted, ...completed];
    state.stepsFailed = [...state.stepsFailed, ...failed];

    if (failed.length === 0) {
        state.executionStatus = "success";
        broadcastLog("execution", "info",
            `All ${completed.length} steps completed successfully`,
            { steps: completed.map(s => s.action) }
        );
        log.info({ completed: completed.length }, "✅ All execution steps completed");
    } else if (completed.length > 0) {
        state.executionStatus = "partial";
        broadcastLog("execution", "warn", `Partial execution: ${completed.length} done, ${failed.length} failed`);
        log.warn({ completed: completed.length, failed: failed.length }, "⚠️ Partial execution");
    } else {
        state.executionStatus = "failed";
        broadcastLog("execution", "error", `Execution failed on first step`);
        log.error("❌ Execution failed on first step");
    }

    return state;
}
