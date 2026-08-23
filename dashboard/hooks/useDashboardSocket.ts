"use client";

import { useEffect, useReducer, useRef, useCallback } from "react";
import { toast } from "sonner";
import { WS_URL } from "../lib/api";
import type {
  AgentEventPayload,
  AgentName,
  ApprovalDecidedPayload,
  ApprovalRequiredPayload,
  ClusterStateUpdate,
  ExecutionStepEvent,
  IncidentState,
  LogEntry,
  MetricsPayload,
  TimelineEntry,
} from "../lib/types";

export const AGENT_ORDER: AgentName[] = [
  "monitoring",
  "rca",
  "planning",
  "sla",
  "decision",
  "execution",
  "feedback",
];

export type AgentStatus = "idle" | "active" | "done" | "error";

export interface AgentState {
  status: AgentStatus;
  durationMs?: number;
  data?: Record<string, unknown>;
}

const K8S_BACKED_ACTIONS = new Set([
  "restart_service",
  "scale_deployment",
  "update_resource_limits",
  "verify_health",
]);

interface DashboardState {
  connectionStatus: "connecting" | "connected" | "disconnected";
  metrics: MetricsPayload | null;
  activeIncidentId: string | null;
  activeIncident: IncidentState | null;
  pipelineRunning: boolean;
  agents: Record<AgentName, AgentState>;
  execSteps: Record<number, ExecutionStepEvent>;
  timeline: TimelineEntry[];
  logs: LogEntry[];
  clusterState: ClusterStateUpdate | null;
  clusterFlash: boolean;
  clusterBanner: ClusterBanner | null;
  pendingApproval: ApprovalRequiredPayload | null;
}

export interface ClusterBanner {
  kind: "running" | "success" | "error";
  text: string;
}

type Action =
  | { type: "ws_status"; status: DashboardState["connectionStatus"] }
  | { type: "metrics"; payload: MetricsPayload }
  | { type: "pipeline_start"; payload: { incidentId: string } }
  | { type: "agent_start"; payload: AgentEventPayload }
  | { type: "agent_complete"; payload: AgentEventPayload }
  | { type: "incident_update"; payload: IncidentState }
  | { type: "execution_step"; payload: ExecutionStepEvent }
  | { type: "pipeline_complete"; payload: { incidentId: string; outcome?: string; durationMs?: number } }
  | { type: "pipeline_error"; payload: { incidentId: string; error: string } }
  | { type: "log"; payload: { agent?: string; level?: LogEntry["level"]; message: string } }
  | { type: "cluster_state_update"; payload: ClusterStateUpdate }
  | { type: "clear_cluster_banner" }
  | { type: "approval_required"; payload: ApprovalRequiredPayload }
  | { type: "approval_decided"; payload: ApprovalDecidedPayload };

function freshAgents(): Record<AgentName, AgentState> {
  return AGENT_ORDER.reduce(
    (acc, name) => {
      acc[name] = { status: "idle" };
      return acc;
    },
    {} as Record<AgentName, AgentState>
  );
}

const initialState: DashboardState = {
  connectionStatus: "connecting",
  metrics: null,
  activeIncidentId: null,
  activeIncident: null,
  pipelineRunning: false,
  agents: freshAgents(),
  execSteps: {},
  timeline: [],
  logs: [],
  clusterState: null,
  clusterFlash: false,
  clusterBanner: null,
  pendingApproval: null,
};

let idCounter = 0;
const nextId = () => `${Date.now()}-${idCounter++}`;

function pushTimeline(timeline: TimelineEntry[], msg: string, status: TimelineEntry["status"]): TimelineEntry[] {
  const next = [...timeline, { id: nextId(), msg, status, ts: Date.now() }];
  return next.slice(-100);
}

function reducer(state: DashboardState, action: Action): DashboardState {
  switch (action.type) {
    case "ws_status":
      return { ...state, connectionStatus: action.status };

    case "metrics":
      return { ...state, metrics: action.payload };

    case "pipeline_start":
      return {
        ...state,
        activeIncidentId: action.payload.incidentId,
        activeIncident: null,
        pipelineRunning: true,
        agents: freshAgents(),
        execSteps: {},
        timeline: pushTimeline([], "Pipeline started", "running"),
      };

    case "agent_start": {
      if (action.payload.incidentId !== state.activeIncidentId) return state;
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.payload.agent]: { status: "active" },
        },
      };
    }

    case "agent_complete": {
      if (action.payload.incidentId !== state.activeIncidentId) return state;
      const status: AgentStatus = action.payload.status === "error" ? "error" : "done";
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.payload.agent]: {
            status,
            durationMs: action.payload.duration,
            data: action.payload.data,
          },
        },
      };
    }

    case "incident_update": {
      if (action.payload.incidentId !== state.activeIncidentId) return state;
      return { ...state, activeIncident: action.payload };
    }

    case "execution_step": {
      if (action.payload.incidentId !== state.activeIncidentId) return state;
      const execSteps = { ...state.execSteps, [action.payload.stepId]: action.payload };

      let timeline = state.timeline;
      if (action.payload.status === "running") {
        timeline = pushTimeline(
          timeline,
          `Execute step ${action.payload.stepNum}/${action.payload.totalSteps}: ${action.payload.action}`,
          "running"
        );
      } else if (action.payload.status === "success") {
        timeline = pushTimeline(
          timeline,
          `Step ${action.payload.stepNum}/${action.payload.totalSteps}: ${action.payload.action} succeeded`,
          "done"
        );
      } else {
        timeline = pushTimeline(
          timeline,
          `Step ${action.payload.stepNum}/${action.payload.totalSteps}: ${action.payload.action} failed`,
          "error"
        );
      }

      const flashWorthy = K8S_BACKED_ACTIONS.has(action.payload.action);
      const clusterBanner: ClusterBanner | null = flashWorthy
        ? action.payload.status === "running"
          ? { kind: "running", text: `${action.payload.action} running against the cluster…` }
          : action.payload.status === "success"
            ? { kind: "success", text: `${action.payload.action} applied — watch the terminal above` }
            : { kind: "error", text: `${action.payload.action} failed` }
        : state.clusterBanner;

      return {
        ...state,
        execSteps,
        timeline,
        clusterFlash: flashWorthy ? true : state.clusterFlash,
        clusterBanner,
      };
    }

    case "pipeline_complete":
      return {
        ...state,
        pipelineRunning: false,
        timeline: pushTimeline(
          state.timeline,
          `Pipeline complete: ${(action.payload.outcome || "unknown").toUpperCase()}`,
          action.payload.outcome === "resolved" ? "done" : "warn"
        ),
      };

    case "pipeline_error":
      return {
        ...state,
        pipelineRunning: false,
        timeline: pushTimeline(state.timeline, `Pipeline error: ${action.payload.error}`, "error"),
      };

    case "log": {
      const entry: LogEntry = {
        id: nextId(),
        agent: action.payload.agent || "system",
        level: action.payload.level || "info",
        message: action.payload.message,
        ts: Date.now(),
      };
      return { ...state, logs: [...state.logs, entry].slice(-300) };
    }

    case "cluster_state_update":
      return { ...state, clusterState: action.payload };

    case "clear_cluster_banner":
      return { ...state, clusterFlash: false, clusterBanner: null };

    case "approval_required":
      return { ...state, pendingApproval: action.payload };

    case "approval_decided":
      return { ...state, pendingApproval: null };

    default:
      return state;
  }
}

/**
 * Owns the single WebSocket connection to the Fastify backend and translates
 * every event type it broadcasts (see src/services/broadcast.ts) into React
 * state. Auto-reconnects with backoff, exactly like the previous vanilla-JS
 * dashboard did.
 */
export function useDashboardSocket() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(1000);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against React 18 Strict Mode's dev-only mount→unmount→remount
  // cycle: without this, the first socket's onclose (fired by our own
  // cleanup closing it) would race the remount's fresh connect() and race
  // to schedule a *second* reconnect on top of it — briefly leaving two
  // live sockets, so every server broadcast rendered twice. Set true only
  // when *we* intentionally close the socket (unmount/manual), so onclose
  // can tell that apart from a real dropped connection.
  const intentionalClose = useRef(false);

  const connect = useCallback(() => {
    // Idempotency guard: Next.js dev mode can invoke this more than the two
    // times Strict Mode's mount→cleanup→remount cycle accounts for (Fast
    // Refresh interacting with that cycle on a component's first compile
    // adds a 3rd call in practice). Without this, two sockets end up
    // simultaneously live and every server broadcast renders twice. If a
    // socket is already open or opening, do nothing instead of opening
    // another — this makes connect() safe to call any number of times.
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }

    intentionalClose.current = false;
    dispatch({ type: "ws_status", status: "connecting" });
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      dispatch({ type: "ws_status", status: "connected" });
      reconnectDelay.current = 1000;
    };

    ws.onclose = () => {
      if (intentionalClose.current) return;
      dispatch({ type: "ws_status", status: "disconnected" });
      reconnectTimer.current = setTimeout(connect, reconnectDelay.current);
      reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, 15000);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = (event) => {
      let msg: { type: string; payload: any };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case "connected":
          if (msg.payload?.metrics) dispatch({ type: "metrics", payload: msg.payload.metrics });
          break;
        case "pipeline_start":
          dispatch({ type: "pipeline_start", payload: msg.payload });
          break;
        case "agent_start":
          dispatch({ type: "agent_start", payload: msg.payload });
          break;
        case "agent_complete":
          dispatch({ type: "agent_complete", payload: msg.payload });
          break;
        case "incident_update":
          dispatch({ type: "incident_update", payload: msg.payload });
          break;
        case "execution_step":
          dispatch({ type: "execution_step", payload: msg.payload });
          break;
        case "cluster_state_update":
          dispatch({ type: "cluster_state_update", payload: msg.payload });
          break;
        case "pipeline_complete":
          dispatch({ type: "pipeline_complete", payload: msg.payload });
          break;
        case "pipeline_error":
          dispatch({ type: "pipeline_error", payload: msg.payload });
          toast.error(`Pipeline error: ${msg.payload?.error || "unknown error"}`);
          break;
        case "log":
          dispatch({ type: "log", payload: msg.payload });
          break;
        case "metrics_update":
          dispatch({ type: "metrics", payload: msg.payload });
          break;
        case "approval_required":
          dispatch({ type: "approval_required", payload: msg.payload });
          toast.warning("Human approval required — high-risk operation blocked", {
            description: msg.payload?.serviceName,
          });
          break;
        case "approval_decided":
          dispatch({ type: "approval_decided", payload: msg.payload });
          break;
        default:
          break;
      }
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      intentionalClose.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // Auto-clear the transient cluster action banner/flash a few seconds after
  // the last K8s-backed execution step, so it doesn't linger forever.
  useEffect(() => {
    if (!state.clusterFlash) return;
    const t = setTimeout(() => dispatch({ type: "clear_cluster_banner" }), 4500);
    return () => clearTimeout(t);
  }, [state.clusterFlash, state.clusterBanner]);

  return state;
}
