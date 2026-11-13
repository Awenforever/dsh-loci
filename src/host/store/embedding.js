/**
 * Optional embedding channel.
 *
 * Lexical retrieval is the product; vectors are an enhancement that must be
 * able to disappear without taking a tool with it. This module therefore owns
 * every failure: a missing endpoint, a slow endpoint, a wrong-shaped response,
 * or a model change degrades to "lexical only" and reports it through
 * `loci_stats` instead of throwing into the agent loop.
 * @module dsh-loci/store/embedding
 */
import { createHash } from 'node:crypto';

/** Consecutive failures before the channel parks itself. */
const FAILURE_THRESHOLD = 3;

/** How long a parked channel stays parked. */
const COOLDOWN_MS = 5 * 60 * 1000;

/** Largest batch one embedding request may carry. */
const MAX_BATCH = 32;

/**
 * Normalize a vector to unit length so cosine becomes a dot product.
 * @param values - embedding components.
 * @returns a `Float32Array` of unit length.
 */
export function normalizeVector(values) {
  const vec = Float32Array.from(values);
  let norm = 0;
  for (const value of vec) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
  return vec;
}

/**
 * Encode a unit vector for storage.
 * @param vec - normalized vector.
 * @returns little-endian float32 bytes.
 */
export function vectorToBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Decode a stored vector.
 * @param blob - stored bytes.
 * @returns a `Float32Array` view over a copy.
 */
export function blobToVector(blob) {
  const buffer = Buffer.from(blob);
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

/**
 * Cosine similarity of two unit vectors (a dot product).
 * @param a - first unit vector.
 * @param b - second unit vector.
 * @returns similarity in `[-1, 1]`.
 */
export function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

/**
 * Stable key for "this text under this model", used to skip recomputation.
 * @param model - embedding model id.
 * @param text - embedded text.
 * @returns a hex digest.
 */
export function embeddingKey(model, text) {
  return createHash('sha256').update(`${model}\u0000${text}`, 'utf8').digest('hex');
}

/**
 * The HTTP channel, with its own health state.
 */
export class EmbeddingChannel {
  /**
   * @param options - `mode`, `endpoint`, `model`, `timeoutMs`, `minScore`, `log`, `fetchImpl`.
   */
  constructor(options) {
    this.mode = options.mode === 'http' ? 'http' : 'off';
    this.endpoint = options.endpoint ?? '';
    this.model = options.model ?? '';
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.minScore = options.minScore ?? 0.55;
    this.log = options.log;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.failures = 0;
    this.parkedUntil = 0;
    this.lastError = null;
    this.lastCheckedAt = null;
    this.calls = 0;
    this.vectors = 0;
  }

  /** Whether the channel could be used right now. */
  available() {
    if (this.mode !== 'http') return false;
    if (typeof this.endpoint !== 'string' || this.endpoint.length === 0) return false;
    if (typeof this.fetchImpl !== 'function') return false;
    return Date.now() >= this.parkedUntil;
  }

  /** The one-line health object `loci_stats` reports. */
  health() {
    return {
      mode: this.mode,
      configured: this.endpoint.length > 0,
      healthy: this.available() && this.failures === 0,
      calls: this.calls,
      vectors: this.vectors,
      lastError: this.lastError,
      lastCheckedAt: this.lastCheckedAt,
      parkedUntil: this.parkedUntil > Date.now() ? this.parkedUntil : null,
    };
  }

  /** Record one failure and park the channel after a short streak. */
  fail(error) {
    this.failures += 1;
    this.lastError = String(error?.message ?? error).slice(0, 200);
    this.lastCheckedAt = Date.now();
    if (this.failures >= FAILURE_THRESHOLD) {
      this.parkedUntil = Date.now() + COOLDOWN_MS;
      this.log?.warn?.(`loci: embedding channel parked for ${COOLDOWN_MS / 1000}s: ${this.lastError}`);
    }
  }

  /**
   * Embed one batch of texts.
   * @param texts - strings to embed.
   * @returns unit vectors, or `undefined` when the channel is unusable.
   */
  async embed(texts) {
    if (!this.available() || texts.length === 0) return undefined;
    this.calls += 1;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model || undefined, input: texts }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.embeddings) ? payload.embeddings : undefined;
      if (!Array.isArray(rows) || rows.length !== texts.length) throw new Error('unexpected embedding response shape');
      const vectors = rows.map((row) => normalizeVector(Array.isArray(row) ? row : row.embedding));
      if (vectors.some((vec) => vec.length === 0)) throw new Error('empty embedding');
      this.failures = 0;
      this.vectors += vectors.length;
      this.lastCheckedAt = Date.now();
      return vectors;
    } catch (error) {
      this.fail(error);
      return undefined;
    }
  }

  /**
   * Embed in bounded batches, stopping at the first unavailable batch.
   * @param texts - strings to embed.
   * @param onBatch - called with `(startIndex, vectors)` per successful batch.
   */
  async embedAll(texts, onBatch) {
    for (let start = 0; start < texts.length; start += MAX_BATCH) {
      const slice = texts.slice(start, start + MAX_BATCH);
      const vectors = await this.embed(slice);
      if (vectors === undefined) return false;
      await onBatch(start, vectors);
    }
    return true;
  }
}
