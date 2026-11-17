/**
 * The memory unit: the only clock this store has.
 *
 * There is no independent notion of time inside dsh-loci. μ *is* time, and the rule that follows from
 * that is the whole reason this module exists rather than a timestamp comparison somewhere:
 *
 * - "flowing" means μ changed;
 * - "older" can only mean further from the working set, measured in μ;
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
 * `log(1) = 0` is the load-bearing detail: with no new memory and no recall, μ does not move at all.
 * Sleeping costs nothing. `log` also means the hundredth memory written on a busy day costs less than
 * the first, which is what keeps a large intake from accelerating the ageing of everything already
 * stored.
 *
 * ## What the number is not
 *
 * It is not a duration, not minutes, not comparable across installs. One injection of eight entries
 * advances `log(9) ≈ 2.2`, so an ordinary forty-step turn can advance dozens of units. Only
 * **differences** between two μ readings mean anything, and only within one store.
 * @module dsh-loci/store/mu
 */
import { readMeta, writeMeta, META_KEYS } from './schema.js';

/** Rows kept in the trail. The counter is the state; the trail is only there to explain it. */
const TRAIL_LIMIT = 5000;

/**
 * How much a single use counts towards the clock.
 *
 * Small on purpose. An injection means the prompt was assembled with this entry in it — the machinery ran.
 * That is a *weak* signal that the agent is working, not evidence that anything was learned. Measured against
 * a real store, the old weight of 1 let 1007 injections drive 99.9% of the clock.
 */
export const MU_USE_WEIGHT = 0.002;

/**
 * How much one conversation step counts towards the clock when nothing was learned.
 *
 * A background drift so that long read-only stretches do not freeze ageing entirely: 200 turns ≈ 1.4 μ, against
 * roughly 24 μ for 50 real writes. It counts *work transitions*, not seconds — with no conversation there is no
 * increment at all.
 */
export const MU_TURN_WEIGHT = 0.01;

/**
 * The migration divisor from the old driver to this one.
 *
 * Not chosen for looks. It is the ratio the **new** formula would have produced over the same history: the live
 * store held 1425 μ under the old driver, and replaying its 48 writes, 1007 injections and turn count through
 * the equations above yields ≈29 μ. Stored values are divided by this so old anchors keep a meaningful distance
 * to the new clock. See `docs/MU-DRIVER.md` §4.
 */
export const MU_RESCALE = 49;

/**
 * The distance formula.
 *
 * ```
 * Δμ = log(1 + accretion)              what was learned, weighted by how new it was
 *    + log(2) · superseded             what was invalidated — the world moved, not merely grew
 *    + wTurn · log(2)                  the conversation advanced (tiny; see docs/MU-DRIVER.md §2)
 *    + wUse · log(1 + use)             usage — a deliberately weak signal
 * ```
 *
 * **The old formula was `log(add + use + 1)`, and it measured the wrong thing.** Measured on a live store:
 * 1007 injections drove 99.9% of the clock while 48 writes drove 0.1%, which made one μ about one minute of
 * wall clock. Injections count how many times the prompt was assembled — the machinery running — not whether
 * the agent's understanding moved.
 *
 * The judgement each term encodes: **a clock should not advance because the camera took another photo.**
 *
 * @param add - new memories in this step.
 * @param use - entries injected or looked up in this step.
 * @param wAdd - weight of the growth component.
 * @param wUse - weight of the activity component; kept tiny on purpose.
 * @param options - `accretion` (sum of novelty, replaces `add` when given), `superseded`, `turn`.
 * @returns the μ increment, `>= 0`.
 */
export function muDelta(add, use, wAdd = 1, wUse = MU_USE_WEIGHT, options = {}) {
  const weight = Number(wAdd) || 0;
  const growth = Math.max(0, Number(add) || 0) * weight;
  const activity = Math.max(0, Number(use) || 0) * (Number(wUse) || 0);
  // `accretion` is the novelty-weighted version of `add`. A write that repeats something already stored adds
  // nothing — remembering the same fact twice must not age every other memory. The configured growth weight
  // still applies, so `muAddWeight` keeps meaning what it always meant.
  const accretion = Number.isFinite(Number(options.accretion))
    ? Math.max(0, Number(options.accretion)) * weight
    : growth;
  const superseded = Math.max(0, Number(options.superseded) || 0);
  const turn = Math.max(0, Math.min(1, Number(options.turn) || 0));
  return (
    Math.log(accretion + 1) +
    Math.LN2 * superseded +
    MU_TURN_WEIGHT * Math.LN2 * turn +
    Math.log(activity + 1)
  );
}

/**
 * Read the counter.
 * @param db - open handle.
 * @returns the current μ, `0` on a store that has never advanced.
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
  const delta = muDelta(options.add, options.use, options.wAdd, options.wUse, {
    accretion: options.accretion,
    superseded: options.superseded,
    turn: options.turn,
  });
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
 * Band a distance in μ.
 *
 * The four boundaries are **initial hypotheses, not measurements** — they exist so the distribution can
 * be read and argued about, and they are configuration so they can be corrected without a code change.
 * Nothing outside reporting uses them yet.
 *
 * @param p - distance in μ (smaller is fresher).
 * @param edges - `{fresh, active, cool}` upper bounds.
 * @returns `'fresh' | 'active' | 'cool' | 'cold'`.
 */
export function muBand(p, edges = { fresh: 5, active: 50, cool: 500 }) {
  if (p < edges.fresh) return 'fresh';
  if (p < edges.active) return 'active';
  if (p < edges.cool) return 'cool';
  return 'cold';
}

/**
 * The value at a fraction of a sorted list, linearly interpolated.
 *
 * @param sorted - ascending values.
 * @param fraction - 0..1.
 * @returns the interpolated value, or 0 for an empty list.
 */
export function quantile(sorted, fraction) {
  if (!Array.isArray(sorted) || sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = Math.max(0, Math.min(1, Number(fraction) || 0)) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/**
 * Band edges derived from the distances actually observed.
 *
 * Percentiles rather than constants, because the right numbers depend on how fast this store's clock
 * moves, which is a property of how the person works rather than of the plugin. `fresh` is the lower
 * quartile because a quarter of entries being within easy reach is roughly what "working set" means;
 * `active` is the median; `cool` is the 95th percentile so the cold band is the last 5% by definition.
 *
 * **Small samples fall back to the fixed edges.** With fewer than twenty distances a percentile is a
 * description of the sample, not of the distribution, and pretending otherwise would make the display
 * jump around while the store is young.
 *
 * Retirement is deliberately *not* derived from these — see the note in `store.muPositions`.
 *
 * @param distances - ascending distances in μ, entries with a real μ history only.
 * @returns `{fresh, active, cool, derived}`.
 */
export function deriveBandEdges(distances) {
  const fixed = { fresh: 5, active: 50, cool: 500, derived: false };
  if (!Array.isArray(distances) || distances.length < 20) return fixed;
  const sorted = [...distances].sort((a, b) => a - b);
  const fresh = Math.max(0.5, quantile(sorted, 0.25));
  const active = Math.max(fresh * 1.5, quantile(sorted, 0.5));
  const cool = Math.max(active * 1.5, quantile(sorted, 0.95));
  return { fresh, active, cool, derived: true };
}
