/**
 * When curation runs.
 *
 * Two moments, matching the two halves of the analogy the operator used:
 *
 * - **awake** — the model calls `loci_write` while working. Already exists; no trigger needed.
 * - **sleep** — when a conversation is disposed, a curation pass reads the transcript and decides
 *   what was durable enough to keep.
 *
 * The pass runs through an injected `callModel`, so this module owns the *decision to run and
 * what happens to the result*, not how a model is reached. That split is deliberate: the trigger
 * is testable today, and the transport can be replaced without touching the judgement.
 * @module dsh-loci/record/trigger
 */
import { curate, prefilter } from './curator.js';

/** Most messages handed to one curation pass. */
const TRANSCRIPT_CAP = 120;

/**
 * Build the dispose handler.
 *
 * @param options - `store`, `config` (reader), `capture` (message buffer), `callModel`,
 *   `resolveScopes`, `log`, `now`.
 * @returns an async `(agent) => result` handler; never throws into the disposal path.
 */
export function createCurationTrigger({ store, config, capture, callModel, resolveScopes, log, now }) {
  return async function curateOnDispose(agent) {
    const session = agent?.session;
    if (session === undefined) return { ran: false, reason: 'no session' };
    if (config('curatorMode') !== 'session-end') return { ran: false, reason: 'off' };
    // Curation is for the conversations a person actually had. A subagent's transcript is
    // working state for one delegated step, and treating it as testimony would let a delegate
    // write memory its principal never agreed to.
    if ((session.header?.delegationDepth ?? 0) > 0 || session.header?.origin === 'subagent') {
      return { ran: false, reason: 'not a root conversation' };
    }
    const messages = capture?.messagesOf?.(session.id) ?? [];
    if (messages.length < 2) return { ran: false, reason: 'nothing to read' };
    const candidates = prefilter(messages.slice(-TRANSCRIPT_CAP));
    if (candidates.length === 0) return { ran: false, reason: 'no candidate sentence' };

    const scopes = resolveScopes({ sessionId: session.id, cwd: session.header?.cwd });
    const scopeKind = config('defaultScope') === 'auto'
      ? scopes.projectRootFound
        ? 'project'
        : 'session'
      : config('defaultScope');
    const scope = {
      scope: scopeKind,
      scopeKey: scopes[scopeKind],
      scopeLabel: scopes.labels[scopeKind],
    };
    const existing = existingTitles(store, scopes);

    try {
      const result = await curate({
        store,
        scope,
        messages: messages.slice(-TRANSCRIPT_CAP),
        callModel,
        sessionId: session.id,
        existing,
        now,
      });
      if (result.error !== undefined) {
        log?.warn?.(`loci: curation skipped: ${result.error}`);
        return { ran: false, reason: result.error };
      }
      log?.info?.(
        `loci: curated ${result.written.length} of ${result.items.length} candidate(s) from ${session.id}`,
      );
      return { ran: true, written: result.written, dropped: result.dropped, candidates: candidates.length };
    } catch (error) {
      // A disposal path must never surface an exception: the conversation is already ending and
      // there is nobody left to handle it.
      log?.warn?.(`loci: curation failed: ${String(error?.message ?? error)}`);
      return { ran: false, reason: String(error?.message ?? error) };
    }
  };
}

/**
 * Titles already stored in this session's read set.
 *
 * Handed to the curator so it does not spend its decision on something already known — a
 * duplicate costs an index line and splits the ranking between two rows that say the same thing.
 */
function existingTitles(store, scopes) {
  const keys = [scopes.session, scopes.workspace, scopes.project, scopes.global].filter(
    (key) => typeof key === 'string',
  );
  if (keys.length === 0) return [];
  const rows = store.db
    .prepare(
      `SELECT m.title FROM memory m JOIN memory_head h ON h.ord = m.ord
        WHERE m.scope_key IN (${keys.map(() => '?').join(', ')})
          AND h.status = 'verified' AND m.valid_to IS NULL
        ORDER BY m.updated_at DESC LIMIT 80`,
    )
    .all(...keys);
  return rows.map((row) => String(row.title));
}
