/**
 * The memory unit: the only clock this store has.
 *
 * There is no independent notion of time inside dsh-loci. MU *is* time, and the rule that follows from
 * that is the whole reason this module exists rather than a timestamp comparison somewhere:
 *
 * - "flowing" means MU changed;
 * - "older" can only mean further from the working set, measured in MU;
 * - nothing may age because a calendar advanced.
 *
 * That is not a preference. Wall clock would age every memory equally across a night when nothing
 * happened, and would age a busy two-hour session less than a boring eight-hour one — both wrong, and
 * both wrong in a way that silently changed which memories were recalled.
 *
 * ## The counter
 *
 * ```
 * delta = log(w_add * add + w_use * use + 1)
 * mu   += delta
 * ```
 *
 * `log(1) = 0` is the load-bearing detail: with no new memory and no recall, MU does not move at all.
 * Sleeping costs nothing. `log` also means the hundredth memory written on a busy day costs less than
 * the first, which is what keeps a large intake from accelerating the ageing of everything already
 * stored.
 *
 * ## What the number is not
 *
 * It is not a duration, not minutes, not comparable across installs. One injection of eight entries
 * advances `log(9) ≈ 2.2`, so an ordinary forty-step turn can advance dozens of units. Only
 * **differences** between two MU readings mean anything, and only within one store.
 * @module dsh-loci/store/mu
 */
import { readMeta, writeMeta, META_KEYS } from './schema.js';

/** Rows kept in the trail. The counter is the state; the trail is only there to explain it. */
const TRAIL_LIMIT = 5000;

/**
 * The distance formula.
 * @param add - new memories in this step.
 * @param use - entries injected or looked up in this step.
 * @param wAdd - weight of the growth component.
 * @param wUse - weight of the activity component.
 * @returns the MU increment, `>= 0`.
 */
export function muDelta(add, use, wAdd = 1, wUse = 1) {
  const growth = Math.max(0, Number(add) || 0) * (Number(wAdd) || 0);
  const activity = Math.max(0, Number(use) || 0) * (Number(wUse) || 0);
  return Math.log(growth + activity + 1);
}

/**
 * Read the counter.
 * @param db - open handle.
 * @returns the current MU, `0` on a store that has never advanced.
 */
export function muNow(db) {
  const raw = readMeta(db, META_KEYS.muNow);
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Advance the counter and record why.
 *
 * The step is a no-op when both components are zero, on purpose: it must be impossible for the clock
 * to move without something having happened, and impossible for a caller to nudge it "just because".
 *
 * @param db - open handle, already inside a transaction when the caller has one.
 * @param options - `add`, `use`, `reason`, `now` (wall clock, for the trail only), `wAdd`, `wUse`.
 * @returns `{from, to, delta}`.
 */
export function muAdvance(db, options = {}) {
  const from = muNow(db);
  const delta = muDelta(options.add, options.use, options.wAdd, options.wUse);
  if (delta === 0) return { from, to: from, delta: 0 };
  const to = from + delta;
  writeMeta(db, META_KEYS.muNow, String(to));
  db.prepare('INSERT INTO mu_event (at, mu, add_n, use_n, reason) VALUES (?, ?, ?, ?, ?)').run(
    Number(options.now ?? Date.now()),
    to,
    Math.max(0, Number(options.add) || 0),
    Math.max(0, Number(options.use) || 0),
    String(options.reason ?? 'unknown'),
  );
  // The trail is a diagnostic, not state: trimming it cannot change any answer, which is why it is
  // safe to bound it while the counter itself is never trimmed.
  const rows = Number(db.prepare('SELECT COUNT(*) AS n FROM mu_event').get()?.n ?? 0);
  if (rows > TRAIL_LIMIT) {
    db.prepare(
      'DELETE FROM mu_event WHERE id <= (SELECT id FROM mu_event ORDER BY id DESC LIMIT 1 OFFSET ?)',
    ).run(TRAIL_LIMIT);
  }
  return { from, to, delta };
}

/**
 * The most recent advances, newest last.
 * @param db - open handle.
 * @param limit - how many rows.
 * @returns `[{at, mu, add, use, reason, delta}]`.
 */
export function muTrail(db, limit = 20) {
  const rows = db
    .prepare('SELECT at, mu, add_n, use_n, reason FROM mu_event ORDER BY id DESC LIMIT ?')
    .all(Math.max(1, Math.min(500, Number(limit) || 20)))
    .reverse();
  let previous = undefined;
  return rows.map((row) => {
    const entry = {
      at: Number(row.at),
      mu: Number(row.mu),
      add: Number(row.add_n),
      use: Number(row.use_n),
      reason: String(row.reason),
      delta: previous === undefined ? undefined : Number(row.mu) - previous,
    };
    previous = Number(row.mu);
    return entry;
  });
}

/**
 * Band a distance in MU.
 *
 * The four boundaries are **initial hypotheses, not measurements** — they exist so the distribution can
 * be read and argued about, and they are configuration so they can be corrected without a code change.
 * Nothing outside reporting uses them yet.
 *
 * @param p - distance in MU (smaller is fresher).
 * @param edges - `{fresh, active, cool}` upper bounds.
 * @returns `'fresh' | 'active' | 'cool' | 'cold'`.
 */
export function muBand(p, edges = { fresh: 5, active: 50, cool: 500 }) {
  if (p < edges.fresh) return 'fresh';
  if (p < edges.active) return 'active';
  if (p < edges.cool) return 'cool';
  return 'cold';
}
