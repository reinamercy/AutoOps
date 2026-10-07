# 🤖 AutoOps AI — Multi-Agent, Risk-Gated Incident Remediation

> **Incident detection, diagnosis, remediation planning and risk-gated execution — a hand-rolled, LangGraph-*inspired* multi-agent workflow**

![System Architecture](docs/diagrams/system_architecture.png?v=2)

---

## 🚀 Overview

AutoOps AI is a closed-loop incident-response pipeline. It detects anomalies in infrastructure events, identifies a likely root cause, generates a remediation plan, scores the plan's risk, and then either executes it, executes and notifies, or suspends it for human approval. Commands matching hard-blocked patterns are always refused. Execution is real for 4 of 10 remediation actions when a Kubernetes cluster is configured; the other 6 are always simulated.

Each agent is one step in a stateful, hand-rolled TypeScript orchestrator (`src/orchestrator/workflow.ts`). It is architecturally similar to LangGraph's StateGraph pattern but has **no LangGraph dependency**. See [TECH_README.md](TECH_README.md) for the code-accurate architecture, and [Paper Reproducibility](#-paper-reproducibility) for what has and has not been evaluated.

---

## 🏗️ Architecture

> See [TECH_README.md](TECH_README.md) for the exhaustive breakdown of what is real and what is simulated.

| Layer | Components | Status |
|---|---|---|
| **Data Ingestion** | Kafka (real via `kafkajs`, in-process `EventEmitter` fallback), Go log ingester | ✅ Real, with fallback |
| **Agent Processing** | Hand-rolled TypeScript StateGraph (LangGraph-*inspired*, not LangGraph itself), 6 specialized agents | ✅ Real |
| **AI/ML** | Groq LLM (`openai/gpt-oss-120b`) for planning; rule/statistics-based anomaly detection and RCA | ✅ Real |
| **Storage** | PostgreSQL (real via `pg`), Redis (real via `ioredis`), ChromaDB (real, Sentence-Transformer embeddings) — each with an automatic in-process fallback if unreachable | ✅ Real, with fallback |
| **Retrieval** | Similar past incidents retrieved from the vector store and added to the LLM prompt | ⚠️ Implemented, not experimentally validated (ablation not run) |
| **Execution** | Kubernetes API for 4 of 10 remediation actions (`restart_service`, `scale_deployment`, `update_resource_limits`, `verify_health`) when `EXECUTION_MODE=shadow`/`live` and a cluster is configured; simulated otherwise. The other 6 actions are always simulated | ⚠️ Partial |
| **Observability** | Prometheus-format metrics endpoint, WebSocket live feed, dashboard | ✅ Real |
| **Security** | Command validator (regex hard-blocks), optional API key on approval endpoints (`AUTOOPS_API_KEY`), rate limiting on `/api/simulate` and approval endpoints | ✅ Real — no JWT/RBAC/OAuth/TLS; `/api/debug/*` endpoints are unauthenticated |

---

## 📋 Table of Contents

- [System Design Document](docs/SYSTEM_DESIGN.md)
- [Architecture Diagrams](docs/ARCHITECTURE_DIAGRAMS.md)
- [Agent Specifications](docs/AGENT_SPECIFICATIONS.md)
- [Scalability Design](docs/SCALABILITY_DESIGN.md)
- [Execution Flow](docs/EXECUTION_FLOW.md)
- [Tech Stack Deep Dive](docs/TECH_STACK.md)
- [Presentation Content](docs/PRESENTATION.md)
- [API Reference](docs/API_REFERENCE.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [Simulation Working Docs](simulation_working.md)

---

## 🧠 Core Agents

| # | Agent | Role | Key Technology |
|---|---|---|---|
| 1 | **Monitoring Agent** | Anomaly detection from events | Weighted ensemble: Z-score-style statistics, known failure-signature patterns, rules |
| 2 | **Root Cause Analysis Agent** | Root-cause matching & impact tracing | Rule matching, hardcoded service-dependency graph |
| 3 | **Planning Agent** | Remediation plan generation | Template → memory (cache / vector similarity) → Groq LLM with retrieved context → hardcoded fallback |
| 4 | **SLA Agent** | Priority scoring | Weighted score → P0–P4, SLA deadline by tier |
| 5 | **Execution Agent** | Runs plan steps | Kubernetes client for 4 of 10 actions when configured; simulated output otherwise |
| 6 | **Feedback Agent** | Records outcomes | Persists to Postgres + vector store; exponential score update for reused fixes (no model retraining) |

Between the SLA and Execution agents, the **Decision Engine** validates commands, computes a heuristic (uncalibrated) risk score, and routes to `auto` / `notify` / `approve` / `block`. `approve` and `block` both wait for a human decision; hard-blocked command patterns are refused regardless of approval.

---

## ⚡ Key Features

- 🔄 **Risk-gated decision routing**: low-risk plans execute automatically; higher-risk plans notify or wait for human approval. This is a heuristic score, not a calibrated risk estimate.
- 🛡️ **Remediation actions**: restart, scale, resource-limit patch and health check run against Kubernetes when configured. Rollback, disk cleanup, connection-pool flush, config apply, pipeline trigger and rolling restart are simulated.
- ⏱️ **Event-driven detection**: rule- and statistics-based anomaly detection on ingested events. Latency has not been benchmarked.
- 🧠 **LLM-generated remediation plans**: step-by-step plans from `openai/gpt-oss-120b`, used only when no template or stored fix matches.
- 📈 **Fix memory**: successful fixes are stored and reused, and their scores are updated from outcomes. Reuse does not check correctness; the paper shows incorrect fixes being cached and replicated.
- 🔧 **Streaming ingestion**: real Kafka (KRaft) consumer and a Go producer. Throughput has not been benchmarked.
- 🔐 **Command safety**: regex hard-blocks (for example namespace deletion, unscoped destructive SQL, pipe-to-shell), an optional API key on approval endpoints, and rate limiting.

---

## 🛠️ Tech Stack

```
┌─────────────────────────────────────────────────────┐
│  Framework    │  Hand-rolled state machine (Fastify) │
│  Backend      │  TypeScript / Node.js                │
│  AI/ML        │  Groq (openai/gpt-oss-120b)          │
│  Vector DB    │  ChromaDB, real — TF-IDF fallback     │
│  Database     │  PostgreSQL 15 + Redis 7, real —      │
│                  in-memory/in-process fallback        │
│  Streaming    │  Apache Kafka (KRaft) real — in-      │
│                  process EventEmitter fallback        │
│  Ingestion    │  Go log ingester (real Kafka producer)│
│  Execution    │  Kubernetes API — 4/10 actions, real  │
│                  when EXECUTION_MODE=shadow/live      │
│  Monitoring   │  Prometheus-format endpoint, WebSocket│
│  Frontend     │  Static dashboard (public/), Next.js  │
│                  dashboard (dashboard/)               │
│  Security     │  Command validator, optional API key, │
│                  rate limiting — no JWT/RBAC/OAuth    │
└─────────────────────────────────────────────────────┘
```

This replaces an earlier, aspirational version of this table (LangGraph, FastAPI,
GPT-4, FAISS, JWT/RBAC/OAuth) that described a target architecture, not the
implementation. See [TECH_README.md](TECH_README.md) for the exact real-vs-fallback
split per component.

---

## 📁 Project Structure

```
AutoOps/
├── docs/                          # Documentation & diagrams
├── src/
│   ├── agents/                    # monitoring, rca, planning, sla, execution, feedback
│   ├── orchestrator/              # state.ts, workflow.ts
│   ├── engines/                   # decision.engine.ts (risk routing)
│   ├── services/                  # groq, chroma, kafka, redis, k8s, database, risk,
│   │                              # memory, template, command-validator, approvals
│   ├── evaluation/                # rubric (plan-scoring.ts), work order, result loader
│   ├── api/                       # server.ts, approvals.router.ts
│   ├── db/migrations/             # Postgres schema
│   ├── simulator/                 # log-producer.ts (synthetic events)
│   ├── config/  utils/
│   └── index.ts
├── scripts/                       # evaluation harness, analysis scripts, result files
├── simulation/                    # Docker-based demo scenarios
├── go-ingester/                   # Go log ingester — publishes real events to Kafka
├── dashboard/                     # Next.js dashboard
├── public/                        # Static dashboard
├── paper/                         # Manuscript source, PDF and figures
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## 🚀 Quick Start

```bash
# Clone the repository
git clone https://github.com/reinamercy/AutoOps.git
cd AutoOps

# Set up environment
cp .env.example .env
# Edit .env with your Groq API key

# Start infrastructure (Kafka, PostgreSQL, ChromaDB, Redis)
docker-compose up -d

# Install dependencies
npm install

# Run the system
npm run dev

# In another terminal, simulate log events
npm run simulate
```

---

## 📊 Design Targets (not measured)

These are engineering goals, not results. None has been benchmarked; the only measured results are those in the paper (see [Paper Reproducibility](#-paper-reproducibility)).

| Metric | Target | Status |
|---|---|---|
| Log ingestion rate | 1,000+ events/sec | Not benchmarked |
| Anomaly detection latency | < 500ms | Not benchmarked |
| End-to-end resolution time | < 5 minutes | Not benchmarked. Measured planning latency is in the paper; it excludes human approval time |
| System availability | 99.9% | Not measured (no production deployment) |
| False positive rate | < 5% | Not measured |
| Auto-resolution success rate | > 85% | Not measurable yet: 6 of 10 actions are simulated and simulated success is independent of plan content |

---

## 📑 Paper Reproducibility

The manuscript source is in [paper/](paper/) (`paper.tex`, compiled `paper.pdf`). Every number it reports comes from the **final** result files below, all produced with `openai/gpt-oss-120b` on Groq. No API call is needed to reproduce the tables and statistics from them:

```bash
bash scripts/finalize-analysis.sh 2>&1 | tee final-analysis.txt
```

This one command checks completeness, regenerates the random control, and recomputes rates, Wilson intervals, McNemar tests, the Monte Carlo null, latency medians/IQR/bootstrap CI, the risk-score decomposition and per-class paired McNemar. It also rewrites `paper/figures/risk_ablation_data.tex`, the data behind Fig. 2.

| Paper element | Result file(s) in `scripts/` | Analysis script |
|---|---|---|
| Experiment 1 (held-out classes), Table II | `eval-heldout-full-gptoss120b.json`, `eval-heldout-baseline-gptoss120b.json` | `analyze-results.ts`, `montecarlo-null.ts` |
| Random control | `eval-heldout-random-gptoss120b.json` | `random-planner-arm.ts` (seed 42) |
| Risk-gate routing, term ablation, Fig. 2 | held-out files above | `risk-decomposition.ts` |
| Experiment 2 (covered classes), Table III | `eval-covered-full-gptoss120b.json`, `eval-covered-baseline-gptoss120b.json` | `analyze-results.ts`, `paired-class-mcnemar.ts` |

- **Rubric:** [src/evaluation/plan-scoring.ts](src/evaluation/plan-scoring.ts), version `strict-1`.
- **Frozen work order:** [src/evaluation/work-order.ts](src/evaluation/work-order.ts). Final runs used `WORK_ORDER_SEED=1337` with `PAIRED=true` and `INTERLEAVE=true`. Held-out runs also used `COLD_START=true`.
- **Harness:** [scripts/eval-harness.ts](scripts/eval-harness.ts). The usage is in its header. The server ran with `EXECUTION_MODE=simulate` and real Postgres, Redis, ChromaDB and Kafka (`docker-compose up -d`). Set `GROQ_MODEL_PLANNING=openai/gpt-oss-120b` in `.env`; the code default is the retired Llama model.

**Superseded runs.** Ten older result files (`eval-results-*.json`, `eval-heldout-{full,baseline}.json`, `eval-covered-{full,baseline}.json`, `eval-paired-heldout-*.json`, `eval-random-matched.json`, `eval-ablation-rag-on.json`) come from the retired `llama-3.3-70b-versatile` model or earlier harness versions. Each is marked `meta.superseded`, and [src/evaluation/load-results.ts](src/evaluation/load-results.ts) refuses to load it into an analysis. They are kept only as a record.

**Not run.** The retrieval (RAG) ablation has **not** been run on the final model. `eval-ablation-rag-on.json` is a superseded Llama-era pilot in which retrieval engaged on only the first 5 of 40 incidents, for reasons not yet diagnosed. No retrieval result is claimed in the paper. Also not done: SRE/expert rating of the rubric, a fault-injection executor, and any production data.

**Known metadata caveat.** `meta.autoApprovedByHarness` counts approvals in the harness process that wrote the file last. The final runs were paused and resumed across several days, so that value covers only the last segment. The per-incident records are authoritative: all 93 gated held-out incidents (`approve`/`block`) have `outcome: "resolved"`, which requires an approval.

---

## 📄 License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

<p align="center">
  <b>AutoOps AI</b> — Multi-agent, risk-gated infrastructure remediation.
</p>
