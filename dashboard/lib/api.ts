import type { SimulatePayload } from "./types";

// The dashboard is a standalone Next.js app (see the README in this folder for
// why) that talks to the existing Fastify backend over plain HTTP + WebSocket.
// Both default to the backend's default port/host; override via .env.local
// if you run the backend elsewhere.
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3000/ws";

class ApiError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch (err) {
    throw new ApiError(
      `Could not reach AutoOps AI backend at ${API_BASE} — is it running?`
    );
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error || `Request failed (${res.status})`, res.status);
  }

  return res.json() as Promise<T>;
}

export interface SimulateResponse {
  incidentId: string;
  status: string;
  scenario: string;
  eventCount: number;
  message: string;
}

export function triggerSimulation(payload: SimulatePayload) {
  return request<SimulateResponse>("/api/simulate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchMetrics() {
  return request<Record<string, unknown>>("/api/metrics");
}

export function fetchIncidents(limit = 20) {
  return request<{ incidents: unknown[]; total: number }>(`/api/incidents?limit=${limit}`);
}

export function fetchDebugStores() {
  return request<Record<string, any>>("/api/debug/stores");
}

export function fetchHealth() {
  return request<Record<string, any>>("/api/health");
}

export async function submitApprovalDecision(
  approvalId: string,
  decision: "APPROVED" | "REJECTED",
  comment: string
) {
  // Goes to this Next.js app's OWN server-side route (/app/api/approvals/[id]),
  // not straight to the backend — that route attaches the AUTOOPS_API_KEY
  // secret server-side. It must never be sent from browser code (a
  // NEXT_PUBLIC_* var would ship it in the client bundle, in cleartext,
  // to anyone who opens devtools).
  let res: Response;
  try {
    res = await fetch(`/api/approvals/${approvalId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, approverId: "dashboard-operator", comment }),
    });
  } catch {
    throw new ApiError("Could not reach the dashboard's approval proxy route");
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(body.error || `Request failed (${res.status})`, res.status);
  }
  return body;
}

export { ApiError };
