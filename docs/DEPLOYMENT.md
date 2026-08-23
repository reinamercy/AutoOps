# 🚀 AutoOps AI — Deployment Guide

> **No Docker required.** The system runs fully standalone using in-process replacements
> for Redis, ChromaDB, and Kafka.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | v22.x | Portable — no installation needed (see below) |
| Groq API Key | — | Free at [console.groq.com](https://console.groq.com) |
| Corporate CA cert | — | Auto-exported by start.ps1 for SSL proxy environments |

---

## Quick Start (No Docker, No Admin Rights)

### 1. Configure Environment

```powershell
# Copy example config
cp .env.example .env

# Edit .env — set your Groq API key
GROQ_API_KEY=gsk_your_key_here
```

### 2. Install Dependencies

```powershell
$node = "C:\Users\<you>\node-portable\node-v22.15.0-win-x64"
& "$node\node.exe" .\node_modules\npm\bin\npm-cli.js install
```

### 3. Start the System

```powershell
.\start.ps1
```

The script handles:
- Setting `NODE_EXTRA_CA_CERTS` → exports Windows trusted root CAs to `corporate-ca.pem` for SSL proxy environments
- Setting `PATH` to the portable Node.js binary
- Starting the server with `tsx` (TypeScript runner — no compile step needed)

### 4. Verify Running

```powershell
# Health check
curl http://localhost:3000/api/health

# Check all in-process services
curl http://localhost:3000/api/debug/stores
```

### 5. Trigger a Test Incident

```powershell
curl -X POST http://localhost:3000/api/simulate `
  -H "Content-Type: application/json" `
  -d '{"scenario":"oom_kill","eventCount":30}'
```

---

## What Runs Without Docker

Each service below is attempted for real at startup with a short connection timeout;
if that fails, the app automatically swaps in the fallback and keeps running — you
don't need to do anything to trigger this, it's not a manual toggle.

| Service | With Docker | Without Docker (automatic fallback) |
|---|---|---|
| **ChromaDB** | Real `chromadb` client, Sentence-Transformer embeddings | In-process TF-IDF vector store |
| **Redis** | Real `ioredis` connection | In-process TTL Map (30-min cache) |
| **Kafka** | Real `kafkajs` producer + consumer group | In-process EventEmitter bus |
| **PostgreSQL** | Real `pg` connection, runs migrations on startup | In-memory store with same API |
| **Groq LLM** | Cloud API (no fallback — this one has always been real) | Cloud API (SSL fixed) |

Check which mode is actually active at any time: `GET /api/debug/stores` reports
`mode: "real"` or `mode: "...-fallback"` for each of the four.

---

## SSL Corporate Proxy Fix

In enterprise/lab environments with SSL inspection proxies, Node.js rejects HTTPS calls with:
```
Error: unable to get local issuer certificate
```

`start.ps1` automatically fixes this by exporting Windows trusted root CAs:

```powershell
# Exports 52 corporate root CAs to a PEM file
# Sets NODE_EXTRA_CA_CERTS so Node.js trusts the proxy
$env:NODE_EXTRA_CA_CERTS = "$PSScriptRoot\corporate-ca.pem"
```

This is the **secure** approach — it adds your corporate CA to Node.js's trust store without disabling SSL verification.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GROQ_API_KEY` | ✅ | — | Groq LLM API key |
| `GROQ_MODEL_PLANNING` | — | `llama-3.3-70b-versatile` | Planning model |
| `GROQ_MODEL_FAST` | — | `llama-3.1-8b-instant` | Fast model |
| `PORT` | — | `3000` | API server port |
| `EXECUTION_MODE` | — | `simulate` | `simulate` / `shadow` / `live` |
| `ANOMALY_THRESHOLD` | — | `0.7` | Min score to trigger pipeline |
| `MAX_RETRIES` | — | `3` | Max replanning attempts |
| `VECTOR_SIMILARITY_THRESHOLD` | — | `0.82` | Min cosine similarity for memory hits |
| `TRUST_THRESHOLD_SUCCESS_COUNT` | — | `3` | Successes before memory is "trustworthy" |
| `APPROVAL_TIMEOUT_MS` | — | `600000` | Human approval timeout (10 min) |
| `AUTOOPS_API_KEY` | — | — | API key for approval endpoints |
| `REDIS_HOST` | — | `localhost` | Redis host — used for a real connection attempt at startup; falls back to in-process cache if unreachable |
| `REDIS_PORT` | — | `6379` | Redis port |
| `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | — | see `.env.example` | Real Postgres connection attempted at startup; falls back to in-memory store if unreachable |
| `CHROMA_HOST` / `CHROMA_PORT` | — | `localhost` / `8000` | Real ChromaDB connection attempted at startup; falls back to in-process TF-IDF if unreachable |
| `KAFKA_BROKERS` | — | `localhost:9092` | Use `localhost:9094` (the compose file's external listener) when running the app on the host with `docker-compose up -d kafka` |
| `KUBECONFIG` | — | — | Only read when `EXECUTION_MODE` is `shadow`/`live`; if unset/unreachable, `restart_service`/`scale_deployment`/`update_resource_limits`/`verify_health` fall back to simulation |
| `SLACK_WEBHOOK_URL` | — | — | Slack webhook for notifications |

---

## Execution Modes

```
EXECUTION_MODE=simulate   ← Default. All kubectl output is realistic simulation.
EXECUTION_MODE=shadow     ← Connects to real K8s, logs what it WOULD do (dry-run).
EXECUTION_MODE=live       ← Actually executes on a real Kubernetes cluster.
```

---

## Verification Endpoints

```bash
# System health
GET  http://localhost:3000/api/health

# Live incident data
GET  http://localhost:3000/api/incidents

# Performance metrics (JSON)
GET  http://localhost:3000/api/metrics

# Prometheus metrics (for Grafana scraping)
GET  http://localhost:3000/api/prometheus

# Debug: inspect vector store, cache, and event bus contents
GET  http://localhost:3000/api/debug/stores

# Real-time WebSocket feed
WS   ws://localhost:3000/ws
```

---

## With Docker (Full Stack)

When Docker is available:

```bash
# Start all external services
docker-compose up -d
# Starts: PostgreSQL 15, Kafka 3.7 (KRaft), ChromaDB, Redis

# Then run the app
npm run dev
```

The system auto-detects real services and uses them instead of in-process fallbacks.

---

## Kubernetes — Two Different Things

**There is no `infrastructure/kubernetes/` directory in this repo** — deploying
AutoOps AI itself *into* a cluster (as pods) is not something this project provides
manifests for today.

What *does* exist is the reverse: AutoOps AI *executing against* a Kubernetes cluster
as part of remediation. Set `EXECUTION_MODE=shadow` or `EXECUTION_MODE=live` and point
`KUBECONFIG` at a real cluster (or run in-cluster with a service account) and 4 of the
10 remediation actions — `restart_service`, `scale_deployment`,
`update_resource_limits`, `verify_health` — will make real Deployment API calls via
`src/services/k8s.client.ts` instead of simulating output. `shadow` mode uses the API's
server-side `dryRun: "All"` (nothing persists); `live` mode actually mutates the
cluster. If no cluster is reachable, these four actions — and the other six, which
have no K8s-backed implementation at all — fall back to simulation regardless of
`EXECUTION_MODE`.

This was verified against a disposable local `kind` cluster (created and torn down for
testing, not a standing environment):

```bash
kind create cluster --name autoops-verify
kubectl create deployment dummy-app --image=nginx:alpine --replicas=2 -n production

EXECUTION_MODE=live npm run dev
curl -X POST http://localhost:3000/api/simulate -H "Content-Type: application/json" \
  -d '{"scenario":"cpu_spike","targetService":"dummy-app"}'
# → real API calls: scale_deployment genuinely changes replica count,
#   restart_service genuinely applies a rollout-restart annotation,
#   verify_health genuinely reads readyReplicas from the cluster

kind delete cluster --name autoops-verify
```
