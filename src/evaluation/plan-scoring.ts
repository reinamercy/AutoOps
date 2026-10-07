/**
 * AutoOps AI — Plan-correctness rubric (task.md T6)
 *
 * WHY THIS EXISTS
 * The simulate-mode executor decides success/failure with a random draw that
 * is independent of plan content, so resolution rate cannot distinguish a
 * well-reasoned plan from a generic one (task.md B2). This module scores the
 * *plan itself* against a per-scenario declaration of what actually fixes the
 * incident, giving a quality signal the executor cannot provide.
 *
 * HONEST LIMITATIONS — state these in the paper, do not hide them:
 *   · The rubric is author-defined. It encodes our judgement of the correct
 *     remediation, not ground truth from production incidents.
 *   · It rewards *addressing the root cause*, not plan elegance, ordering
 *     quality, or parameter precision beyond a basic sanity check.
 *   · It is deliberately generous: a plan counts as correct if it contains a
 *     required action anywhere, even alongside unnecessary steps. This biases
 *     AGAINST our hypothesis (it makes the generic baseline easier to pass),
 *     which is the safe direction for a claim we want to defend.
 *
 * The action vocabulary is fixed by the system prompt in planning.agent.ts:
 *   restart_service, scale_deployment, rolling_restart, rollback_deployment,
 *   update_resource_limits, clear_disk_space, flush_connection_pool,
 *   apply_config, verify_health, trigger_pipeline
 */

export interface PlanStepLike {
    action?: string;
    parameters?: Record<string, unknown>;
    description?: string;
}

export interface ScenarioRubric {
    /** Why these actions are the correct remediation for this incident class. */
    rationale: string;
    /** Plan is correct if it contains at least one of these. */
    requiredAny: string[];
    /**
     * Actions with a defensible role for this fault class: the required fix
     * plus legitimate adjuncts (restart to pick up new config, verify
     * afterwards). Any action OUTSIDE this set counts as irrelevant and costs
     * precision.
     *
     * WHY THIS EXISTS (reviewer objection R2): scoring on containment alone
     * rewards verbosity. Observed LLM plans average 4.74 steps against the
     * baseline's exactly 2.00, and with a 10-action vocabulary a 5-step plan
     * hits a single required action ~50% of the time by chance alone. A
     * length-matched random planner scores ~59% under containment. Precision
     * is what separates a reasoned plan from a shotgun.
     */
    relevant: string[];
    /**
     * Actions that are actively wrong or dangerous here. Present → incorrect
     * even under lenient scoring.
     */
    forbidden?: string[];
    /**
     * Optional extra predicate for cases where the action alone is ambiguous
     * (e.g. restarting *which* component).
     */
    acceptIf?: (steps: PlanStepLike[]) => boolean;
}

const stepActions = (steps: PlanStepLike[]): string[] =>
    steps.map((s) => String(s.action || "").toLowerCase().trim()).filter(Boolean);

/**
 * Read-only inspection steps ("check memory", "describe pod") emitted by
 * remediation templates. They change nothing, so they can neither remediate
 * the fault nor be a wrong remediation: they are excluded from the precision
 * denominator rather than counted against the plan. Counting them as
 * irrelevant would penalise templates for documenting their diagnosis.
 */
const isDiagnostic = (action: string): boolean =>
    action.startsWith("check ") || action.startsWith("describe ");

/** Does any step's parameters or description mention one of these tokens? */
const mentions = (steps: PlanStepLike[], tokens: string[]): boolean => {
    const hay = steps
        .map((s) => `${s.description || ""} ${JSON.stringify(s.parameters || {})}`)
        .join(" ")
        .toLowerCase();
    return tokens.some((t) => hay.includes(t));
};

// ── Held-out incident classes (no template, no memory, no fallback entry) ──

export const HELD_OUT_RUBRICS: Record<string, ScenarioRubric> = {
    cert_expiry: {
        rationale:
            "An expired TLS certificate is only resolved by issuing/reapplying a new " +
            "certificate. Restarting the workload re-presents the same expired cert, so " +
            "restart_service alone is insufficient.",
        requiredAny: ["apply_config", "trigger_pipeline"],
        relevant: [
            "apply_config",
            "trigger_pipeline",
            "rolling_restart",
            "restart_service",
            "verify_health",
            "scale_deployment",
        ],
    },

    dns_failure: {
        rationale:
            "Resolution failures against a dependency are fixed at the resolver or " +
            "service-discovery layer — correcting resolver config, or restarting the " +
            "DNS component specifically. Restarting the affected application does not " +
            "change what its lookups resolve to.",
        requiredAny: ["apply_config"],
        relevant: [
            "apply_config",
            "restart_service",
            "rolling_restart",
            "verify_health",
            "scale_deployment",
        ],
        // A restart IS correct if it targets the DNS layer rather than the app.
        acceptIf: (steps) =>
            stepActions(steps).includes("restart_service") &&
            mentions(steps, ["dns", "coredns", "kube-dns", "resolver"]),
    },

    config_drift: {
        rationale:
            "Live state diverging from the declared desired state is corrected by " +
            "reapplying the desired configuration, or rolling back to the last known " +
            "good revision. A restart re-launches the drifted config unchanged.",
        requiredAny: ["apply_config", "rollback_deployment"],
        relevant: [
            "apply_config",
            "rollback_deployment",
            "rolling_restart",
            "restart_service",
            "verify_health",
            "trigger_pipeline",
            "scale_deployment",
        ],
    },

    cpu_throttling: {
        rationale:
            "High cfs-throttling at LOW cpu utilisation means the container's CPU limit " +
            "is too tight, not that load is too high. Raising the limit is the fix. " +
            "Scaling out adds replicas that are each still throttled.",
        requiredAny: ["update_resource_limits"],
        relevant: [
            "update_resource_limits",
            "apply_config",
            "rolling_restart",
            "verify_health",
            "scale_deployment",
        ],
    },

    db_deadlock: {
        rationale:
            "Lock contention is cleared by terminating the blocking sessions / recycling " +
            "the connection pool holding them. Restarting the application does not " +
            "release locks already held in the database.",
        requiredAny: ["flush_connection_pool"],
        relevant: [
            "flush_connection_pool",
            "restart_service",
            "rolling_restart",
            "apply_config",
            "verify_health",
        ],
    },
};

// ── The covered six (paper Table III) ─────────────────────────────
// Included so T9 can score both sets on the same scale. The baseline arm is
// EXPECTED to do well here — that contrast is the point of the experiment,
// and a rubric that failed the baseline everywhere would be self-serving.

export const COVERED_RUBRICS: Record<string, ScenarioRubric> = {
    oom_kill: {
        rationale:
            "Memory exhaustion is resolved by raising the memory limit; a restart or " +
            "scale-out is temporary relief that does not change the ceiling.",
        requiredAny: ["update_resource_limits", "scale_deployment", "rolling_restart"],
        relevant: [
            "update_resource_limits",
            "scale_deployment",
            "rolling_restart",
            "restart_service",
            "verify_health",
        ],
    },
    high_error_rate: {
        rationale:
            "A 5xx spike following a deploy is addressed by rolling back the bad " +
            "revision; restarting is a legitimate first-line response.",
        requiredAny: ["rollback_deployment", "restart_service"],
        relevant: [
            "rollback_deployment",
            "restart_service",
            "rolling_restart",
            "apply_config",
            "verify_health",
        ],
    },
    cpu_spike: {
        rationale:
            "Sustained CPU saturation is relieved by adding capacity or raising limits.",
        requiredAny: ["scale_deployment", "update_resource_limits"],
        relevant: [
            "scale_deployment",
            "update_resource_limits",
            "rolling_restart",
            "verify_health",
            "apply_config",
        ],
    },
    disk_full: {
        rationale: "A full volume is resolved by reclaiming space.",
        requiredAny: ["clear_disk_space"],
        relevant: [
            "clear_disk_space",
            "update_resource_limits",
            "verify_health",
            "apply_config",
        ],
    },
    connection_pool_exhaustion: {
        rationale:
            "A saturated pool is relieved by recycling connections or adding capacity.",
        requiredAny: ["flush_connection_pool", "scale_deployment"],
        relevant: [
            "flush_connection_pool",
            "scale_deployment",
            "update_resource_limits",
            "apply_config",
            "restart_service",
            "rolling_restart",
            "verify_health",
        ],
    },
    service_down: {
        rationale:
            "An unresponsive service is restored by restarting it — as a direct restart " +
            "or a rolling restart of its deployment — or by rolling back the revision " +
            "that took it down. `rolling_restart` was added after observing that " +
            "tpl-service-no-endpoints remediates via `kubectl rollout restart`, which is " +
            "a restart by any reasonable reading; excluding it would have scored a " +
            "correct plan as wrong. Note the direction of this correction: it makes the " +
            "BASELINE easier to pass, so it is conservative with respect to our own " +
            "hypothesis.",
        requiredAny: ["restart_service", "rolling_restart", "rollback_deployment"],
        relevant: [
            "restart_service",
            "rolling_restart",
            "rollback_deployment",
            "apply_config",
            "verify_health",
            "scale_deployment",
        ],
    },
};

export const ALL_RUBRICS: Record<string, ScenarioRubric> = {
    ...HELD_OUT_RUBRICS,
    ...COVERED_RUBRICS,
};

/**
 * Bump whenever a rubric's `requiredAny`/`relevant`/`forbidden` sets or the
 * scoring function change in a way that can move a score. Stamped into
 * re-scored result files by scripts/rescore-results.ts so a released record
 * says which rubric produced it.
 *
 * "strict-1" is the measure reported in the paper: a required action AND no
 * irrelevant one, with read-only diagnostic steps excluded from the precision
 * denominator. The runs themselves were executed under the earlier
 * containment-only rubric, whose scores survive as `planScoreAsRun`.
 */
export const RUBRIC_VERSION = "strict-1";

export interface PlanScore {
    scenario: string;
    /**
     * PRIMARY METRIC (strict): the plan addresses the root cause AND contains
     * no irrelevant action. Answers reviewer objection R2 — a shotgun plan
     * that happens to include the right action alongside four wrong ones is
     * not a correct remediation.
     */
    correct: boolean;
    /**
     * Containment only, ignoring irrelevant actions. Reported for comparison
     * and because it is what a length-matched random planner exploits.
     */
    correctLenient: boolean;
    addressesRootCause: boolean;
    hasForbiddenAction: boolean;
    /** Fraction of steps drawn from this class's relevant action set. */
    precision: number;
    irrelevantActions: string[];
    /** Secondary quality signals, reported but not part of `correct`. */
    hasVerification: boolean;
    stepCountSane: boolean;
    /** Composite in [0,1]. */
    score: number;
    actions: string[];
    notes: string[];
}

export function scorePlan(scenario: string, steps: PlanStepLike[]): PlanScore {
    const rubric = ALL_RUBRICS[scenario];
    if (!rubric) throw new Error(`No rubric defined for scenario "${scenario}"`);

    const actions = stepActions(steps);
    const notes: string[] = [];

    const viaRequired = rubric.requiredAny.some((a) => actions.includes(a));
    const viaPredicate = rubric.acceptIf ? rubric.acceptIf(steps) : false;
    const addressesRootCause = viaRequired || viaPredicate;
    if (viaPredicate && !viaRequired) notes.push("accepted via scenario-specific predicate");
    if (!addressesRootCause) {
        notes.push(`no required action present (need one of: ${rubric.requiredAny.join(", ")})`);
    }

    const hasForbiddenAction = (rubric.forbidden || []).some((a) => actions.includes(a));
    if (hasForbiddenAction) notes.push("contains a forbidden action");

    // Precision: how much of the plan has a defensible role for this fault.
    const relevantSet = new Set(rubric.relevant);
    const scored = actions.filter((a) => !isDiagnostic(a));
    const irrelevantActions = [...new Set(scored.filter((a) => !relevantSet.has(a)))];
    const relevantCount = scored.filter((a) => relevantSet.has(a)).length;
    const precision = scored.length ? relevantCount / scored.length : 0;
    if (irrelevantActions.length) {
        notes.push(`irrelevant actions: ${irrelevantActions.join(", ")}`);
    }

    const hasVerification = actions.includes("verify_health");
    // Mirrors the hallucination guard in command-validator.service.ts.
    const stepCountSane = steps.length > 0 && steps.length <= 10;
    if (!stepCountSane) notes.push(`implausible step count: ${steps.length}`);

    const correctLenient = addressesRootCause && !hasForbiddenAction;
    const correct = correctLenient && irrelevantActions.length === 0;

    const score =
        (correct ? 0.6 : correctLenient ? 0.3 : 0) +
        0.25 * precision +
        (hasVerification ? 0.075 : 0) +
        (stepCountSane ? 0.075 : 0);

    return {
        scenario,
        correct,
        correctLenient,
        addressesRootCause,
        hasForbiddenAction,
        precision: parseFloat(precision.toFixed(3)),
        irrelevantActions,
        hasVerification,
        stepCountSane,
        score: parseFloat(score.toFixed(3)),
        actions,
        notes,
    };
}

/**
 * NOTE ON THE `relevant` SETS (reviewer objection R2).
 *
 * `scale_deployment` is admitted as a capacity-preservation adjunct for the
 * four held-out classes whose fix involves restarting or reapplying config:
 * adding replicas before a rolling restart is defensible operational practice,
 * and counting it as irrelevant would penalise the model for something a human
 * engineer might legitimately write.
 *
 * It is NOT admitted for `db_deadlock` (more application replicas increases
 * contention for the locks already held, making the incident worse) or
 * `disk_full` (replicas do not reclaim space).
 *
 * Even after that concession, `scale_deployment` appears in roughly 19 of 20
 * plans for EVERY held-out class regardless of fault — so its presence is a
 * near-constant prefix rather than a response to the incident. We report that
 * pattern rather than scoring it as an error.
 */
