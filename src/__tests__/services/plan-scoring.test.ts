/**
 * AutoOps AI — Rubric self-validation (task.md T6)
 *
 * A scoring rubric that passes everything, or fails everything, measures
 * nothing. Before the rubric is used to make a claim in the paper, these tests
 * establish that it DISCRIMINATES:
 *
 *   · the generic fallback plan the baseline arm produces for every held-out
 *     class scores INCORRECT on all five, and
 *   · a hand-written domain-correct plan scores CORRECT on all five.
 *
 * If either property ever breaks, the experiment's headline number is invalid.
 */
import { describe, it, expect } from "vitest";
import {
    scorePlan,
    HELD_OUT_RUBRICS,
    COVERED_RUBRICS,
    ALL_RUBRICS,
    PlanStepLike,
} from "../../evaluation/plan-scoring";

/**
 * The plan the rule-based arm emits for any incident whose RCA category has no
 * entry in the fallback map — i.e. all five held-out classes.
 * Mirrors FALLBACK_PLANS.default in planning.agent.ts.
 */
const GENERIC_FALLBACK: PlanStepLike[] = [
    { action: "restart_service", description: "Restart the affected service", parameters: { service: "payment-api" } },
    { action: "verify_health", description: "Verify service health", parameters: { service: "payment-api" } },
];

/** Domain-correct plans, written by hand from each rubric's rationale. */
const CORRECT_PLANS: Record<string, PlanStepLike[]> = {
    cert_expiry: [
        { action: "apply_config", description: "Reissue and apply the renewed TLS certificate", parameters: { secret: "payment-api-tls" } },
        { action: "verify_health", description: "Verify TLS handshakes succeed", parameters: { service: "payment-api" } },
    ],
    dns_failure: [
        { action: "apply_config", description: "Correct the upstream resolver configuration", parameters: { configMap: "coredns" } },
        { action: "verify_health", description: "Verify resolution succeeds", parameters: { service: "payment-api" } },
    ],
    config_drift: [
        { action: "rollback_deployment", description: "Roll back to the last known good revision", parameters: { deployment: "payment-api" } },
        { action: "verify_health", description: "Verify config matches desired state", parameters: { service: "payment-api" } },
    ],
    cpu_throttling: [
        { action: "update_resource_limits", description: "Raise the CPU limit above the throttling ceiling", parameters: { cpuLimit: "1000m" } },
        { action: "verify_health", description: "Verify throttling has stopped", parameters: { service: "payment-api" } },
    ],
    db_deadlock: [
        { action: "flush_connection_pool", description: "Recycle the pool holding the blocking sessions", parameters: { service: "orders-db" } },
        { action: "verify_health", description: "Verify lock waits have cleared", parameters: { service: "orders-db" } },
    ],
};

describe("rubric discriminates on held-out scenarios", () => {
    for (const scenario of Object.keys(HELD_OUT_RUBRICS)) {
        it(`${scenario}: generic restart+verify fallback scores INCORRECT`, () => {
            const s = scorePlan(scenario, GENERIC_FALLBACK);
            expect(s.correct).toBe(false);
            expect(s.addressesRootCause).toBe(false);
            // Secondary signals still credit it — only root-cause fails.
            expect(s.hasVerification).toBe(true);
            expect(s.stepCountSane).toBe(true);
        });

        it(`${scenario}: hand-written domain-correct plan scores CORRECT`, () => {
            const s = scorePlan(scenario, CORRECT_PLANS[scenario]);
            expect(s.correct).toBe(true);
            expect(s.score).toBe(1);
        });
    }
});

describe("dns_failure parameter-sensitive acceptance", () => {
    it("restarting the application is NOT accepted", () => {
        expect(
            scorePlan("dns_failure", [
                { action: "restart_service", description: "Restart payment-api", parameters: { service: "payment-api" } },
            ]).correct
        ).toBe(false);
    });

    it("restarting the DNS layer specifically IS accepted", () => {
        const s = scorePlan("dns_failure", [
            { action: "restart_service", description: "Restart CoreDNS pods", parameters: { service: "coredns", namespace: "kube-system" } },
        ]);
        expect(s.correct).toBe(true);
        expect(s.notes).toContain("accepted via scenario-specific predicate");
    });
});

describe("rubric is not self-serving on covered scenarios", () => {
    // The baseline is SUPPOSED to do well where a runbook exists. A rubric that
    // failed it everywhere would be rigged toward our hypothesis.
    it("the generic fallback is accepted for service_down", () => {
        expect(scorePlan("service_down", GENERIC_FALLBACK).correct).toBe(true);
    });

    it("the memory_leak fallback is accepted for oom_kill", () => {
        const memoryLeakFallback: PlanStepLike[] = [
            { action: "scale_deployment", description: "Scale out", parameters: { replicas: 4 } },
            { action: "rolling_restart", description: "Rolling restart", parameters: {} },
            { action: "update_resource_limits", description: "Raise memory limit", parameters: { memoryLimit: "1Gi" } },
            { action: "verify_health", description: "Verify", parameters: {} },
        ];
        expect(scorePlan("oom_kill", memoryLeakFallback).correct).toBe(true);
    });

    it("a clearly wrong plan still fails a covered scenario", () => {
        expect(
            scorePlan("disk_full", [
                { action: "scale_deployment", description: "Add replicas", parameters: { replicas: 5 } },
            ]).correct
        ).toBe(false);
    });
});

describe("structural sanity checks", () => {
    it("flags an implausible step count", () => {
        const bloated = Array.from({ length: 14 }, () => ({
            action: "restart_service",
            description: "x",
            parameters: {},
        }));
        const s = scorePlan("service_down", bloated);
        expect(s.stepCountSane).toBe(false);
        expect(s.score).toBeLessThan(1);
    });

    it("an empty plan is never correct", () => {
        expect(scorePlan("service_down", []).correct).toBe(false);
    });

    it("throws on a scenario with no rubric rather than silently passing", () => {
        expect(() => scorePlan("not_a_scenario", GENERIC_FALLBACK)).toThrow(/No rubric/);
    });

    it("every covered and held-out scenario has a rubric with a rationale", () => {
        for (const [name, r] of Object.entries(ALL_RUBRICS)) {
            expect(r.requiredAny.length, `${name} has no required actions`).toBeGreaterThan(0);
            expect(r.rationale.length, `${name} has no rationale`).toBeGreaterThan(20);
        }
        expect(Object.keys(HELD_OUT_RUBRICS)).toHaveLength(5);
        expect(Object.keys(COVERED_RUBRICS)).toHaveLength(6);
    });
});
