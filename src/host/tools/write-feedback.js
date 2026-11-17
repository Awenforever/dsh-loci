/**
 * What the store tells a model right after it writes.
 *
 * The constraint that shapes this: **a model does not go looking for the health of its own memory.** It
 * reads tool results and nothing else. So feedback has to ride along with an action it was going to take
 * anyway — writing — rather than living in a report nobody opens.
 *
 * Every note here is something the store can actually compute and something the model can act on in the
 * same turn. Deliberately absent:
 *
 * - **"is this entry useful"** — needs the outcome of a task, which the store never sees. Claiming it would
 *   be fabrication.
 * - **similarity** — already reported by `possibleDuplicates` from the write path itself.
 * - **anything longer than a line** — a note that needs a paragraph gets skimmed, and a skimmed note is
 *   indistinguishable from no note while costing bytes every write.
 *
 * The failure modes this watches for are the ones written down in `docs/MEMORY-CONTRACT.md` §7.
 * @module dsh-loci/tools/write-feedback
 */

/** How many of the session's own recent writes to check for having ever been shown. */
const RECENT_WINDOW = 6;

/** Below this many recent writes, "none of them was shown" is not yet a signal. */
const MIN_RECENT = 3;

/**
 * @param options - `store`, `sessionId`, `scopeKeys`.
 * @returns zero or more single-line notes, most actionable first.
 */
export function writeFeedback({ store, sessionId, scopeKeys = [] }) {
  const notes = [];
  const keys = Array.isArray(scopeKeys) && scopeKeys.length > 0 ? scopeKeys : null;

  // 1. Writes of this session that never reached a prompt.
  //
  // A verified entry that was never injected usually means the scope key is wrong — it went somewhere this
  // session never reads from — or that it is topical and simply has not come up. The second is fine, so the
  // note only fires when *most* of a session's own writes have never appeared.
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    try {
      const recent = store.db
        .prepare(
          `SELECT m.id, COALESCE(u.inject_count, 0) AS injections
             FROM memory m JOIN memory_head h ON h.ord = m.ord
             LEFT JOIN memory_usage u ON u.id = m.id
            WHERE h.status = 'verified' AND m.valid_to IS NULL AND m.source_session = ?
            ORDER BY m.created_at DESC LIMIT ?`,
        )
        .all(sessionId, RECENT_WINDOW);
      const neverShown = recent.filter((row) => Number(row.injections) === 0).length;
      if (recent.length >= MIN_RECENT && neverShown >= MIN_RECENT) {
        notes.push(
          `${neverShown} of your ${recent.length} recent writes from this session have never been injected — ` +
            'check whether the scope is one this session reads from, or whether they are topical and simply have not come up.',
        );
      }
    } catch {
      /* a diagnostic must never be the reason a write fails */
    }
  }

  // 2. The review queue.
  //
  // Candidates are invisible to the prompt, so a model that thinks it saved something may have saved
  // nothing usable. Saying so is the difference between "I recorded that" and a silent no-op.
  try {
    const clauses = keys === null ? '' : ` AND m.scope_key IN (${keys.map(() => '?').join(', ')})`;
    // `memory_head` carries only id/ord/revision/status — the scope lives on `memory`, so this has to join.
    // Writing it against `memory_head` alone threw, the catch swallowed it, and the note silently never
    // appeared; a test caught it, not the code.
    const pending = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_head h JOIN memory m ON m.ord = h.ord
          WHERE h.status = 'candidate' AND m.valid_to IS NULL${clauses}`,
      )
      .get(...(keys ?? [])).n;
    if (Number(pending) > 0) {
      notes.push(`${pending} ${pending === 1 ? 'entry is' : 'entries are'} waiting for review and never reach the prompt; a person approves them in Memory → Review.`);
    }
  } catch {
    /* ignore */
  }

  // 3. Whether the applies verdict is being used too generously.
  //
  // `always` should be rare — see `docs/MEMORY-CONTRACT.md` §1. If most verified entries claim to apply to
  // every task, the criterion has stopped discriminating and the core is filling up again, which is the
  // exact failure this column was added to end.
  try {
    const clauses = keys === null ? '' : ` AND m.scope_key IN (${keys.map(() => '?').join(', ')})`;
    const counts = store.db
      .prepare(
        `SELECT m.applies AS applies, COUNT(*) AS n
           FROM memory m JOIN memory_head h ON h.ord = m.ord
          WHERE h.status = 'verified' AND m.valid_to IS NULL${clauses}
          GROUP BY m.applies`,
      )
      .all(...(keys ?? []));
    const standing = Number(counts.find((row) => row.applies === 'always')?.n ?? 0);
    const total = counts.reduce((sum, row) => sum + Number(row.n), 0);
    if (total >= 10 && standing / total > 0.5) {
      notes.push(
        `${standing} of ${total} entries are marked always — that is far more than "applies to every task" should mean. ` +
          'A topical rule marked always is shown on every turn forever.',
      );
    }
  } catch {
    /* ignore */
  }

  return notes;
}
