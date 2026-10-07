/**
 * AutoOps AI — Direct-LLM baseline (secondary comparative experiment).
 *
 * Protocol: docs/protocols/direct-llm-baseline.md. That file was committed
 * before the first model call of this experiment; do not change this script
 * or the prompt after outcomes are observed.
 *
 * Gives openai/gpt-oss-120b the same 100 held-out incidents as Experiment 1,
 * as the raw events the pipeline receives at its input, with the planner's
 * own system prompt (output schema + action vocabulary + rules) and nothing
 * else: no Monitoring classification, no RCA output, no template, memory,
 * retrieval, risk information, execution feedback or earlier incidents.
 *
 * No server is involved. Events are regenerated from the same per-incident
 * seed the Experiment 1 harness used, and each record carries a hash of the
 * exact events sent, plus the paired full-arm incident id.
 *
 *   npx tsx scripts/direct-llm-baseline.ts            # start or resume
 *
 * Exit codes: 0 complete, 3 paused on daily-quota exhaustion (re-run later
 * to resume), 1 error.
 */
import "dotenv/config";
import fs from "fs";
import crypto from "crypto";
import { generateEvents, setEventSeed, HELD_OUT_SCENARIOS } from "../src/simulator/log-producer";
import { buildWorkOrder } from "../src/evaluation/work-order";
import { scorePlan, RUBRIC_VERSION, PlanStepLike } from "../src/evaluation/plan-scoring";
import { SYSTEM_PROMPT } from "../src/agents/planning.agent";
import {
    createGroqClient,
    getLastGroqCallMeta,
    GroqQuotaExhaustedError,
    GroqUnavailableError,
    GROQ_MODEL_PLANNING,
} from "../src/services/groq.client";

const OUT = "scripts/eval-heldout-direct-gptoss120b.json";
const FULL = "scripts/eval-heldout-full-gptoss120b.json";
const PROTOCOL = "docs/protocols/direct-llm-baseline.md";
const RUNS_PER_SCENARIO = 20;
const WORK_ORDER_SEED = 1337;
const EVENTS_PER_INCIDENT = 20;
/** Pacing to stay under the 8,000 tokens/minute limit at ~3.5k tokens/call. */
const THROTTLE_MS = 35000;
const EXPECTED_MODEL = "openai/gpt-oss-120b";

/** Identical to seedFor() in scripts/eval-harness.ts. */
function seedFor(scenario: string, index: number): number {
    const key = `${scenario}#${index}`;
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** The frozen Direct-LLM user prompt. Raw input events only. */
export function buildDirectPrompt(events: unknown[]): string {
    return (
        `## Incident Evidence\n` +
        `The monitoring pipeline received the following ${events.length} raw events (JSON, one per line):\n` +
        events.map((e) => JSON.stringify(e)).join("\n") +
        `\n\nDiagnose the most likely root cause from this evidence alone, then generate the remediation plan as JSON.`
    );
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function writeOut(meta: any, results: any[], remaining: any[]): void {
    fs.writeFileSync(OUT, JSON.stringify({ meta, results, remaining }, null, 2));
}

async function main() {
    if (GROQ_MODEL_PLANNING !== EXPECTED_MODEL) {
        console.error(`✗ GROQ_MODEL_PLANNING is "${GROQ_MODEL_PLANNING}", protocol requires "${EXPECTED_MODEL}".`);
        process.exit(1);
    }
    const protocolSha = sha256(fs.readFileSync(PROTOCOL, "utf8"));
    const scriptSha = sha256(fs.readFileSync(__filename, "utf8"));

    const full = JSON.parse(fs.readFileSync(FULL, "utf8"));
    const fullByKey = new Map<string, any>(full.results.map((r: any) => [`${r.scenario}#${r.runIndex}`, r]));

    const order = buildWorkOrder(HELD_OUT_SCENARIOS, RUNS_PER_SCENARIO, true, WORK_ORDER_SEED);

    // DRY_RUN=true: no model call, no output file. Verifies every incident
    // pairs with an Experiment 1 record of the same seed, and prints the
    // exact first prompt so it can be frozen into the protocol.
    if (process.env.DRY_RUN === "true") {
        let ok = 0;
        for (const w of order) {
            const r = fullByKey.get(`${w.scenario}#${w.i}`);
            if (r && r.eventSeed === seedFor(w.scenario, w.i) && r.incidentId) ok++;
        }
        console.log(`paired with Experiment 1 (same seed, incident id present): ${ok}/${order.length}`);
        console.log(`first incident: ${order[0].scenario}#${order[0].i}`);
        setEventSeed(seedFor(order[0].scenario, order[0].i));
        const ev = generateEvents(order[0].scenario as any, EVENTS_PER_INCIDENT);
        setEventSeed(null);
        console.log(`--- SYSTEM PROMPT sha256=${sha256(SYSTEM_PROMPT)}\n--- USER PROMPT:\n${buildDirectPrompt(ev)}`);
        return;
    }

    let results: any[] = [];
    if (fs.existsSync(OUT)) {
        const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
        if (prev.meta.scriptSha256 !== scriptSha || prev.meta.protocolSha256 !== protocolSha) {
            console.error("✗ Script or protocol changed since this run started — refusing to resume.");
            process.exit(1);
        }
        results = prev.results;
    }
    const done = new Set(results.map((r) => `${r.scenario}#${r.runIndex}`));

    const meta = {
        arm: "direct",
        experiment: "secondary: Direct-LLM baseline",
        protocol: PROTOCOL,
        protocolSha256: protocolSha,
        scriptSha256: scriptSha,
        requestedModel: GROQ_MODEL_PLANNING,
        scenarioSet: "held_out",
        runsPerScenario: RUNS_PER_SCENARIO,
        scenarios: [...HELD_OUT_SCENARIOS],
        paired: true,
        interleaved: true,
        workOrderSeed: WORK_ORDER_SEED,
        rubric: RUBRIC_VERSION,
        latencyIsModelCallOnly: true,
        startedAt: results[0]?.at ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    const client = createGroqClient();
    const remainingOf = () => order.filter((w) => !done.has(`${w.scenario}#${w.i}`)).map((w) => ({ scenario: w.scenario, runIndex: w.i }));

    for (const w of order) {
        const key = `${w.scenario}#${w.i}`;
        if (done.has(key)) continue;

        setEventSeed(seedFor(w.scenario, w.i));
        const events = generateEvents(w.scenario as any, EVENTS_PER_INCIDENT);
        setEventSeed(null);
        const userPrompt = buildDirectPrompt(events);
        const paired = fullByKey.get(key);

        const start = Date.now();
        let raw: string | null = null;
        let callStatus: "ok" | "parse_failure" | "unavailable" | "quota_exhausted" | "error" = "ok";
        let errorMessage: string | null = null;
        let quotaHit = false;
        try {
            raw = await client.complete(userPrompt, SYSTEM_PROMPT, GROQ_MODEL_PLANNING);
        } catch (err: any) {
            errorMessage = String(err?.message ?? err);
            if (err instanceof GroqQuotaExhaustedError) { callStatus = "quota_exhausted"; quotaHit = true; }
            else if (err instanceof GroqUnavailableError) callStatus = "unavailable";
            else callStatus = "error";
        }
        const modelLatencyMs = Date.now() - start;
        const callMeta = getLastGroqCallMeta();

        // Same step construction as planning.agent.ts.
        let steps: PlanStepLike[] = [];
        let parsed: any = null;
        if (raw !== null) {
            try {
                parsed = JSON.parse(raw);
                steps = (parsed.steps || []).map((s: any, i: number) => ({
                    stepId: s.stepId || i + 1,
                    action: s.action || "unknown",
                    description: s.description || "",
                    parameters: s.parameters || {},
                }));
            } catch {
                callStatus = "parse_failure";
            }
        }
        const usable = callStatus === "ok";
        const planScore = scorePlan(w.scenario, usable ? steps : []);

        results.push({
            scenario: w.scenario,
            arm: "direct",
            runIndex: w.i,
            eventSeed: seedFor(w.scenario, w.i),
            eventsSha256: sha256(JSON.stringify(events)),
            pairedFullIncidentId: paired?.incidentId ?? null,
            pairedFullEventSeed: paired?.eventSeed ?? null,
            callStatus,
            usable,
            errorMessage,
            modelLatencyMs,
            providerModel: callMeta?.providerModel ?? null,
            promptTokens: callMeta?.promptTokens ?? null,
            completionTokens: callMeta?.completionTokens ?? null,
            reasoningTokens: callMeta?.reasoningTokens ?? null,
            totalTokens: callMeta?.totalTokens ?? null,
            rawOutput: raw,
            planTitle: parsed?.title ?? null,
            planRiskLevel: parsed?.riskLevel ?? null,
            planSteps: usable ? steps : [],
            planScore,
            at: new Date().toISOString(),
        });
        done.add(key);
        meta.updatedAt = new Date().toISOString();
        writeOut(meta, results, remainingOf());

        const n = results.length;
        console.log(`[${n}/100] ${key.padEnd(18)} ${callStatus.padEnd(15)} strict=${planScore.correct ? "Y" : "n"} ` +
            `${modelLatencyMs}ms tok=${callMeta?.totalTokens ?? "-"}`);

        if (quotaHit) {
            console.log("⏸  Daily quota exhausted — checkpointed. Re-run later to resume.");
            process.exit(3);
        }
        if (n < order.length) await new Promise((r) => setTimeout(r, THROTTLE_MS));
    }
    console.log(`✓ Complete: ${results.length}/100 → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
