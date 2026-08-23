# ⚙️ AutoOps AI — Technical Implementation Guide

> **Target Audience:** Engineering Leadership, Principal SREs, System Architects, Code Reviewers.
>
> *Exhaustive, code-level breakdown of how data moves through the system — what is real, what is simulated, and exactly how every decision is made.*

---

## 1. System Architecture

AutoOps AI is an event-driven, multi-agent orchestration engine. Six specialized agents work in a stateful pipeline coordinated by a Redux-like state machine (`IncidentState`). Agents cannot mutate global state directly — each returns a state patch the orchestrator merges, guaranteeing thread safety and an immutable audit trail.

```
Raw Events (HTTP/EventBus)
        ↓
  Monitoring Agent      ← Ensemble anomaly detection (Z-score + pattern + rules)
        ↓ anomaly > 0.7
  RCA Agent             ← Service dependency graph traversal (13-node map)
        ↓
  Planning Agent        ← Template → Memory → Groq LLM → Fallback
        ↓
  SLA Agent             ← Priority scoring (P0–P4)
        ↓
  Decision Engine       ← Risk scoring → auto / notify / approve / block
        ↓
  Execution Agent       ← Runs steps (simulate / shadow / live mode)
        ↓ failed → back to Planning (max 3 retries)
  Feedback Agent        ← Stores fix → vector store + cache → RL score update
```

---

## 2. What Is Real vs Simulated

Every backend below is **real when its service is reachable, and falls back automatically
to an equivalent in-process implementation when it isn't** — same pattern for all five
(Postgres, Redis, ChromaDB, Kafka, Kubernetes). Nothing in the pipeline needs to know
which mode it's in; `GET /api/debug/stores` reports the live mode (`"real"` or
`"...-fallback"`) for each one.

### REAL when the backing service is reachable (fallback otherwise)

| Component | Real implementation | Fallback | Where |
|---|---|---|---|
| **PostgreSQL** | `pg` — genuine `Pool`, runs `src/db/migrations/*.sql` on startup | In-memory `Map`-backed store, same query surface | `services/database.ts` |
| **Redis** | `ioredis` — genuine `SET ... EX` / `GET` / `KEYS` | In-process `Map` with manual TTL sweep | `services/redis.client.ts` |
| **ChromaDB** | `chromadb` client — `DefaultEmbeddingFunction` (Xenova/all-MiniLM-L6-v2, same model family as `paper/reference.pdf`'s Sentence-BERT), cosine-space collection | In-process TF-IDF cosine similarity | `services/chroma.client.ts` |
| **Kafka** | `kafkajs` — genuine producer + consumer group (`autoops-agents`) | In-process `EventEmitter` bus | `services/kafka.service.ts` |
| **Kubernetes** | `@kubernetes/client-node` — real Deployment API calls, verified against a disposable local `kind` cluster (see §6a) | Realistic simulated output | `services/k8s.client.ts` |

### Always real (no fallback — these never had a stub)

| Component | What happens |
|---|---|
| **Groq LLM** | Real HTTPS API call to Groq cloud — generates actual remediation plan |
| **Anomaly detection** | Real algorithm — Z-score, pattern matching, rule-based ensemble |
| **Root cause analysis** | Real dependency graph traversal — 13-node service map with impact tracing |
| **Risk scoring** | Real formula — blast radius, confidence, SLA, rollback, source |
| **Decision routing** | Real logic — auto/notify/approve/block tier assignment |
| **Command validation** | Real regex — blocks `kubectl delete namespace`, `rm -rf /`, `DROP TABLE` etc. |
| **Human approval gate** | Real — waits for actual API call to `/api/v1/approvals/:id/decision` |
| **Go ingester** | `go-ingester/` — publishes real `RawEvent[]` JSON to the same Kafka topic the TS consumer reads; no longer a standalone PoC (see `go-ingester/README.md`) |

### SIMULATED (hardcoded fake output, `EXECUTION_MODE=simulate`)

| Component | Where | What's fake |
|---|---|---|
| **Execution output** | `execution.agent.ts` `simulateAction()` | All kubectl/docker output is hardcoded strings |
| **Step timing** | `execution.agent.ts` `simulateAction()` | Fake delays (`setTimeout`) — not real kubectl latency |
| **5% failure rate** | `execution.agent.ts` `simulateAction()` | `Math.random() < 0.05` — not a real cluster failure |
| **Raw events** | `simulator/log-producer.ts` | Generated fake Kubernetes events, not real cluster logs |

**Execution modes:** `EXECUTION_MODE=simulate` (default) → `shadow` (real API calls with server-side `dryRun:"All"` — nothing persists) → `live` (real execution).

**Important scope limit:** only 4 of the 10 plan actions are K8s-backed —
`restart_service`, `scale_deployment`, `update_resource_limits`, `verify_health`. The
other 6 (`rollback_deployment`, `clear_disk_space`, `flush_connection_pool`,
`apply_config`, `trigger_pipeline`, `rolling_restart`) stay simulated even in
shadow/live mode — they're app-level/CI concerns a Deployment patch can't express, not
things worth faking a K8s client for. See §6a for what "real" was actually verified to
mean here.

---

## 3. Anomaly Detection (Monitoring Agent)

Ensemble of three detectors — each contributes a weighted score:

```
anomalyScore = 0.3 × statisticalScore
             + 0.4 × patternScore
             + 0.3 × rulesScore
```

**Statistical score:** Z-score deviation on severity distribution and error event ratios.

**Pattern score:** Matches known failure patterns:
- `OOMKilled`, `CrashLoopBackOff`, `ImagePullBackOff`
- Error rate spike, CPU saturation, disk full
- Connection pool exhaustion, service unreachable

**Rules score:**
- Multiple critical events from same service
- Rapid succession events (within 30 seconds)
- Cascading failures across dependent services

Threshold: `ANOMALY_THRESHOLD=0.7` — below this, events are silently dropped.

---

## 4. Planning Agent — Priority Chain

```
1. Template Service (deterministic, pre-validated — no LLM needed)
     → 6 templates: CrashLoopBackOff, high memory, high CPU,
       ImagePullBackOff, endpoints not ready, PVC not bound
     → If template matches: confidence=0.95, riskLevel=low, done.

2. Memory Service (past proven fixes via vector search + cache)
     → Check Redis/InProcessCache for fingerprint (sha256 of service:type:severity)
     → HIT: Return cached fix instantly
     → MISS: Query TF-IDF vector store (similarity ≥ 0.82)
     → Found: Return fix, write to cache, done.

3. Groq LLM (only when 1 and 2 both miss)
     → RAG: query vector store for similar incidents → inject as context
     → Call llama-3.3-70b-versatile with structured JSON output
     → Circuit breaker: 3 failures → 5-min bypass → auto-closes
     → On GroqUnavailableError: fall through to step 4

4. Fallback Plan (hardcoded category-based steps)
     → memory_leak: scale_deployment + rolling_restart + update_resource_limits
     → application_crash: rollback_deployment + verify_health
     → resource_exhaustion: scale_deployment + verify_health
     → default: restart_service + verify_health
```

**Exception:** `service_down` incidents skip steps 1 & 2 — always goes to Groq LLM for a fresh, context-aware plan.

---

## 5. Risk Scoring Engine

```
score = (blastRadius × 20)            // plan.riskLevel: critical=5, high=3, else=2
      + (1 – confidence) × 30         // lower confidence = higher risk
      + (critical severity ? +15 : 0) // SLA penalty for critical incidents
      – (hasRollbackPlan ? 20 : 0)    // rollback = safer
      – (template source ? 25 : 0)    // pre-validated = much safer
      – (trustworthy memory ? 15 : 0) // 3+ successful past uses
      – (untrusted memory ? 5 : 0)    // memory hit but unproven
      clamped [0, 100]
```

**Tier assignment:**
```
score  0–34  → AUTO    execute immediately
score 35–64  → NOTIFY  execute + Slack alert
score 65–84  → APPROVE pause, wait for human
score 85–100 → BLOCK   never executes, escalate
```

**Override rules (applied after scoring):**
1. Command `REQUIRE_REVIEW` pattern found → tier bumped to `approve` minimum
2. Command `HARD_BLOCKED` found → always `block`, score = 100
3. Template + approve/block tier → downgraded to `notify` (pre-validated = safe)
4. OOM kill (`pod_crash` + `memory_leak`) → score = 100, tier = `approve`

**Hard-blocked commands (can never execute):**
```
kubectl delete namespace
kubectl delete --all
DROP TABLE / DROP DATABASE
DELETE FROM (without WHERE)
rm -rf /
chmod 777 /
curl ... | bash
```

---

## 6. Fallback Services (used when Docker/real infra isn't reachable)

Each of these connects to a real backend first; the in-process version below only
activates if that connection attempt fails at startup. Every one of the five backends
(Postgres, Redis, ChromaDB, Kafka, Kubernetes) follows this same shape: try real
connection with a short timeout → on failure, log a `warn` and swap in the fallback →
callers never know which one they're talking to.

### Vector Store (ChromaDB fallback)

File: `src/services/chroma.client.ts`

- Real mode: `chromadb` client, `DefaultEmbeddingFunction` (Xenova/all-MiniLM-L6-v2), cosine-space collection
- Fallback: TF-IDF (Term Frequency–Inverse Document Frequency) cosine similarity, in-process array
- `storeIncident(id, document, metadata)` — real: `collection.upsert(...)`; fallback: pushes to in-memory array
- `querySimilarIncidents(queryText, topK)` — returns sorted by distance (lower = closer) either way
- Inspect live contents + which mode is active: `GET /api/debug/stores`

### Cache (Redis fallback)

File: `src/services/redis.client.ts`

- Real mode: `ioredis`, genuine `SET key value EX ttl`
- Fallback: `InProcessCache` — `Map<key, { value, expiresAt }>`, entries auto-expire on read
- 30-minute TTL per cached fix (both modes)
- Key = `fix:` + SHA-256 fingerprint(service:incidentType:severity)[0:16]
- Populated by `memoryService.storeFix()` after every resolved incident

### Event Bus (Kafka fallback)

File: `src/services/kafka.service.ts`

- Real mode: `kafkajs` producer + consumer group (`autoops-agents`), topic `autoops.raw-events`
- Fallback: Node.js `EventEmitter` on the same topic name
- `subscribeAndConsume(topic, handler)` — real: `consumer.run({eachMessage})`; fallback: `bus.on(topic, handler)`
- `publishEvents(topic, events)` — real: `producer.send(...)`; fallback: `bus.emit(topic, events)`
- Wired in `POST /api/simulate` — events flow through the bus AND the pipeline simultaneously
- The Go ingester (`go-ingester/`) publishes onto this same real topic — see its README

---

## 6a. Kubernetes Execution — Verified Scope

`src/services/k8s.client.ts` wraps `@kubernetes/client-node`. `initK8s()` runs once at
startup (only if `EXECUTION_MODE` isn't `simulate`): loads kubeconfig, then does a real
`listNamespacedDeployment` probe — `KubeConfig.loadFromDefault()` does **not** throw when
no kubeconfig exists, it silently falls back to a dummy `http://localhost:8080` target,
so "config loaded" is not the same as "cluster reachable."

Only 4 of the 10 plan actions are K8s-backed (the rest stay simulated — see §2):

| Action | K8s call |
|---|---|
| `restart_service` | JSON-Patch add of `kubectl.kubernetes.io/restartedAt` annotation |
| `scale_deployment` | JSON-Patch replace of `spec.replicas` |
| `update_resource_limits` | Read container, JSON-Patch add merged `resources.limits` |
| `verify_health` | Read deployment, compare `status.readyReplicas` to `spec.replicas` |

Patches are JSON Patch (RFC 6902) arrays, not strategic-merge-patch objects — this
client version's generated code negotiates `Content-Type: application/json-patch+json`
for `patchNamespacedDeployment` and doesn't expose a way to override it, so the body
shape has to match. `shadow` mode passes the API's real `dryRun: "All"` query param
(server validates and would-apply, but persists nothing) rather than faking a
`[SHADOW MODE]` string.

**This was verified against a real, disposable local cluster**, not just unit-tested:
`kind create cluster` → `kubectl create deployment dummy-app` → ran AutoOps with
`EXECUTION_MODE=shadow` (confirmed deployment generation stayed at 1, nothing persisted)
→ ran again with `EXECUTION_MODE=live` (confirmed generation bumped 1→2, a real
`restartedAt` annotation appeared, pods actually rolled, `scale_deployment` genuinely
scaled 2→6 replicas, `update_resource_limits` genuinely set `resources.limits`) →
`kind delete cluster`. The cluster no longer exists; this section documents what was
proven, not a live environment.

---

## 7. Human Approval Gate

When risk tier is `approve` or `block`:

```
1. Decision Engine returns { action: "escalate_human" }
2. Workflow calls ApprovalService.createRequest()
   → Creates record in approvals store
   → Broadcasts "approval_required" to all WebSocket clients
   → Dashboard shows approval buttons immediately
3. Workflow polls DB every 5 seconds for decision
4. Timeout: 10 minutes (APPROVAL_TIMEOUT_MS=600000)
5. Human calls POST /api/v1/approvals/:id/decision
   → { decision: "APPROVED", approverId: "...", comment: "..." }
6. Workflow detects decision → proceeds to execution (or terminates)
```

**Grouping:** Multiple incidents for the same service+namespace within 5 minutes are grouped into one approval request.

---

## 8. Feedback Loop & Learning

After every resolved incident, `feedbackAgent` stores the fix so future identical incidents use cache instead of LLM:

```typescript
// 1. Store in vector store for semantic retrieval
storeIncident(fixId, descriptionText, metadata);

// 2. Store in DB (stored_fixes table) with RL score
db.query("INSERT INTO stored_fixes ...", [fixId, incidentType, errorSignature, fixSteps, 0.5, 0, 0]);

// 3. Write to Redis/InProcessCache (30-min TTL)
redis.set("fix:" + fingerprint, JSON.stringify(storedFix), "EX", 1800);

// 4. Update RL score after execution (fire-and-forget)
newScore = 0.7 × oldScore + 0.3 × reward
// reward: success + SLA met = 1.0, success + SLA missed = 0.6, failure = 0.1
```

After 3+ successful uses (`TRUST_THRESHOLD_SUCCESS_COUNT=3`), the fix becomes **trustworthy** → risk score drops by 15 points → more likely to auto-execute without human approval.

---

## 9. Metrics & Observability

**Prometheus endpoint:** `GET /api/prometheus` — standard Prometheus text format.

**Persistence:** Metrics written to `metrics.json` on every pipeline event. Loaded on startup so restarts don't lose historical data.

**In-process metrics tracked:**
```
incidentsTotal       autoResolutionRate    avgMttrSeconds
incidentsResolved    incidentsFailed       incidentsEscalated
incidentsActive      totalMttrMs           resolvedCount
```

**WebSocket:** Every agent state change broadcasts a real-time event to connected dashboard clients. New clients receive a replay of any pending approval so they never miss a waiting decision.

---

## 10. Corporate SSL Fix

Enterprise lab environments use SSL inspection proxies that re-sign HTTPS traffic with a corporate CA. Node.js rejects these connections by default (`unable to get local issuer certificate`).

**Fix in `start.ps1`:**
```powershell
# Export 52 Windows trusted root CAs to PEM
Get-ChildItem Cert:\LocalMachine\Root | ForEach-Object {
    # ... export each cert to PEM format
}
# Tell Node.js to trust them
$env:NODE_EXTRA_CA_CERTS = "$PSScriptRoot\corporate-ca.pem"
```

This is the **secure** fix — adds your corporate CA to Node.js's trust store. Does not disable SSL verification.
