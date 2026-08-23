/**
 * AutoOps AI — Main Entry Point
 * Starts the API server, initializes all services, and wires the Kafka consumer.
 */
import { config } from "./config";
import { createChildLogger } from "./utils/logger";
import { startServer } from "./api/server";
import { initDatabase } from "./services/database";
import { initRedis } from "./services/redis.client";
import { initChroma } from "./services/chroma.client";
import { initK8s } from "./services/k8s.client";
import { startClusterWatch, stopClusterWatch } from "./services/k8s-watch.service";
import { subscribeAndConsume, disconnectKafka } from "./services/kafka.service";
import { runPipeline, getIncidentState } from "./orchestrator/workflow";
import { broadcastLog } from "./services/broadcast";

const log = createChildLogger("Main");

async function main() {
    log.info("═══════════════════════════════════════════════════");
    log.info("  🤖 AutoOps AI — Autonomous Multi-Agent DevOps   ");
    log.info("     Intelligent Incident Detection & Resolution   ");
    log.info("═══════════════════════════════════════════════════");

    // 1. Initialize PostgreSQL
    try {
        await initDatabase();
        log.info("✅ PostgreSQL database initialized");
    } catch (err: any) {
        log.warn({ err: err.message }, "⚠️ PostgreSQL not available (will retry on use)");
    }

    // 2. Initialize Redis
    try {
        await initRedis();
        log.info("✅ Redis initialized");
    } catch (err: any) {
        log.warn({ err: err.message }, "⚠️ Redis not available (will retry on use)");
    }

    // 2b. Initialize ChromaDB
    try {
        await initChroma();
        log.info("✅ ChromaDB initialized");
    } catch (err: any) {
        log.warn({ err: err.message }, "⚠️ ChromaDB not available (will retry on use)");
    }

    // 2c. Probe for a Kubernetes cluster (only matters if EXECUTION_MODE is shadow/live)
    if (config.agents.executionMode !== "simulate") {
        try {
            await initK8s();
        } catch (err: any) {
            log.warn({ err: err.message }, "⚠️ Kubernetes probe failed (execution will fall back to simulation)");
        }
        // Stream `kubectl get pods` into the dashboard's Live Cluster Terminal.
        // isK8sAvailable() is re-checked every poll, so this is safe to start
        // even if the probe above just failed — it'll just report "unavailable".
        startClusterWatch();
    }

    // 3. Start API + WebSocket server
    const app = await startServer();

    // 4. Wire event bus consumer (real Kafka when reachable, in-process bus otherwise —
    //    either way the system also works via HTTP API: POST /api/simulate)
    try {
        await subscribeAndConsume(
            config.kafka.topics.rawEvents,
            async (events, incidentId) => {
                broadcastLog("kafka", "info", `Received ${events.length} events from event bus`, { count: events.length, incidentId });
                // If this batch carries an incidentId (from /api/simulate, which
                // pre-registers the state before publishing), reuse that exact
                // state instead of minting a second one — the consumer is now
                // the ONLY place the pipeline runs for bus-published events.
                // Batches with no incidentId (Go ingester, simulation scripts)
                // still get a fresh state, same as before.
                const existingState = incidentId ? getIncidentState(incidentId) : undefined;
                await runPipeline(events, existingState);
            },
            30  // batch size
        );
        log.info({ topic: config.kafka.topics.rawEvents }, "✅ Event bus consumer active");
    } catch (err: any) {
        log.warn({ err: err.message }, "⚠️ Event bus consumer failed to start — HTTP API mode only (use POST /api/simulate)");
    }

    log.info("");
    log.info("🔗 Endpoints:");
    log.info(`   GET  http://localhost:${config.server.port}/                   ← Dashboard UI`);
    log.info(`   GET  http://localhost:${config.server.port}/api/health`);
    log.info(`   POST http://localhost:${config.server.port}/api/simulate       ← Trigger incident`);
    log.info(`   GET  http://localhost:${config.server.port}/api/incidents`);
    log.info(`   GET  http://localhost:${config.server.port}/api/metrics`);
    log.info(`   GET  http://localhost:${config.server.port}/api/prometheus     ← Prometheus metrics`);
    log.info(`   WS   ws://localhost:${config.server.port}/ws                  ← Real-time feed`);
    log.info("");
    log.info("📝 Quick test:");
    log.info(`   curl -X POST http://localhost:${config.server.port}/api/simulate \\`);
    log.info(`     -H "Content-Type: application/json" \\`);
    log.info(`     -d '{"scenario":"oom_kill","eventCount":30}'`);
    log.info("═══════════════════════════════════════════════════");

    // Graceful shutdown
    const shutdown = async () => {
        log.info("Shutting down gracefully...");
        stopClusterWatch();
        try { await disconnectKafka(); } catch { }
        await app.close();
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
