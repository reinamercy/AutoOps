# 🚀 Go Log Ingester

**Status:** `ACTIVE — publishes to real Kafka`

## Overview
A high-speed, concurrent log filter written in Go. It filters out normal
`INFO`/`DEBUG` log lines and publishes only anomalies (`ERROR`, `OOM`,
`Exception`) as real `RawEvent[]` JSON messages onto the same
`autoops.raw-events` Kafka topic the TypeScript pipeline's Kafka consumer
subscribes to (see `src/services/kafka.service.ts`). This is a genuine
polyglot ingestion path, not a simulation — the two languages talk to each
other over a real Kafka broker.

## How it fits into the system
```
Go ingester (goroutines filter logs) ──▶ Kafka topic "autoops.raw-events" ──▶ TS Kafka consumer ──▶ 6-agent pipeline
```
The Go side owns nothing about incident logic — it only classifies raw log
lines into the `eventType`/`severity`/`data` shape the TypeScript Monitoring
Agent's pattern detectors already score (see `classify()` in `main.go`,
mirrored against `src/agents/monitoring.agent.ts`), then hands off to Kafka.
Everything downstream (anomaly scoring, RCA, planning, execution) is
unchanged — the pipeline can't tell whether events came from the Go
ingester, the TS log simulator, or a real cluster.

## Advantages Displayed Here
1. **Parallel Processing:** Uses Go's `goroutines` to process multiple log streams simultaneously without blocking.
2. **Noise Reduction:** Instantly filters out standard `INFO/DEBUG` logs, only forwarding critical anomalies (`ERROR`, `OOM`, `Exception`) to Kafka.
3. **Low Resource Footprint:** Capable of handling massive throughput with significantly less RAM/CPU compared to Node.js.

## Running it

Requires a reachable Kafka broker — bring up the Docker stack first
(`docker-compose up -d kafka`) or point it at any Kafka cluster.

```bash
cd go-ingester
go mod tidy   # first run only
KAFKA_BROKERS=localhost:9094 go run main.go
```

`KAFKA_BROKERS` defaults to `localhost:9094` (the compose file's external
listener — see the `docker-compose.yml` comments on `INTERNAL` vs
`EXTERNAL` listeners for why host-based tools need `9094`, not `9092`).
`KAFKA_TOPIC` defaults to `autoops.raw-events`.

If Kafka is unreachable, `WriteMessages` returns an error per batch (logged,
not fatal) — the ingester still runs its filtering demo, it just can't
deliver anything. There is currently no local fallback path on the Go side
(unlike every backend on the TypeScript side); this is a one-shot batch
ingester, not a long-running service, so add real error handling/retries
before running it unattended.

This was verified against a real, disposable Docker Kafka container:
published events were confirmed on the topic via
`kafka-console-consumer.sh`, and consumed live by the running TypeScript
app, which ran the full anomaly → RCA → plan → decide → execute → learn
pipeline and correctly matched the `OOMKilled Detection` RCA rule.
