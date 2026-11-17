/**
 * The signed axis: where an entry sits, and what moves it.
 *
 * `docs/AXIS.md` defines the model and `docs/MEMORY-UNITS.md` §3 motivates it. This module is the only place
 * the arithmetic lives, so the renderer, the store and the calibration script cannot disagree about it.
 *
 * ```
 * 遗忘 ←———— − ————← 0 ←———— 修剪 ————← + ←———— 新记忆在这里落下 (+R)
 * ```
 *
 * Three moves, and they must stay distinct:
 *
 *   1. **creation** puts an entry at the entrance `+R`, not at the habitat. A memory nobody has used yet is
 *      in a different situation from one that was just needed, and the old code could not tell them apart
 *      because all three events wrote the same column.
 *   2. **time** moves every entry left by one per μ, unconditionally. This is what guarantees termination:
 *      no entry can be pinned in place by being popular.
 *   3. **recall** moves it right by `δ(p)`, large near 0 and small far away, with a floor so that nothing
 *      becomes permanently unreachable.
 *
 * Position is never stored as a live value. It is evaluated from an anchor pair, so time costs no writes:
 *
 * ```
 * p_now = p_base - (muNow - mu_base)
 * ```
 * @module dsh-loci/store/axis
 */

/**
 * Defaults for the four parameters.
 *
 * **Uncalibrated, but not arbitrary.** They are derived from the one rate the store can measure about
 * itself: how fast its own clock advances. The live store went from 0 to ~1160 μ in about two days, so
 * roughly **580 μ per day**. Everything below is that rate multiplied by a lifespan a person would recognise.
 *
 * - `entranceDepth` 2000 → a written memory reaches the habitat in ~3.5 days and the forgotten end in ~7,
 *   which is the window in which a rule written last week is still expected to matter.
 * - `recallBase` 120 with `recallScale` 500 → one recall recovers an entry sitting ~100 μ into the
 *   compression region (about four hours left alone), which is what "slightly aged" means here.
 * - `recallFloor` 1 → at p = −5000 the curve alone gives 0.005; the floor keeps one recall worth one μ.
 *   Without it `docs/MEMORY-UNITS.md` §7.1's abyss returns: a rarely used but important rule could sink past
 *   the point where any number of recalls brings it back.
 *
 * **`docs/AXIS.md` §4 says `R` must be measured by "one bulk ingest must not disturb the working set", and
 * that measurement has not been made.** What is here is a rate-derived estimate, labelled as such wherever a
 * person sees it. The first version used `R = 100` — two orders of magnitude short, giving a memory a
 * working life of *0.3 days*, shorter than the session that created it.
 */
export const AXIS_DEFAULTS = Object.freeze({
  /** Depth of the entrance: a new entry starts here and takes this many μ to reach the habitat. */
  entranceDepth: 400,
  /**
   * Recall amplitude at p = 0.
   *
   * Set so `rescueDepth()` lands near 23 μ — about three quarters of a working day at the measured rate of
   * ~30 μ/day. A memory neglected for less than a day comes back with one use; one neglected for a week needs
   * many. That gap is the point: `MEMORY-UNITS.md` §3.1 requires that "used once" and "used constantly" never
   * look the same.
   */
  recallBase: 30,
  /** How fast the amplitude decays with distance: δ = base · exp(−|p| / scale). */
  recallScale: 100,
  /** Floor on recall amplitude. It must stay above zero or the abyss in MEMORY-UNITS §7.1 returns. */
  recallFloor: 0.1,
  /** μ the clock advances per working day, measured from the live store under the v10 driver. */
  muPerDay: 30,
});

/**
 * Evaluate an entry's current position.
 *
 * @param anchor - `{pBase, muBase}` as stored.
 * @param muNow - the store's clock.
 * @returns the signed position, or `null` when the row predates the axis (caller decides what to do).
 */
export function positionOf(anchor, muNow) {
  const pBase = anchor?.pBase;
  const muBase = anchor?.muBase;
  // `Number(null)` is 0, not NaN — a bare `Number.isFinite(Number(x))` check therefore accepts a missing
  // anchor and reports the entry as sitting at whatever the arithmetic produces from zero. The presence
  // check has to come first, or "no position" silently becomes "position 0".
  if (pBase === null || pBase === undefined || muBase === null || muBase === undefined) return null;
  const base = Number(pBase);
  const from = Number(muBase);
  if (!Number.isFinite(base) || !Number.isFinite(from)) return null;
  const position = base - (Number(muNow) - from);
  // `-0` is a real JavaScript value and an absurd position: "exactly at the habitat" has no sign. Normalising
  // it here keeps every comparison downstream (`=== 0`, region boundaries) from depending on which branch
  // produced the zero.
  return position === 0 ? 0 : position;
}

/**
 * The anchor pair for a newly created entry: at the entrance, as of now.
 *
 * @param muNow - the store's clock.
 * @param entranceDepth - `R`.
 * @returns `{pBase, muBase}`.
 */
export function anchorForCreation(muNow, entranceDepth = AXIS_DEFAULTS.entranceDepth) {
  return { pBase: entranceDepth, muBase: Number(muNow) };
}

/**
 * The raw recall curve: how much displacement a single recall is *worth* at position `p`.
 *
 * This is the curve before any capping. It is kept separate because the shape is what `docs/AXIS.md` §2.3
 * documents and what the tests pin down; `anchorAfterRecall` decides how much of it an entry actually gets.
 *
 * **Shape: exponential, and why not a log.** The brief said "roughly logarithmic"; the exact function is a
 * design choice. Exponential is chosen because it makes the *cost* of neglect grow geometrically, which is the
 * behaviour that matters:
 *
 *  - every **347 μ** of extra age doubles the number of recalls needed to bring an entry back
 *    (`scale · ln 2`), so the curve has a half-life a person can reason about;
 *  - at the habitat one recall is worth `recallBase`; at the entrance it is worth `recallBase · e^(−R/scale)`,
 *    small enough that "used once" never looks like "used constantly".
 *
 * A logarithmic decay would fall *slower* than this in the middle of the axis: rescuing an entry 1000 μ out
 * would take ~15 recalls instead of ~25. Neither number is measurable with today's data, so the tie is broken
 * by interpretability rather than by pretending there is a measurement. `scripts/diag/recall-curve-compare.mjs`
 * prints both.
 *
 * @param p - current position.
 * @param parameters - overrides for `recallBase`, `recallScale`, `recallFloor`.
 * @returns the (positive) displacement the curve is worth.
 */
export function recallBoost(p, parameters = {}) {
  const base = Number(parameters.recallBase ?? AXIS_DEFAULTS.recallBase);
  const scale = Math.max(1e-6, Number(parameters.recallScale ?? AXIS_DEFAULTS.recallScale));
  const floor = Math.max(0, Number(parameters.recallFloor ?? AXIS_DEFAULTS.recallFloor));
  const position = Number.isFinite(Number(p)) ? Number(p) : 0;
  const curve = base * Math.exp(-Math.abs(position) / scale);
  return Math.max(floor, curve);
}

/**
 * How far right a recall actually moves an entry, given where it is.
 *
 * ```
 * p >= 0        →  0            (already at or right of the habitat; a recall has nothing to rescue)
 * p <  0        →  min(|p|, max(δ_min, δ_base · e^(−|p| / scale)))
 * ```
 *
 * **The cap at `|p|` is the whole design.** Without it the equilibrium of "time pushes left, recall pushes
 * right" sits *right* of the habitat, and the more often an entry is used the further right it sits:
 *
 * | recalled every | equilibrium position |
 * |---|---|
 * | 5 μ  | ≈ 1630 μ — deep in the entrance |
 * | 50 μ | ≈ 478 μ — the digestion zone |
 *
 * That inverts the axis. The entrance means "just arrived, not yet digested"; a memory injected 300 times is
 * the most digested thing in the store. Capping the pull at the distance to the habitat gives instead:
 * an entry at 0 that is used constantly **stays at 0**, and one that stops being used starts sinking from 0
 * like everything else. Frequent use stops ageing the entry; it does not make it newer.
 *
 * A consequence worth stating: recall does **not** overshoot into the digestion zone, so `MEMORY-UNITS.md`
 * §3.1's "a recalled memory must cross the digestion zone again" no longer describes the dynamics. Nothing
 * needs to re-digest, because nothing is pushed back in.
 *
 * @param p - current position.
 * @param parameters - curve overrides plus `entranceDepth`.
 * @returns the displacement, always `>= 0` and never more than the distance to the habitat.
 */
export function recallDisplacement(p, parameters = {}) {
  const position = Number.isFinite(Number(p)) ? Number(p) : 0;
  if (position >= 0) return 0;
  return Math.min(Math.abs(position), recallBoost(position, parameters));
}

/**
 * The anchor pair after a recall.
 *
 * @param anchor - current `{pBase, muBase}`.
 * @param muNow - the store's clock.
 * @param parameters - recall parameters and `entranceDepth`.
 * @returns `{pBase, muBase, from, to, boost}` — the new anchor plus what happened, for the audit.
 */
export function anchorAfterRecall(anchor, muNow, parameters = {}) {
  const current = positionOf(anchor, muNow) ?? 0;
  const boost = recallDisplacement(current, parameters);
  return { pBase: current + boost, muBase: Number(muNow), from: current, to: current + boost, boost };
}

/**
 * Convert a pre-v9 row into an anchor.
 *
 * The old column held the μ at which the entry was last touched by anything, so `muNow - muTouched` was its
 * distance from the working set. On the new axis that number reads as **how far the entry has already
 * travelled left** — but from where it started depends on whether it was ever used, and the old schema
 * recorded that separately in `inject_count`:
 *
 * - **Never injected** — it fell in at the entrance and has been drifting ever since:
 *   `p = R - distance`.
 * - **Injected at least once** — it has already been brought to the working set at least once, so its last
 *   touch is best read as the moment it was at the habitat. Its position is the drift since then:
 *   `p = -distance`.
 *
 * The first version used the first rule for everything, and the live store came out with 35 of 45 entries at
 * the entrance — including one injected 442 times, which the axis then described as "brand new, never
 * digested". A memory used hundreds of times is the most settled thing in the store; putting it at the
 * entrance inverted the one distinction the axis exists to make.
 *
 * **What this still cannot recover**: how *many* times an entry was recalled before its last one. The old
 * schema kept only the final stamp, so the shape of the journey is gone. The new dynamics rebuild it from
 * here — a needed entry climbs back toward the habitat the next time it is recalled.
 *
 * @param muTouched - the old column, or null.
 * @param muNow - the store's clock.
 * @param entranceDepth - `R`.
 * @param options - `injected`: whether the entry has ever been injected.
 * @returns `{pBase, muBase, inferred: true, distance, fromEntrance}`.
 */
export function anchorFromLegacy(muTouched, muNow, entranceDepth = AXIS_DEFAULTS.entranceDepth, options = {}) {
  const entrance = Number(entranceDepth);
  const touched = Number(muTouched);
  // A stamp of 0 is the v7 migration's "no history" sentinel, not μ zero.
  const distance = Number.isFinite(touched) && touched > 0 ? Math.max(0, Number(muNow) - touched) : 0;
  const fromEntrance = options.injected !== true;
  return {
    pBase: fromEntrance ? entrance - distance : -distance,
    muBase: Number(muNow),
    inferred: true,
    distance,
    fromEntrance,
  };
}

/**
 * The deepest position from which one recall returns an entry to the habitat.
 *
 * This is the axis's most quotable number: it converts four abstractions (`R`, base, scale, floor) into one
 * sentence a person can check against their own experience — *"a memory left alone for more than about four
 * hours cannot be recovered by being used once."* If that sentence is wrong, the parameters are wrong, and
 * nobody has to read the formula to notice.
 *
 * Solved numerically because the fixed point `p + δ(p) = 0` has no closed form.
 *
 * @param parameters - axis parameter overrides.
 * @returns the depth as a negative position, or 0 if even the habitat cannot reach zero.
 */
export function rescueDepth(parameters = {}) {
  let deepest = 0;
  let p = 0;
  // Walk left while a recall from there still arrives at or past zero.
  while (p > -1e6) {
    p -= 1;
    if (p + recallBoost(p, parameters) < 0) break;
    deepest = p;
  }
  return deepest;
}

/**
 * The axis in one line, for `doctor` and the panel.
 *
 * An uncalibrated parameter set is only honest if the person reading it can see what it implies.
 *
 * @param parameters - axis parameter overrides.
 * @returns a sentence naming the lifespan, the rescue depth and the calibration state.
 */
export function describeAxis(parameters = {}) {
  const entrance = Number(parameters.entranceDepth ?? AXIS_DEFAULTS.entranceDepth);
  const perDay = Math.max(1, Number(parameters.muPerDay ?? AXIS_DEFAULTS.muPerDay));
  const rescue = rescueDepth(parameters);
  const days = (mu) => (mu / perDay).toFixed(1);
  return (
    `R ${entrance} μ (habitat in ${days(entrance)} d, forgotten in ${days(2 * entrance)} d) · ` +
    `one recall rescues ${Math.abs(rescue)} μ (~${(Math.abs(rescue) / perDay * 24).toFixed(1)} h) · ` +
    'parameters rate-derived, NOT measured (docs/AXIS.md §4)'
  );
}

/**
 * Which region of the axis a position falls in.
 *
 * The regions are the model's own, not the four distance bands that preceded them: a band called "fresh" no
 * longer means anything once the entrance is a place rather than a small distance.
 *
 * @param p - signed position.
 * @param entranceDepth - `R`.
 * @returns `'entrance' | 'digesting' | 'habitat' | 'compressing' | 'forgotten'`.
 */
export function axisRegion(p, entranceDepth = AXIS_DEFAULTS.entranceDepth) {
  const entrance = Number(entranceDepth);
  const position = Number(p);
  if (!Number.isFinite(position)) return 'unknown';
  if (position >= entrance * 0.6) return 'entrance';
  if (position > entrance * 0.05) return 'digesting';
  if (position >= -entrance * 0.05) return 'habitat';
  if (position >= -entrance * 0.6) return 'compressing';
  return 'forgotten';
}

/** Ordered region names, newest to oldest end. Used for stable display ordering. */
export const AXIS_REGIONS = Object.freeze(['entrance', 'digesting', 'habitat', 'compressing', 'forgotten']);
