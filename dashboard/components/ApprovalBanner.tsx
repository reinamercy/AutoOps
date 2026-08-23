"use client";

import { useState } from "react";
import { FiAlertOctagon, FiCheck, FiX } from "react-icons/fi";
import { toast } from "sonner";
import { submitApprovalDecision, ApiError } from "../lib/api";
import type { ApprovalRequiredPayload } from "../lib/types";

interface Props {
  approval: ApprovalRequiredPayload | null;
}

export default function ApprovalBanner({ approval }: Props) {
  const [submitting, setSubmitting] = useState(false);

  if (!approval) return null;

  async function decide(decision: "APPROVED" | "REJECTED") {
    setSubmitting(true);
    try {
      await submitApprovalDecision(
        approval!.approvalId,
        decision,
        decision === "APPROVED"
          ? "Approved via dashboard — operator reviewed and accepted risk"
          : "Rejected via dashboard — operator declined execution"
      );
      toast.success(`Decision submitted: ${decision}`);
    } catch (err) {
      toast.error("Failed to submit decision", {
        description: err instanceof ApiError ? err.message : "Unexpected error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative z-[60] animate-fade-in-up border-b border-danger/40 bg-[#1a0f0f]/95 px-6 py-3 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-4">
        <FiAlertOctagon className="shrink-0 text-danger" size={22} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-danger">HUMAN APPROVAL REQUIRED</div>
          <div className="truncate text-xs text-muted">
            {approval.serviceName || "—"} · risk {approval.riskScore}/100 (
            {approval.riskTier?.toUpperCase()}) · {approval.planTitle || "—"}
          </div>
        </div>
        <button
          disabled={submitting}
          onClick={() => decide("REJECTED")}
          className="flex items-center gap-1.5 rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-semibold text-danger transition-colors hover:bg-danger/20 disabled:opacity-40"
        >
          <FiX /> Reject
        </button>
        <button
          disabled={submitting}
          onClick={() => decide("APPROVED")}
          className="flex items-center gap-1.5 rounded-lg border border-emerald-400/50 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-400/20 disabled:opacity-40"
        >
          <FiCheck /> Approve
        </button>
      </div>
    </div>
  );
}
