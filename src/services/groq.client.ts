/**
 * AutoOps AI — Enterprise Groq LLM Client
 * Wraps groq-sdk with structured output, retries, graceful degradation.
 *
 * REPLACES the previous simple groq.client.ts.
 * Keeps the same exported function name (queryLLM) for backward compat.
 */
import Groq from "groq-sdk";
import { config } from "../config";
import { createChildLogger } from "../utils/logger";
import { GroqParseError, GroqUnavailableError, GroqClientError } from "./enterprise-types";

const log = createChildLogger("GroqClient");

// ── Re-export error types for consumers ──
export { GroqParseError, GroqUnavailableError, GroqClientError };

// ── Circuit breaker state (module-level singleton) ──
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 5 * 60 * 1000; // 5 minutes

let circuitOpen = false;
let circuitOpenUntil = 0;
let consecutiveFailures = 0;

// ── Last-call metadata (evaluation harness reads this via a debug endpoint
// to record the provider-returned model id and real token usage per call —
// queryLLM's own return type predates this and is left alone to avoid
// touching every call site). ──
export interface GroqCallMeta {
    requestedModel: string;
    providerModel: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    reasoningTokens: number | null;
    at: string;
}
let lastCallMeta: GroqCallMeta | null = null;
export function getLastGroqCallMeta(): GroqCallMeta | null {
    return lastCallMeta;
}

// Sticky until the next call attempt starts, so a debug endpoint hit right
// after a fallback can tell "quota exhausted" apart from any other failure.
let lastCallWasQuotaExhaustion = false;
export function wasLastGroqCallQuotaExhaustion(): boolean {
    return lastCallWasQuotaExhaustion;
}

/** True when Groq's 429 body names a per-day (not per-minute) limit — retrying won't help for hours. */
function isDailyQuotaExhaustion(message: string): boolean {
    return /\b(TPD|RPD)\b|per day|tokens per day|requests per day/i.test(message || "");
}

export class GroqQuotaExhaustedError extends GroqUnavailableError {
    constructor(message: string, cause: Error) {
        super(message, cause);
        this.name = "GroqQuotaExhaustedError";
    }
}

function checkCircuit(): void {
    if (!circuitOpen) return;
    if (Date.now() >= circuitOpenUntil) {
        circuitOpen = false;
        consecutiveFailures = 0;
        log.info("Groq circuit breaker CLOSED — resuming LLM calls");
        return;
    }
    const remainingSec = Math.ceil((circuitOpenUntil - Date.now()) / 1000);
    const msg = `Groq circuit breaker open — skipping LLM for ${remainingSec}s`;
    throw new GroqUnavailableError(msg, new Error(msg));
}

function recordSuccess(): void {
    consecutiveFailures = 0;
}

function recordFailure(): void {
    consecutiveFailures++;
    if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD && !circuitOpen) {
        circuitOpen = true;
        circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
        log.warn(
            { openUntil: new Date(circuitOpenUntil).toISOString(), failures: consecutiveFailures },
            "Groq circuit breaker OPENED — 3 consecutive failures"
        );
    }
}

// ── Config from env ──
const GROQ_API_KEY = process.env.GROQ_API_KEY || config.groq.apiKey;
const GROQ_MODEL_PLANNING = process.env.GROQ_MODEL_PLANNING || "llama-3.3-70b-versatile";
const GROQ_MODEL_FAST = process.env.GROQ_MODEL_FAST || "llama-3.1-8b-instant";
const SLOW_RESPONSE_MS = 2000;

// ── Injectable GroqClient class ──

export class GroqClient {
    private client: Groq;
    private defaultModel: string;

    constructor(apiKey: string, defaultModel: string = GROQ_MODEL_PLANNING) {
        this.client = new Groq({ apiKey });
        this.defaultModel = defaultModel;
        log.info({ model: defaultModel }, "GroqClient initialized");
    }

    /**
     * Simple text completion.
     */
    async complete(prompt: string, systemPrompt?: string, model?: string): Promise<string> {
        const targetModel = model || this.defaultModel;
        const start = Date.now();

        const messages: Array<{ role: "system" | "user"; content: string }> = [];
        if (systemPrompt) {
            messages.push({ role: "system", content: systemPrompt });
        }
        messages.push({ role: "user", content: prompt });

        const response = await this.callWithRetry(messages, targetModel);
        const latency = Date.now() - start;

        if (latency > SLOW_RESPONSE_MS) {
            log.warn({ latency, model: targetModel }, "Slow Groq response (>2000ms)");
        }

        return response;
    }

    /**
     * Structured JSON completion with parse retry and regex fallback.
     */
    async completeStructured<T>(
        prompt: string,
        schemaDescription: string,
        systemPrompt?: string,
        model?: string
    ): Promise<T> {
        const targetModel = model || this.defaultModel;
        const start = Date.now();

        const fullSystemPrompt = [
            systemPrompt || "",
            "\nRespond ONLY with a valid JSON object. No markdown, no backticks, no explanation.",
            `The JSON must match this schema exactly: ${schemaDescription}`,
        ].join("\n");

        const messages: Array<{ role: "system" | "user"; content: string }> = [
            { role: "system", content: fullSystemPrompt },
            { role: "user", content: prompt },
        ];

        const rawResponse = await this.callWithRetry(messages, targetModel);
        const latency = Date.now() - start;

        if (latency > SLOW_RESPONSE_MS) {
            log.warn({ latency, model: targetModel }, "Slow Groq response (>2000ms)");
        }

        // Attempt 1: Direct parse
        try {
            return JSON.parse(rawResponse) as T;
        } catch {
            log.warn("First JSON parse failed, retrying with stricter prompt");
        }

        // Attempt 2: Retry with stricter prompt
        try {
            const retryMessages: Array<{ role: "system" | "user"; content: string }> = [
                {
                    role: "system",
                    content: `You responded with invalid JSON. Respond again with ONLY the raw JSON object, nothing else. Schema: ${schemaDescription}`,
                },
                { role: "user", content: prompt },
            ];
            const retryResponse = await this.callWithRetry(retryMessages, targetModel);
            return JSON.parse(retryResponse) as T;
        } catch {
            log.warn("Second JSON parse failed, attempting regex extraction");
        }

        // Attempt 3: Regex-based field extraction
        try {
            return this.regexExtract<T>(rawResponse);
        } catch {
            // All attempts failed
            log.error(
                { prompt: prompt.substring(0, 200) },
                "All JSON parse attempts failed"
            );
            throw new GroqParseError(
                "Failed to parse Groq response as JSON after 3 attempts",
                rawResponse
            );
        }
    }

    /**
     * Internal: call Groq with exponential backoff on 429 (rate limit).
     * Returns GroqUnavailableError on network/5xx errors.
     */
    private async callWithRetry(
        messages: Array<{ role: "system" | "user"; content: string }>,
        model: string,
        maxAttempts: number = 3
    ): Promise<string> {
        // Fail fast if circuit is open
        checkCircuit();

        // Cleared per call (not per attempt): if every attempt in THIS call
        // fails, lastCallMeta must read as "no usage from this call", not
        // silently carry over token counts from a previous incident's
        // successful call — that would misattribute usage to an incident
        // that never got billed for it.
        lastCallMeta = null;

        const delays = [1000, 2000, 4000];

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                lastCallWasQuotaExhaustion = false;
                const completion = await this.client.chat.completions.create({
                    model,
                    temperature: config.groq.temperature,
                    max_tokens: config.groq.maxTokens,
                    messages,
                    response_format: { type: "json_object" },
                });

                const content = completion.choices[0]?.message?.content || "{}";
                const usage = completion.usage as
                    | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
                        completion_tokens_details?: { reasoning_tokens?: number } }
                    | undefined;
                lastCallMeta = {
                    requestedModel: model,
                    providerModel: completion.model || null,
                    promptTokens: usage?.prompt_tokens ?? null,
                    completionTokens: usage?.completion_tokens ?? null,
                    totalTokens: usage?.total_tokens ?? null,
                    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
                    at: new Date().toISOString(),
                };
                log.info({ model, providerModel: completion.model, tokensUsed: usage?.total_tokens, attempt }, "Groq response received");
                recordSuccess();
                return content;
            } catch (err: unknown) {
                const error = err as Error & { status?: number; statusCode?: number };

                // Re-throw circuit breaker errors immediately (don't record as new failure)
                if (err instanceof GroqUnavailableError && (error.message || "").includes("circuit breaker")) {
                    throw err;
                }

                const statusCode = error.status || error.statusCode || 0;
                const bodyMessage =
                    (error as any).error?.error?.message || (error as any).error?.message || error.message || "";

                // Daily quota exhaustion won't clear within a few seconds of backoff —
                // surface it distinctly so the harness can pause/checkpoint instead of
                // burning retries and recording a false "fallback" plan.
                if (statusCode === 429 && isDailyQuotaExhaustion(bodyMessage)) {
                    lastCallWasQuotaExhaustion = true;
                    throw new GroqQuotaExhaustedError(`Groq daily quota exhausted: ${bodyMessage}`, error);
                }

                // Rate limit (per-minute) — retry with backoff
                if (statusCode === 429 && attempt < maxAttempts - 1) {
                    const delay = delays[attempt] || 4000;
                    log.warn({ attempt, delay }, "Groq rate limited (429), backing off");
                    await this.sleep(delay);
                    continue;
                }

                // Groq's own server-side JSON-schema validator rejected a malformed
                // generation (400 json_validate_failed) — discovered while migrating
                // to gpt-oss-120b, a reasoning model more prone to this than
                // llama-3.3-70b-versatile was. This is a sampling glitch, not a
                // structural failure of the prompt, so it's worth one immediate
                // retry rather than converting straight to a recorded "fallback"
                // and inflating the fallback rate with something a regenerate fixes.
                if (statusCode === 400 && /json_validate_failed/i.test(bodyMessage) && attempt < maxAttempts - 1) {
                    log.warn({ attempt }, "Groq rejected malformed JSON (400 json_validate_failed), retrying");
                    await this.sleep(500);
                    continue;
                }

                // Network error or 5xx — Groq is unavailable
                if (statusCode === 0 || statusCode >= 500) {
                    recordFailure();
                    throw new GroqUnavailableError(
                        `Groq unavailable: ${error.message}`,
                        error
                    );
                }

                // Other errors — throw directly (don't count toward circuit)
                throw new GroqClientError(
                    `Groq request failed: ${error.message}`,
                    statusCode
                );
            }
        }

        // Exhausted all retries on rate-limit
        recordFailure();
        throw new GroqClientError("Groq request failed after all retries", 429);
    }

    /**
     * Last-resort regex extraction for key-value pairs.
     */
    private regexExtract<T>(raw: string): T {
        // Try to find a JSON object in the response
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]) as T;
        }

        // Extract key:value pairs
        const kvRegex = /"(\w+)"\s*:\s*("(?:[^"\\]|\\.)*"|\d+(?:\.\d+)?|true|false|null|\[[\s\S]*?\]|\{[\s\S]*?\})/g;
        const obj: Record<string, unknown> = {};
        let match: RegExpExecArray | null;
        while ((match = kvRegex.exec(raw)) !== null) {
            const key = match[1];
            try {
                obj[key] = JSON.parse(match[2]);
            } catch {
                obj[key] = match[2];
            }
        }

        if (Object.keys(obj).length === 0) {
            throw new Error("No extractable fields found in response");
        }

        return obj as T;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// ── Singleton instance (backward compat) ──

let defaultClient: GroqClient | null = null;

function getDefaultClient(): GroqClient {
    if (!defaultClient) {
        if (!GROQ_API_KEY) {
            throw new Error("GROQ_API_KEY is not set in environment variables");
        }
        defaultClient = new GroqClient(GROQ_API_KEY, GROQ_MODEL_PLANNING);
    }
    return defaultClient;
}

// ── Backward-compatible exports ──

export interface LLMResponse {
    content: string;
    model: string;
    tokensUsed: number;
    latencyMs: number;
}

/**
 * Backward-compatible queryLLM function.
 * Used by existing planning.agent.ts import.
 */
export async function queryLLM(
    systemPrompt: string,
    userPrompt: string
): Promise<LLMResponse> {
    const client = getDefaultClient();
    const start = Date.now();

    try {
        const content = await client.complete(userPrompt, systemPrompt, GROQ_MODEL_PLANNING);
        const latencyMs = Date.now() - start;
        const meta = getLastGroqCallMeta();
        return {
            content,
            model: meta?.providerModel || GROQ_MODEL_PLANNING,
            tokensUsed: meta?.totalTokens ?? 0,
            latencyMs,
        };
    } catch (err: unknown) {
        if (err instanceof GroqUnavailableError) {
            throw err; // Let planning agent handle gracefully
        }
        throw err;
    }
}

/** Export model constants for consumers */
export { GROQ_MODEL_PLANNING, GROQ_MODEL_FAST };

/** Export factory for injectable instances */
export function createGroqClient(apiKey?: string, model?: string): GroqClient {
    return new GroqClient(
        apiKey || GROQ_API_KEY,
        model || GROQ_MODEL_PLANNING
    );
}
