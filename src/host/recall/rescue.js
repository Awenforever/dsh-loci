/**
 * The rewrite rescue: when the slice found nothing, ask the model for other words.
 *
 * Split from `rewrite.js` because the two answer different questions. That module knows how to
 * ask a model for alternative phrasings; this one decides *whether to* — it consumes the note the
 * prompt section left behind, costs a model call only on a miss, verifies that the rescue found
 * something real, and records the outcome either way.
 *
 * The guard rails matter more than the feature:
 *
 * - **only on a miss**: a rewrite when the slice already answered would spend a model call to
 *   possibly replace a correct answer with a different one;
 * - **one attempt per turn**: identified by the note's timestamp, so two steps in the same turn
 *   cannot each pay for it;
 * - **the original is not replaced**: the rescue adds context, it does not overwrite what the
 *   section already rendered.
 * @module dsh-loci/recall/rescue
 */
import { lastSliceOf } from './compose.js';
import { rewriteQuery } from './rewrite.js';
import { search } from '../store/search.js';
import { indexTitle, renderSafe } from '../inject/sanitize.js';

/** Bytes allowed for a rescue block. */
const RESCUE_MAX_BYTES = 640;

/** Entries a rescue may add. */
const RESCUE_LIMIT = 3;

/** Turns already rescued, keyed by `sessionId:noteTimestamp`. */
const attempted = new Set();

/** Remember which rescues were tried, bounded. */
function markAttempted(key) {
  if (attempted.size >= 256) attempted.clear();
  attempted.add(key);
}

/**
 * Build the block for entries the rewritten queries found.
 * @returns `{text, ids, bytes}`.
 */
function renderRescue(hits, queries) {
  const lines = [
    '<loci-recall note="found by searching other words for the same question; confirm with loci_get">',
    `renamed: ${renderSafe(queries.slice(0, 3).map((query) => indexTitle(query, 40)).join(' | '))}`,
  ];
  const ids = [];
  let used = Buffer.byteLength(lines.join('\n'), 'utf8');
  for (const hit of hits) {
    const line = `- ${hit.id} · ${renderSafe(indexTitle(hit.title, 60))}`;
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (used + size > RESCUE_MAX_BYTES) break;
    lines.push(line);
    ids.push(hit.id);
    used += size;
  }
  lines.push('</loci-recall>');
  const text = lines.join('\n');
  return { text, ids, bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * Rescue a missed retrieval by asking the model to rephrase the question.
 *
 * @param options - `store`, `sessionId`, `scopeKeys`, `scopeKey`, `complete`, `now`, `log`,
 *   `enabled`.
 * @returns `{rescued, text, ids, bytes, queries, error}`.
 */
export async function rescueMiss({ store, sessionId, scopeKeys, scopeKey, complete, now, log, enabled = true, query: explicitQuery }) {
  const skipped = { rescued: false, text: '', ids: [], bytes: 0, queries: [], error: undefined };
  if (enabled !== true) return skipped;
  if (typeof complete !== 'function') return { ...skipped, error: 'no model route' };
  if (!Array.isArray(scopeKeys) || scopeKeys.length === 0) return skipped;

  const note = lastSliceOf(sessionId);
  if (note === undefined) return skipped;
  // The point of the rescue is the case the synchronous path could not answer.
  if (note.tier !== 'none') return skipped;

  // The question comes from the caller, not from the note.
  //
  // This was the real defect behind three releases of "the rescue got an empty string". The prompt
  // section renders inside `preStep`, and at that moment the turn's message is still in the agent's
  // inbox — it has been claimed but not yet appended to the session log. So no event-based tracker
  // and no capture buffer could see it: both are fed by `session/event`, which fires after the
  // assembly. The waterfall *is* handed the claimed messages, so it is the only surface that knows
  // what was just asked.
  const query = typeof explicitQuery === 'string' ? explicitQuery : note.query;
  if (query.trim().length < 2) {
    audit(store, 'recall-rewrite-skip', { sessionId, reason: 'query too short', queryChars: query.length });
    return { ...skipped, error: 'query too short' };
  }

  const key = `${sessionId}:${note.at}`;
  if (attempted.has(key)) return skipped;
  markAttempted(key);

  const hints = store
    .db.prepare(
      `SELECT m.title FROM memory m JOIN memory_head h ON h.ord = m.ord
        WHERE m.scope_key IN (${scopeKeys.map(() => '?').join(', ')})
          AND h.status = 'verified' AND m.valid_to IS NULL
        ORDER BY m.updated_at DESC LIMIT 40`,
    )
    .all(...scopeKeys)
    .flatMap((row) => String(row.title ?? '').split(/[\s，。、·]+/))
    .filter((word) => word.length >= 2 && word.length <= 12)
    .slice(0, 40);

  const rewritten = await rewriteQuery({ query, hints, complete });
  if (rewritten.error !== undefined) {
    log?.debug?.(`loci: rewrite skipped: ${rewritten.error}`);
    audit(store, 'recall-rewrite-skip', {
      sessionId,
      reason: rewritten.error,
      // The length, not the text: enough to tell "the section could not see the question" from
      // "the model declined", without putting a conversation into the audit log.
      queryChars: note.query.length,
    });
    return { ...skipped, error: rewritten.error };
  }

  const found = new Map();
  for (const query of rewritten.queries) {
    const result = await search(store, {
      query,
      scopeKeys,
      statuses: ['verified'],
      limit: RESCUE_LIMIT,
      detail: 'snippet',
      sessionId,
      scopeKey,
      now,
    });
    for (const hit of result.hits) if (!found.has(hit.id)) found.set(hit.id, hit);
  }
  if (found.size === 0) {
    // A rescue that found nothing is the interesting case for tuning, and leaving it unrecorded
    // would make "the feature never ran" and "the feature ran and was useless" identical — the
    // exact confusion this project spent four releases on.
    audit(store, 'recall-rewrite-empty', { sessionId, queries: rewritten.queries });
    return { ...skipped, queries: rewritten.queries };
  }

  const block = renderRescue([...found.values()], rewritten.queries);
  audit(store, 'recall-rewrite', { sessionId, queries: rewritten.queries, ids: block.ids, bytes: block.bytes });
  log?.info?.(`loci: rewrite rescue found ${block.ids.length} entr${block.ids.length === 1 ? 'y' : 'ies'}`);
  return { rescued: true, text: block.text, ids: block.ids, bytes: block.bytes, queries: rewritten.queries, error: undefined };
}

/** Record one rescue event; the audit is best-effort and must never break a turn. */
function audit(store, event, detail) {
  try {
    store.audit.append(event, detail);
  } catch {
    /* best-effort */
  }
}

/** Clear the per-turn guard; used by tests that simulate several turns. */
export function resetRescueGuard() {
  attempted.clear();
}
