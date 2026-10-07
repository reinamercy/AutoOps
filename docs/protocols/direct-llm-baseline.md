# Frozen protocol: Direct-LLM baseline (secondary experiment)

**Status: FROZEN.** This file was committed before the first model call of
this experiment. It must not be edited after outcomes are observed. Each
result record stores this file's SHA-256, and the runner refuses to resume
if the file or the script has changed.

- Runner: `scripts/direct-llm-baseline.ts`
- Analysis: `scripts/direct-llm-analysis.ts`
- Output: `scripts/eval-heldout-direct-gptoss120b.json`

## 1. Question

Experiment 1's rule-based baseline has no held-out answer by construction, so
it cannot separate the contribution of the AutoOps pipeline from the
capability of the underlying model. This experiment asks: **given the same
held-out incident, does the AutoOps full arm produce strictly correct plans
more or less often than the same model prompted directly with the raw
incident evidence?**

This is a **secondary comparative experiment**. Experiments 1 and 2 remain
the primary results and are not altered.

## 2. Incidents

- The same 100 held-out incidents as Experiment 1: the classes `cert_expiry`,
  `dns_failure`, `config_drift`, `cpu_throttling` and `db_deadlock`, with
  run indices 0–19 for each.
- Content: `generateEvents(scenario, 20)` under the per-incident seed
  `seedFor(scenario, runIndex)` (FNV-1a over `"scenario#runIndex"`). This is
  identical to `scripts/eval-harness.ts` with `PAIRED=true`.
- A dry run, which makes no model call, confirmed that 100/100 incidents pair
  with an Experiment 1 record of the same seed.
- Each record stores `eventsSha256` (a hash of the exact events sent) and the
  paired full-arm `incidentId`.
- Work order: `buildWorkOrder(HELD_OUT_SCENARIOS, 20, interleave=true,
  seed=1337)`, the same order Experiment 1 used. Its first incident is
  `db_deadlock#5`.

## 3. Model and call parameters (identical to the full arm)

- Provider: Groq. Model: `openai/gpt-oss-120b` (the runner aborts on any
  other `GROQ_MODEL_PLANNING`).
- Call path: `GroqClient.complete()` in `src/services/groq.client.ts`, the
  same client and retry logic the planning agent uses, with:
  - `temperature = 0.1`
  - `max_tokens = 2048`
  - `response_format = {type: "json_object"}`
  - client retry on per-minute 429 (backoff 1 s / 2 s) and on
    `400 json_validate_failed`
  - the same circuit breaker.
- **System prompt:** `SYSTEM_PROMPT` exported unchanged from
  `src/agents/planning.agent.ts` (sha256
  `9f8cc7f3f3fed209da4e61d908fabbb53c12295dca33c160f772fdea92a1ed06`). It
  contains the required JSON output schema, the 10-action vocabulary and the
  planner's rules. The only code change was adding `export`.
- **User prompt** (`buildDirectPrompt` in the runner), verbatim:

  ```
  ## Incident Evidence
  The monitoring pipeline received the following 20 raw events (JSON, one per line):
  <one compact JSON object per event, in generated order>

  Diagnose the most likely root cause from this evidence alone, then generate the remediation plan as JSON.
  ```

## 4. What the Direct arm receives and does not receive

**Receives:** the 20 raw `RawEvent` objects that `POST /api/incidents/trigger`
receives in Experiment 1, plus the system prompt above.

**Does not receive:**
- the Monitoring agent's classification (issue type, severity summary,
  anomaly score);
- the RCA output (category, description, confidence, remediation hint,
  dependency path, evidence list);
- templates, memory or cached fixes, or retrieved history;
- risk-score information;
- execution feedback or retry context;
- any previous incident.

No server is involved; each call is independent.

## 5. Failure handling (frozen; mirrors Experiment 1)

- One record per incident, in work order. No incident is rerun selectively.
- Every failure the shared client raises is recorded, and the incident
  counts as **incorrect under intent-to-treat (ITT)**:
  - `quota_exhausted`: daily quota;
  - `unavailable`: network, 5xx or circuit open;
  - `error`: other 4xx, or a per-minute 429 that outlasts the client's retries;
  - `parse_failure`: the response is not valid JSON.
- This matches Experiment 1, where a failed model call was scored on the
  hardcoded fallback plan. That plan scores 0/20 strict on every held-out
  class, so the strict-correctness effect is the same.
- **Daily-quota exhaustion is the only pause trigger.** As in Experiment 1,
  the incident whose call returns it is recorded as `quota_exhausted`. The
  runner then checkpoints and exits (code 3), and a later invocation resumes
  at the first unattempted incident.
- Pacing: 35 s between calls, to stay under the 8,000 tokens/minute limit.
- Plans are scored exactly as returned. Unlike the pipeline, there is no step
  validation, retry or re-planning; an empty plan is incorrect.

## 6. Scoring

Frozen rubric `strict-1` (`scorePlan` in `src/evaluation/plan-scoring.ts`),
unchanged. Steps are built from the response exactly as `planning.agent.ts`
builds them; a missing action becomes `"unknown"`.

## 7. Pre-specified analysis (`scripts/direct-llm-analysis.ts`)

1. Strict correctness, ITT over all 100 incidents, with a Wilson 95% CI.
2. Usable model-call count (`callStatus = ok`), and strict correctness over
   usable calls.
3. Containment (lenient) and mean action precision over usable model plans.
   The full arm is compared over its 93 usable model plans, like for like.
4. Per-class strict correctness (ITT).
5. Model-call latency: median, IQR and bootstrap 95% CI of the median.
   **This is model-call latency only and is not comparable to Experiment 1's
   end-to-end pipeline latency.**
6. **Primary comparison:** exact two-sided McNemar test (binomial on
   discordant pairs) on strict correctness, ITT. AutoOps full arm versus
   Direct, paired by `scenario#runIndex`, over all 100 incidents. Report both
   discordant counts.
7. **Pre-specified secondary comparison:** the same test restricted to pairs
   where both arms obtained a usable model plan.
8. Exact per-class McNemar is reported descriptively, with no multiplicity
   claim.

The result is reported whichever arm wins, including a tie. Neither the
prompt nor the protocol is modified based on the outcome.

## 8. Interpretation limits (stated in advance)

- The Direct arm sees raw events that include each event's `eventType`
  field. So does the full arm's Monitoring agent. Neither arm is given a
  class label beyond what the events themselves contain.
- A Direct-arm advantage would mean the pipeline's contextualization does not
  improve strict plan correctness over the bare model on these incidents. A
  full-arm advantage would mean it does, on this synthetic benchmark and this
  rubric only.
- The rubric is author-defined. The incidents are synthetic and come from one
  author-written generator.

## 9. Human rubric-validation packet: sampling plan (frozen with this protocol)

`scripts/make-validation-packet.ts`:
- Draws 50 plans with seed 20261007: 5 per class from the full arm's
  model-sourced plans and 5 per class from the Direct arm's usable plans.
- If a class has fewer than 5 usable plans in an arm, it takes all of them
  and records the shortfall.
- Selection depends only on the seed and on usability, never on rubric
  outcome.
- Items are shuffled and blinded: no arm, source, model or rubric outcome is
  shown.
- No expert-validation claim will be made without real returned ratings.
