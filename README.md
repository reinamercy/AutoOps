# 🤖 AutoOps AI — Autonomous Multi-Agent DevOps AI System

> **Intelligent Incident Detection & Resolution — a hand-rolled, LangGraph-*inspired* multi-agent workflow**

![System Architecture](docs/diagrams/system_architecture.png?v=2)

---

## 🚀 Overview

AutoOps AI is an autonomous DevOps system that leverages a multi-agent AI architecture to automatically monitor infrastructure, detect anomalies, identify root causes, generate remediation plans, and execute self-healing actions — with human approval gating for high-risk actions.

Each agent operates as an independent step in a stateful, hand-rolled TypeScript orchestrator (`src/orchestrator/workflow.ts`) — architecturally similar to LangGraph's StateGraph pattern, but with **no LangGraph dependency**. See [TECH_README.md](TECH_README.md) for the real architecture.

---

## 🏗️ Architecture

> See [TECH_README.md](TECH_README.md) for the exhaustive, code-accurate breakdown of
> what's real vs. simulated — this table is the marketing-level summary.

| Layer | Components | Status |
|---|---|---|
| **Data Ingestion** | Kafka (real via `kafkajs`, in-process `EventEmitter` fallback), Go log ingester | ✅ Real, with fallback |
| **Agent Processing** | Hand-rolled TypeScript StateGraph (LangGraph-*inspired*, not LangGraph itself), 6 specialized agents | ✅ Real |
| **AI/ML** | Groq LLM (`llama-3.3-70b-versatile`) for planning; rule/statistics-based anomaly detection and RCA | ✅ Real |
| **Storage** | PostgreSQL (real via `pg`), Redis (real via `ioredis`), ChromaDB (real, Sentence-Transformer embeddings) — each with an automatic in-process fallback if unreachable | ✅ Real, with fallback |
| **Execution** | Kubernetes API for 4 of 10 remediation actions (`restart_service`, `scale_deployment`, `update_resource_limits`, `verify_health`) when `EXECUTION_MODE=shadow`/`live` and a cluster is configured; simulated otherwise | ⚠️ Partial |
| **Observability** | Prometheus-format metrics endpoint, WebSocket live feed, custom dashboard | ✅ Real |
| **Security** | Command validator (regex hard-blocks), API key on approval endpoints, rate limiting | ✅ Real — no JWT/RBAC/OAuth |

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
| 1 | **Monitoring Agent** | Anomaly detection from logs, metrics, alerts | Isolation Forest, Time-series ML |
| 2 | **Root Cause Analysis Agent** | Dependency graph reasoning & failure isolation | Rule engine, Graph traversal |
| 3 | **Planning Agent** | LLM-driven remediation plan generation | GPT/LLaMA + RAG |
| 4 | **SLA Agent** | Priority scoring & SLA breach prevention | Dynamic scheduling |
| 5 | **Execution Agent** | Automated fix execution | Docker/K8s API, Shell |
| 6 | **Feedback Agent** | Continuous learning & knowledge base updates | Vector DB, ML retraining |

---

## ⚡ Key Features

- 🔄 **Autonomous Decision Making** — Zero-touch incident resolution
- 🛡️ **Self-Healing Infrastructure** — Auto-restart, auto-scale, auto-rollback
- ⏱️ **Real-Time Detection** — Sub-second anomaly identification
- 🧠 **AI-Driven Remediation** — LLM-generated step-by-step fix plans
- 📈 **Continuous Learning** — Improves accuracy with every incident
- 🔧 **Scalable Architecture** — Handles 1000+ events/sec via Kafka
- 🔐 **Enterprise Security** — JWT, RBAC, encrypted communications

---

## 🛠️ Tech Stack

```
┌─────────────────────────────────────────────────────┐
│  Framework    │  Hand-rolled state machine (Fastify) │
│  Backend      │  TypeScript / Node.js                │
│  AI/ML        │  Groq (llama-3.3-70b-versatile)      │
│  Vector DB    │  ChromaDB, real — TF-IDF fallback     │
│  Database     │  PostgreSQL 15 + Redis 7, real —      │
│                  in-memory/in-process fallback        │
│  Streaming    │  Apache Kafka (KRaft) real — in-      │
│                  process EventEmitter fallback        │
│  Ingestion    │  Go log ingester (real Kafka producer)│
│  Execution    │  Kubernetes API — 4/10 actions, real  │
│                  when EXECUTION_MODE=shadow/live      │
│  Monitoring   │  Prometheus-format endpoint, WebSocket│
│  Frontend     │  Static dashboard (public/)           │
│  Security     │  Command validator, API key, rate     │
│                  limiting — no JWT/RBAC/OAuth         │
└─────────────────────────────────────────────────────┘
```

This replaces an earlier, aspirational version of this table (LangGraph, FastAPI,
GPT-4, FAISS, JWT/RBAC/OAuth) that described a target architecture, not the
implementation. See [TECH_README.md](TECH_README.md) for the exact real-vs-fallback
split per component.

---

## 📁 Project Structure

```
autoops_ai/
├── docs/                          # Documentation & Diagrams
│   ├── SYSTEM_DESIGN.md
│   ├── ARCHITECTURE_DIAGRAMS.md
│   ├── AGENT_SPECIFICATIONS.md
│   ├── SCALABILITY_DESIGN.md
│   ├── EXECUTION_FLOW.md
│   ├── TECH_STACK.md
│   ├── PRESENTATION.md
│   ├── API_REFERENCE.md
│   ├── DEPLOYMENT.md
│   └── diagrams/
├── src/                           # Source Code
│   ├── agents/                    # Agent Implementations
│   │   ├── monitoring.agent.ts
│   │   ├── rca.agent.ts
│   │   ├── planning.agent.ts
│   │   ├── sla.agent.ts
│   │   ├── execution.agent.ts
│   │   └── feedback.agent.ts
│   ├── orchestrator/              # Workflow Orchestration
│   │   ├── state.ts
│   │   └── workflow.ts
│   ├── services/                  # Core Services
│   │   ├── groq.client.ts
│   │   ├── chroma.client.ts
│   │   ├── kafka.service.ts
│   │   └── database.ts
│   ├── api/                       # API Endpoints
│   │   ├── server.ts
│   │   └── routes.ts
│   ├── simulator/                 # Log Simulator
│   │   └── log-producer.ts
│   ├── config/
│   │   └── index.ts
│   ├── utils/
│   │   └── logger.ts
│   └── index.ts
├── go-ingester/                 # Go Log Ingester — publishes real events to Kafka
├── infrastructure/                # Infrastructure as Code
│   ├── docker/
│   └── kubernetes/
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
git clone https://github.com/adithya11sci/autoops_ai.git
cd autoops_ai

# Set up environment
cp .env.example .env
# Edit .env with your Groq API key

# Start infrastructure (Kafka, PostgreSQL, ChromaDB)
docker-compose up -d

# Install dependencies
npm install

# Run the system
npm run dev

# In another terminal, simulate log events
npm run simulate
```

---

## 📊 Performance Targets

| Metric | Target |
|---|---|
| Log ingestion rate | 1,000+ events/sec |
| Anomaly detection latency | < 500ms |
| End-to-end resolution time | < 5 minutes |
| System availability | 99.9% |
| False positive rate | < 5% |
| Auto-resolution success rate | > 85% |

---

## 📄 License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

<p align="center">
  <b>AutoOps AI</b> — Where AI meets DevOps for truly autonomous infrastructure management.
</p>
