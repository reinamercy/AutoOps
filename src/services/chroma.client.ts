/**
 * AutoOps AI — Vector Store
 * Real ChromaDB (Sentence-Transformer embeddings + cosine similarity) when
 * reachable, in-process TF-IDF cosine-similarity fallback otherwise.
 * Same connect-once-at-startup / graceful-degradation pattern as database.ts.
 */
import { ChromaClient, Collection, DefaultEmbeddingFunction } from "chromadb";
import { config } from "../config";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger("VectorStore");

// ── In-process TF-IDF fallback (no Docker required) ────────────────

interface VectorDoc {
    id: string;
    document: string;
    metadata: Record<string, any>;
    tokens: string[];
}

const store: VectorDoc[] = [];

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9_\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1);
}

function termFreq(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const len = tokens.length || 1;
    for (const [t, c] of tf) tf.set(t, c / len);
    return tf;
}

function inverseDocFreq(): Map<string, number> {
    const N = store.length + 1;
    const df = new Map<string, number>();
    for (const doc of store) {
        for (const t of new Set(doc.tokens)) {
            df.set(t, (df.get(t) || 0) + 1);
        }
    }
    const idf = new Map<string, number>();
    for (const [t, count] of df) {
        idf.set(t, Math.log((N + 1) / (count + 1)) + 1);
    }
    return idf;
}

function tfidfVector(tokens: string[], idf: Map<string, number>): Map<string, number> {
    const tf = termFreq(tokens);
    const vec = new Map<string, number>();
    for (const [t, tfScore] of tf) {
        vec.set(t, tfScore * (idf.get(t) || 1));
    }
    return vec;
}

function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0, magA = 0, magB = 0;
    for (const [t, s] of a) {
        magA += s * s;
        if (b.has(t)) dot += s * b.get(t)!;
    }
    for (const [, s] of b) magB += s * s;
    if (!magA || !magB) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function storeIncidentFallback(id: string, document: string, metadata: Record<string, any>): Promise<void> {
    if (store.find((d) => d.id === id)) return;
    store.push({ id, document, metadata, tokens: tokenize(document) });
    log.info({ incidentId: id, totalDocs: store.length }, "Incident stored in TF-IDF fallback vector store");
}

async function querySimilarIncidentsFallback(
    queryText: string,
    topK: number
): Promise<Array<{ id: string; document: string; metadata: Record<string, any>; distance: number }>> {
    if (store.length === 0) return [];

    const idf = inverseDocFreq();
    const queryVec = tfidfVector(tokenize(queryText), idf);

    return store
        .map((doc) => ({
            id: doc.id,
            document: doc.document,
            metadata: doc.metadata,
            distance: 1 - cosineSim(queryVec, tfidfVector(doc.tokens, idf)),
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, topK);
}

function getVectorStoreSnapshotFallback() {
    return store.map((d) => ({
        id: d.id,
        document: d.document,
        metadata: d.metadata,
        tokenCount: d.tokens.length,
    }));
}

// ── Real ChromaDB ────────────────────────────────────────────────

let collection: Collection | null = null;
let usingRealChroma = false;

/** Whether the active vector store is real ChromaDB. Used by /api/debug/stores. */
export function isRealChroma(): boolean {
    return usingRealChroma;
}

export async function initChroma(): Promise<void> {
    try {
        const client = new ChromaClient({ path: `http://${config.chroma.host}:${config.chroma.port}` });

        // Fail fast instead of hanging if ChromaDB isn't reachable
        await Promise.race([
            client.heartbeat(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("ChromaDB heartbeat timeout")), 3000)),
        ]);

        collection = await client.getOrCreateCollection({
            name: config.chroma.collectionName,
            metadata: { "hnsw:space": "cosine" },
            embeddingFunction: new DefaultEmbeddingFunction(), // Xenova/all-MiniLM-L6-v2 — same model family as the reference paper's Sentence-BERT
        });

        usingRealChroma = true;
        log.info(
            { host: config.chroma.host, port: config.chroma.port, collection: config.chroma.collectionName },
            "✅ ChromaDB connected"
        );
    } catch (err: unknown) {
        const error = err as Error;
        collection = null;
        usingRealChroma = false;
        log.warn({ error: error.message }, "⚠️ ChromaDB unreachable — falling back to in-process TF-IDF vector store");
    }
}

// ── Public API ─────────────────────────────────────

export async function getChromaCollection(): Promise<any> {
    if (usingRealChroma && collection) return collection;
    return { size: store.length };
}

export async function storeIncident(
    incidentId: string,
    description: string,
    metadata: Record<string, any>
): Promise<void> {
    if (usingRealChroma && collection) {
        await collection.upsert({ ids: [incidentId], documents: [description], metadatas: [metadata] });
        log.info({ incidentId }, "Incident stored in ChromaDB");
        return;
    }
    await storeIncidentFallback(incidentId, description, metadata);
}

/**
 * Evaluation support (task.md T8). The generalisation experiment measures how
 * the system handles an incident class it has NEVER seen. Because the vector
 * store accumulates across runs within an arm, incident N can be served a fix
 * learned from incidents 1..N-1 — including, observed in practice, a
 * cross-class false-positive match above the 0.82 threshold. Clearing the store
 * between incidents restores the cold-start condition the claim depends on.
 *
 * Not reachable from the production pipeline — only the /api/debug route.
 */
export async function clearVectorStore(): Promise<number> {
    const cleared = store.length;
    store.length = 0;
    if (usingRealChroma && collection) {
        const existing = await collection.get();
        if (existing.ids.length) await collection.delete({ ids: existing.ids });
        return existing.ids.length;
    }
    return cleared;
}

export function getVectorStoreSnapshot() {
    if (usingRealChroma && collection) {
        return collection.get().then((res) =>
            res.ids.map((id, i) => ({
                id,
                document: res.documents[i],
                metadata: res.metadatas[i],
            }))
        );
    }
    return Promise.resolve(getVectorStoreSnapshotFallback());
}

export async function querySimilarIncidents(
    queryText: string,
    topK: number = 5
): Promise<Array<{ id: string; document: string; metadata: Record<string, any>; distance: number }>> {
    if (usingRealChroma && collection) {
        try {
            const count = await collection.count();
            if (count === 0) return [];

            const result = await collection.query({ queryTexts: [queryText], nResults: Math.min(topK, count) });
            const ids = result.ids[0] || [];
            const documents = result.documents[0] || [];
            const metadatas = result.metadatas[0] || [];
            const distances = result.distances?.[0] || [];
            const results = ids.map((id, i) => ({
                id,
                document: documents[i] || "",
                metadata: metadatas[i] || {},
                distance: distances[i] ?? 1,
            }));
            log.info(
                { queryText: queryText.slice(0, 60), results: results.length, topDistance: results[0]?.distance.toFixed(3) },
                "ChromaDB query complete"
            );
            return results;
        } catch (err: unknown) {
            const error = err as Error;
            log.warn({ error: error.message }, "ChromaDB query failed — falling back to TF-IDF for this call");
            return querySimilarIncidentsFallback(queryText, topK);
        }
    }

    const results = await querySimilarIncidentsFallback(queryText, topK);
    log.info(
        { queryText: queryText.slice(0, 60), results: results.length, topDistance: results[0]?.distance.toFixed(3) },
        "TF-IDF vector query complete"
    );
    return results;
}
