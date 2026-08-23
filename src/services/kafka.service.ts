/**
 * AutoOps AI — Event Bus
 * Real Kafka (kafkajs) when reachable, in-process EventEmitter fallback otherwise.
 * Same connect-once-at-startup / graceful-degradation pattern as database.ts.
 */
import { EventEmitter } from "events";
import { Kafka, Producer, Consumer, logLevel } from "kafkajs";
import { config } from "../config";
import { createChildLogger } from "../utils/logger";
import { RawEvent } from "../orchestrator/state";

const log = createChildLogger("EventBus");

// ── In-process fallback bus (no Docker required) ──────────────────
const bus = new EventEmitter();
bus.setMaxListeners(20);

let busHandler: ((events: RawEvent[], incidentId?: string) => Promise<void>) | null = null;
let busActive = false;

// ── Real Kafka state ────────────────────────────────────────────
let kafka: Kafka | null = null;
let producer: Producer | null = null;
let consumer: Consumer | null = null;
let usingRealKafka = false;

/** Whether the active bus is a real Kafka connection. Used by /api/debug/stores. */
export function isRealKafka(): boolean {
    return usingRealKafka;
}

// ── Public API ─────────────────────────────────────

export async function connectProducer(): Promise<any> {
    if (usingRealKafka && producer) return producer;
    return { connected: true };
}

export async function publishEvents(
    topic: string,
    events: RawEvent[],
    incidentId?: string
): Promise<void> {
    // When the caller already pre-created an IncidentState (e.g. /api/simulate,
    // which pre-registers it so it's queryable immediately), envelope the
    // incidentId alongside the events so the consumer reuses that exact state
    // instead of minting a second one — that's what caused the double-run bug.
    // Callers that don't have one (simulation scripts, the Go ingester on the
    // wire) keep publishing/consuming a plain RawEvent[] exactly as before.
    const wirePayload: unknown = incidentId ? { incidentId, events } : events;

    if (usingRealKafka && producer) {
        await producer.send({ topic, messages: [{ value: JSON.stringify(wirePayload) }] });
        log.info({ topic, count: events.length, incidentId }, "Events published to Kafka");
        return;
    }

    if (busActive) {
        bus.emit(topic, wirePayload);
        log.info({ topic, count: events.length, incidentId }, "Events published to in-process bus");
    }
}

export async function connectConsumer(): Promise<any> {
    if (usingRealKafka && consumer) return consumer;
    return { connected: true };
}

/** Normalizes either a legacy `RawEvent[]` payload or a `{incidentId, events}` envelope. */
function normalizeMessage(parsed: unknown): { events: RawEvent[]; incidentId?: string } {
    if (Array.isArray(parsed)) return { events: parsed as RawEvent[] };
    const obj = parsed as { incidentId?: string; events: RawEvent[] };
    return { events: obj.events, incidentId: obj.incidentId };
}

export async function subscribeAndConsume(
    topic: string,
    handler: (events: RawEvent[], incidentId?: string) => Promise<void>,
    _batchSize: number = 50
): Promise<void> {
    busHandler = handler;

    const clientOpts = {
        clientId: config.kafka.clientId,
        brokers: config.kafka.brokers,
        connectionTimeout: 3000,
        requestTimeout: 5000,
        logLevel: logLevel.NOTHING, // kafkajs logs straight to stderr by default; we handle logging + fallback ourselves
    };

    try {
        // Probe with retries disabled so an unreachable broker fails fast instead of
        // retrying for ~30s. The real producer/consumer below use a fresh client with
        // kafkajs's normal retry behavior — group-join/heartbeat protocol needs it.
        const probe = new Kafka({ ...clientOpts, retry: { retries: 0 } });
        const admin = probe.admin();
        await admin.connect();
        await admin.disconnect();

        kafka = new Kafka(clientOpts);
        producer = kafka.producer();
        await producer.connect();

        consumer = kafka.consumer({ groupId: config.kafka.groupId });
        await consumer.connect();
        await consumer.subscribe({ topic, fromBeginning: false });
        await consumer.run({
            eachMessage: async ({ message }) => {
                if (!message.value) return;
                try {
                    const { events, incidentId } = normalizeMessage(JSON.parse(message.value.toString()));
                    log.info({ topic, count: events.length, incidentId }, "Kafka: processing event batch");
                    await handler(events, incidentId);
                } catch (err: any) {
                    log.error({ err: err.message }, "Error processing Kafka message");
                }
            },
        });

        usingRealKafka = true;
        log.info({ brokers: config.kafka.brokers, topic }, "✅ Kafka connected — producer + consumer active");
    } catch (err: unknown) {
        const error = err as Error;
        await producer?.disconnect().catch(() => {});
        await consumer?.disconnect().catch(() => {});
        producer = null;
        consumer = null;
        usingRealKafka = false;

        busActive = true;
        bus.on(topic, async (payload: unknown) => {
            const { events, incidentId } = normalizeMessage(payload);
            log.info({ topic, count: events.length, incidentId }, "In-process bus: processing event batch");
            try {
                await handler(events, incidentId);
            } catch (err2: any) {
                log.error({ err: err2.message }, "Error processing event batch from bus");
            }
        });

        log.warn(
            { error: error.message },
            "⚠️ Kafka unreachable — falling back to in-process event bus"
        );
    }
}

export async function disconnectKafka(): Promise<void> {
    if (usingRealKafka) {
        await producer?.disconnect().catch(() => {});
        await consumer?.disconnect().catch(() => {});
        usingRealKafka = false;
        log.info("Kafka producer/consumer disconnected");
        return;
    }

    bus.removeAllListeners();
    busActive = false;
    log.info("In-process event bus disconnected");
}

// ── Export bus so server.ts can inspect fallback-mode listeners ──
export { bus, busActive };
