// AutoOps AI — Go Log Ingester
//
// A high-speed, concurrent log filter that publishes real Kafka messages
// shaped as RawEvent[] (see src/orchestrator/state.ts) onto the same
// autoops.raw-events topic the TypeScript pipeline consumes from. This lets
// the Go and TypeScript sides of the system talk to each other over a real
// broker instead of only existing side by side.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	kafka "github.com/segmentio/kafka-go"
)

// RawEvent mirrors the TypeScript RawEvent interface in src/orchestrator/state.ts.
// Field names/JSON tags must match exactly — the TS consumer does a plain
// JSON.parse(...) as RawEvent[] with no schema validation.
type RawEvent struct {
	EventID   string                 `json:"eventId"`
	Timestamp string                 `json:"timestamp"`
	Source    EventSource            `json:"source"`
	EventType string                 `json:"eventType"`
	Severity  string                 `json:"severity"`
	Data      map[string]interface{} `json:"data"`
}

type EventSource struct {
	Type      string `json:"type"`
	Service   string `json:"service"`
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
}

func randomID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// classify maps a raw log line to the eventType/severity/data shape the
// TypeScript Monitoring Agent's pattern detectors already know how to score
// (see src/agents/monitoring.agent.ts patternScore()).
func classify(logLine string) (eventType, severity string, data map[string]interface{}) {
	switch {
	case strings.Contains(logLine, "OOM"):
		return "pod_crash", "critical", map[string]interface{}{"reason": "OOMKilled", "raw": logLine}
	case strings.Contains(logLine, "Exception"), strings.Contains(logLine, "ERROR"):
		return "error_spike", "high", map[string]interface{}{"errorRate": 0.15, "raw": logLine}
	default:
		return "info_log", "info", map[string]interface{}{"raw": logLine}
	}
}

// processLogStream simulates an ultra-fast consumer processing raw logs.
// It filters out normal logs and only forwards potential anomalies.
func processLogStream(streamID string, logChannel <-chan string, alertChannel chan<- RawEvent, wg *sync.WaitGroup) {
	defer wg.Done()
	for logLine := range logChannel {
		// High-speed filtering
		if strings.Contains(logLine, "ERROR") || strings.Contains(logLine, "OOM") || strings.Contains(logLine, "Exception") {
			eventType, severity, data := classify(logLine)
			alertChannel <- RawEvent{
				EventID:   fmt.Sprintf("go-evt-%s", randomID()),
				Timestamp: time.Now().UTC().Format(time.RFC3339),
				Source: EventSource{
					Type:      "go-ingester",
					Service:   "go-ingester-svc",
					Namespace: "production",
					Pod:       fmt.Sprintf("go-ingester-%s", streamID),
				},
				EventType: eventType,
				Severity:  severity,
				Data:      data,
			}
		}
	}
}

func main() {
	log.Println("⚡ Starting High-Speed Go Log Ingester")

	brokers := strings.Split(getEnv("KAFKA_BROKERS", "localhost:9094"), ",")
	topic := getEnv("KAFKA_TOPIC", "autoops.raw-events")

	writer := &kafka.Writer{
		Addr:                   kafka.TCP(brokers...),
		Topic:                  topic,
		Balancer:               &kafka.LeastBytes{},
		AllowAutoTopicCreation: true,
	}
	defer writer.Close()

	// Buffered channels for high throughput
	logChannel := make(chan string, 10000)
	alertChannel := make(chan RawEvent, 1000)

	// 1. Spin up 5 concurrent workers instantly
	var workers sync.WaitGroup
	workers.Add(5)
	for i := 1; i <= 5; i++ {
		go processLogStream(fmt.Sprintf("worker-%d", i), logChannel, alertChannel, &workers)
	}

	// 2. Background task to batch + publish filtered alerts to Kafka
	done := make(chan struct{})
	go func() {
		defer close(done)
		batch := make([]RawEvent, 0, 16)
		flush := func() {
			if len(batch) == 0 {
				return
			}
			payload, err := json.Marshal(batch)
			if err != nil {
				log.Printf("[kafka] marshal error: %v", err)
				batch = batch[:0]
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err = writer.WriteMessages(ctx, kafka.Message{Value: payload})
			cancel()
			if err != nil {
				log.Printf("[kafka] publish failed (%d events dropped): %v", len(batch), err)
			} else {
				log.Printf("✅ Published %d event(s) to Kafka topic %q", len(batch), topic)
			}
			batch = batch[:0]
		}

		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case alert, ok := <-alertChannel:
				if !ok {
					flush()
					return
				}
				batch = append(batch, alert)
				if len(batch) >= 10 {
					flush()
				}
			case <-ticker.C:
				flush()
			}
		}
	}()

	// 3. Simulate high volumes of incoming logs, then wait for every worker to
	// finish draining logChannel before closing alertChannel (avoids a send-on-
	// closed-channel panic if a worker is still mid-send when we close it).
	simulateIncomingLogs(logChannel)
	workers.Wait()
	close(alertChannel)
	<-done

	log.Println("✅ Go log ingestion complete — all anomalies published to Kafka.")
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func simulateIncomingLogs(logChannel chan<- string) {
	log.Println("Simulating log stream...")

	sampleLogs := []string{
		"INFO: Service started normally",
		"DEBUG: Heartbeat check ok",
		"ERROR: Connection refused on port 5432 (Postgres)",
		"INFO: User login successful",
		"OOM: Container memory limit exceeded in pod-123",
	}

	for _, l := range sampleLogs {
		logChannel <- l
		time.Sleep(50 * time.Millisecond) // Simulating slight delay between batches
	}

	// Wait briefly so goroutines can finish processing and the publisher can flush
	time.Sleep(1 * time.Second)
	close(logChannel)
}
