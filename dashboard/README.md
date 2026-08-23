# AutoOps AI Dashboard (Next.js)

A premium React/Next.js replacement for the previous vanilla-JS dashboard
(`../public/index.html`, still present and untouched — the Fastify backend
keeps serving it at `/` unless you point people at this app instead).

## Why a separate app, not a page inside the Fastify server

The backend (`../src`) is a Fastify API + WebSocket server with no Next.js/React
anywhere in it. Rather than bolt a build step onto that project, this is a
standalone Next.js app that talks to the backend purely over HTTP (`fetch`) and
WebSocket (`ws://.../ws`) — the same two integration points the old dashboard
used. Nothing on the backend had to change to support this (CORS was already
permissive: `origin: true`).

## Running it

```bash
# Terminal 1 — backend (from autoops_ai/)
EXECUTION_MODE=live npm run dev

# Terminal 2 — this dashboard (from autoops_ai/dashboard/)
npm install
npm run dev
```

Opens on **http://localhost:3001** by default (port 3000 stays free for the
backend + its own static dashboard). Copy `.env.local.example` to `.env.local`
if the backend runs somewhere other than `localhost:3000`.

## What it talks to

- `GET /api/health`, `/api/metrics`, `/api/incidents`, `/api/debug/stores`
- `POST /api/simulate` — scenario triggers
- `POST /api/v1/approvals/:id/decision` — human approval gate
- `ws://<backend>/ws` — every real-time event: `pipeline_start`, `agent_start`,
  `agent_complete`, `incident_update`, `execution_step`, `cluster_state_update`,
  `pipeline_complete`, `pipeline_error`, `log`, `metrics_update`,
  `approval_required`, `approval_decided`

## Stack

Next.js 14 (App Router) · React 18 · TypeScript · Tailwind CSS ·
`react-icons` · `sonner` (toast notifications)
