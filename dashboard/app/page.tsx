"use client";

import { useEffect, useState } from "react";
import { FiActivity, FiPlayCircle, FiSearch } from "react-icons/fi";
import Header from "../components/Header";
import MetricsRow from "../components/MetricsRow";
import AgentPipeline from "../components/AgentPipeline";
import ActiveIncidentPanel from "../components/ActiveIncidentPanel";
import LiveClusterTerminal from "../components/LiveClusterTerminal";
import LogStream from "../components/LogStream";
import ScenarioTriggers from "../components/ScenarioTriggers";
import IncidentHistoryTable from "../components/IncidentHistoryTable";
import LiteratureReviewTable from "../components/LiteratureReviewTable";
import ApprovalBanner from "../components/ApprovalBanner";
import Tabs, { type TabDef } from "../components/Tabs";
import { useDashboardSocket } from "../hooks/useDashboardSocket";
import { fetchDebugStores, fetchHealth } from "../lib/api";

const TABS: TabDef[] = [
  { id: "pipeline", label: "Live Pipeline", icon: FiActivity },
  { id: "incident", label: "Incident Analysis", icon: FiSearch },
  { id: "simulation", label: "Simulation & History", icon: FiPlayCircle },
];

export default function Home() {
  // Single WebSocket connection lives here, above the tabs — switching tabs
  // only changes which panels are rendered, it never touches this hook, so
  // no state (agent progress, logs, cluster terminal, active incident) is
  // lost by moving between tabs mid-pipeline.
  const state = useDashboardSocket();
  const [executionMode, setExecutionMode] = useState<string | null>(null);
  const [pollIntervalMs, setPollIntervalMs] = useState(2000);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState("pipeline");

  useEffect(() => {
    fetchHealth()
      .then((d) => setExecutionMode(d?.services?.executionMode ?? null))
      .catch(() => {});
    fetchDebugStores()
      .then((d) => {
        if (d?.clusterWatch?.pollIntervalMs) setPollIntervalMs(d.clusterWatch.pollIntervalMs);
      })
      .catch(() => {});
  }, []);

  // Refresh the incident history table whenever a pipeline finishes.
  useEffect(() => {
    if (!state.pipelineRunning && state.activeIncident?.outcome) {
      setHistoryRefreshKey((k) => k + 1);
    }
  }, [state.pipelineRunning, state.activeIncident?.outcome]);

  const pipelineStatusLabel = state.pipelineRunning
    ? `Running — ${state.activeIncidentId}`
    : state.activeIncidentId
      ? `Last: ${state.activeIncidentId}`
      : "Idle — trigger a scenario below";

  const tabsWithBadges = TABS.map((t) =>
    t.id === "incident" ? { ...t, badge: state.pipelineRunning ? 1 : 0 } : t
  );

  return (
    <>
      {/* Banner + header stick together as one unit so an approval alert
          pushes the header down instead of covering it. */}
      <div className="sticky top-0 z-50">
        <ApprovalBanner approval={state.pendingApproval} />
        <Header connectionStatus={state.connectionStatus} executionMode={executionMode} />
      </div>

      <main className="mx-auto max-w-[1600px] px-6 py-6">
        <Tabs tabs={tabsWithBadges} activeTab={activeTab} onChange={setActiveTab} />

        {activeTab === "pipeline" && (
          <div className="animate-fade-in-up">
            <MetricsRow metrics={state.metrics} activeCount={state.pipelineRunning ? 1 : 0} />
            <AgentPipeline agents={state.agents} statusLabel={pipelineStatusLabel} />
            <LiveClusterTerminal
              clusterState={state.clusterState}
              flash={state.clusterFlash}
              banner={state.clusterBanner}
              pollIntervalMs={pollIntervalMs}
            />
          </div>
        )}

        {activeTab === "incident" && (
          <div className="grid animate-fade-in-up grid-cols-1 gap-5 lg:grid-cols-[55fr_45fr]">
            <ActiveIncidentPanel
              incidentId={state.activeIncidentId}
              incident={state.activeIncident}
              execSteps={state.execSteps}
              agents={state.agents}
            />
            <LogStream logs={state.logs} />
          </div>
        )}

        {activeTab === "simulation" && (
          <div className="animate-fade-in-up">
            <ScenarioTriggers
              pipelineRunning={state.pipelineRunning}
              onTriggered={() => {
                /* activeIncidentId is set by the pipeline_start WS event, not here —
                   this callback exists for any future non-WS-driven UI reaction. */
              }}
            />
            <IncidentHistoryTable refreshKey={historyRefreshKey} />
            <div className="mt-5">
              <LiteratureReviewTable />
            </div>
          </div>
        )}
      </main>
    </>
  );
}
