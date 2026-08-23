// Mirrors the shapes emitted by the Fastify backend (src/orchestrator/state.ts,
// src/services/broadcast.ts, src/api/server.ts). Kept intentionally loose
// (optional fields) since the backend broadcasts partial state at each step.

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Outcome = "resolved" | "partial" | "failed" | "escalated";
export type AgentName =
  | "monitoring"
  | "rca"
  | "planning"
  | "sla"
  | "decision"
  | "execution"
  | "feedback";

export interface IssueState {
  issueId: string;
  type: string;
  severity: Severity;
  description: string;
  anomalyScore: number;
  affectedService: string;
  sourceEvents?: string[];
}

export interface RootCauseState {
  category: string;
  service: string;
  description: string;
  confidence: number;
  evidence?: string[];
}

export interface PlanStep {
  stepId: number;
  action: string;
  description: string;
  parameters?: Record<string, unknown>;
  timeoutSeconds?: number;
  rollbackCommand?: string;
}

export interface RemediationPlan {
  planId: string;
  title: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  estimatedDurationMinutes?: number;
  steps: PlanStep[];
}

export interface RiskAssessment {
  score: number;
  tier: "auto" | "notify" | "approve" | "block";
  reasons?: string[];
  requiresApproval?: boolean;
  source?: string;
}

export interface DecisionResult {
  action: "execute" | "execute_notify" | "escalate_human" | "block";
  reason: string;
  auditNote?: string;
}

export interface StepResult {
  stepId: number;
  action: string;
  status: "success" | "failed";
  result?: string;
  completedAt?: string;
}

export interface IncidentState {
  incidentId: string;
  createdAt: string;
  updatedAt: string;
  rawEvents?: Array<{ source?: { service?: string; namespace?: string; pod?: string } }>;
  issue?: IssueState;
  rootCause?: RootCauseState;
  plan?: RemediationPlan;
  planSource?: "template" | "memory" | "llm" | "fallback";
  priority?: string;
  riskAssessment?: RiskAssessment;
  decisionResult?: DecisionResult;
  executionStatus?: "success" | "failed" | "partial";
  stepsCompleted: StepResult[];
  stepsFailed: StepResult[];
  retryCount: number;
  workflowStatus: string;
  outcome?: Outcome;
}

export interface ExecutionStepEvent {
  incidentId: string;
  stepId: number;
  stepNum: number;
  totalSteps: number;
  action: string;
  description?: string;
  status: "running" | "success" | "failed";
  output?: string;
  durationMs?: number;
}

export interface AgentEventPayload {
  incidentId: string;
  agent: AgentName;
  timestamp?: string;
  duration?: number;
  status?: "success" | "error";
  data?: Record<string, unknown>;
}

export interface ClusterStateUpdate {
  namespace: string;
  output: string;
  ok: boolean;
  timestamp: string;
}

export interface ApprovalRequiredPayload {
  approvalId: string;
  incidentId: string;
  riskScore: number;
  riskTier: string;
  serviceName?: string;
  planTitle?: string;
  reason?: string;
}

export interface ApprovalDecidedPayload {
  approvalId: string;
  decision: "approved" | "rejected" | string;
}

export interface MetricsPayload {
  incidentsTotal: number;
  incidentsResolved: number;
  incidentsFailed: number;
  incidentsEscalated: number;
  incidentsActive: number;
  autoResolutionRate: number;
  avgMttrSeconds: number;
}

export interface LogEntry {
  id: string;
  agent: string;
  level: "info" | "warn" | "error";
  message: string;
  ts: number;
}

export interface TimelineEntry {
  id: string;
  msg: string;
  status: "running" | "done" | "warn" | "error";
  ts: number;
}

export type ScenarioId =
  | "oom_kill"
  | "high_error_rate"
  | "cpu_spike"
  | "disk_full"
  | "connection_pool_exhaustion"
  | "service_down"
  | "random";

export interface SimulatePayload {
  scenario: ScenarioId;
  eventCount: number;
  targetService?: string;
}
