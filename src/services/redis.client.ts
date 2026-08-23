/**
 * AutoOps AI — Redis Client
 * Real Redis (ioredis) when reachable, in-process TTL Map fallback otherwise.
 * Same connect-once-at-startup / graceful-degradation pattern as database.ts.
 */
import IORedis from "ioredis";
import { config } from "../config";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger("RedisClient");

export interface CacheClient {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, exMode?: string, ttlSec?: number): Promise<void>;
    snapshot(): Promise<Array<{ key: string; ttlSeconds: number; preview: string }>>;
}

const CACHE_TTL_SEC = 30 * 60; // 30 minutes — default when no ttl given

// ── In-process fallback (no Docker required) ──────────────────────

class InProcessCache implements CacheClient {
    private store = new Map<string, { value: string; expiresAt: number }>();

    async get(key: string): Promise<string | null> {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }

    async set(key: string, value: string, _exMode?: string, ttlSec?: number): Promise<void> {
        const expiresAt = Date.now() + (ttlSec ?? CACHE_TTL_SEC) * 1000;
        this.store.set(key, { value, expiresAt });
    }

    async snapshot(): Promise<Array<{ key: string; ttlSeconds: number; preview: string }>> {
        const now = Date.now();
        return Array.from(this.store.entries())
            .filter(([, e]) => now <= e.expiresAt)
            .map(([key, e]) => ({
                key,
                ttlSeconds: Math.round((e.expiresAt - now) / 1000),
                preview: e.value.slice(0, 120) + (e.value.length > 120 ? "…" : ""),
            }));
    }
}

// ── Real Redis wrapper ─────────────────────────────────────────────

class RealRedisCache implements CacheClient {
    constructor(private client: IORedis) {}

    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    async set(key: string, value: string, _exMode?: string, ttlSec?: number): Promise<void> {
        await this.client.set(key, value, "EX", ttlSec ?? CACHE_TTL_SEC);
    }

    async snapshot(): Promise<Array<{ key: string; ttlSeconds: number; preview: string }>> {
        const keys = await this.client.keys("fix:*");
        const entries = await Promise.all(
            keys.map(async (key) => {
                const [value, ttl] = await Promise.all([this.client.get(key), this.client.ttl(key)]);
                return {
                    key,
                    ttlSeconds: ttl,
                    preview: (value || "").slice(0, 120) + ((value?.length || 0) > 120 ? "…" : ""),
                };
            })
        );
        return entries;
    }
}

// ── Active client (real Redis when reachable, in-process fallback otherwise) ──

let activeCache: CacheClient = new InProcessCache();
let usingRealRedis = false;

export function getCache(): CacheClient {
    return activeCache;
}

/** Whether the active cache is a real Redis connection. Used by /api/debug/stores. */
export function isRealRedis(): boolean {
    return usingRealRedis;
}

export async function initRedis(): Promise<void> {
    const client = new IORedis({
        host: config.redis.host,
        port: config.redis.port,
        connectTimeout: 3000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // don't keep retrying in the background — we handle fallback ourselves
        lazyConnect: true,
    });
    // ioredis emits 'error' on the connection attempt in addition to rejecting
    // connect()/ping() — without a listener Node logs it as an unhandled event.
    client.on("error", () => {});

    try {
        await client.connect();
        await client.ping();
        activeCache = new RealRedisCache(client);
        usingRealRedis = true;
        log.info({ host: config.redis.host, port: config.redis.port }, "✅ Redis connected");
    } catch (err: unknown) {
        const error = err as Error;
        client.disconnect();
        activeCache = new InProcessCache();
        usingRealRedis = false;
        log.warn({ error: error.message }, "⚠️ Redis unreachable — falling back to in-process cache");
    }
}

/** Backward-compatible export — same object shape memory.service.ts and server.ts already use. */
export const redis: CacheClient = {
    get: (key) => activeCache.get(key),
    set: (key, value, exMode, ttlSec) => activeCache.set(key, value, exMode, ttlSec),
    snapshot: () => activeCache.snapshot(),
};
