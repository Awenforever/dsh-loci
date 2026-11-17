/**
 * Compaction: a memory's content changes as it travels left.
 *
 * ## The gap this closes
 *
 * The axis modelled a memory moving from the entrance to the forgotten end, but the memory itself never
 * changed. `MEMORY-UNITS.md` §3 says a travelling memory is *digested* — deduplicated, trimmed, summarised,
 * merged — and then *compressed* — details dropped, then what remains merging with its neighbours. Without
 * that, "forgotten" was a label on a row that still carried every byte. The shape changed; the thing did not.
 *
 * ## What compaction may and may not touch
 *
 * | field | compaction | why |
 * |---|---|---|
 * | `body` | **shortened** | this is the detail that gets dropped |
 * | `title` | kept | a memory whose name is lost cannot be found by search |
 * | `whenCondition` | **kept** | it is the premise; a fact rendered without its premise is a lie |
 * | `applies`, `importance`, `pinned` | kept | these are judgements, not detail |
 * | `evidence` | kept | the quote gate depends on it |
 *
 * The rule is: **drop what the reader could reconstruct, never what they would need in order to know whether
 * to trust the entry at all.**
 *
 * ## Losslessness
 *
 * Every compaction writes a **new revision**; the previous text stays in `memory` as an older `revision` row.
 * So the full original is always one `loci_get <id> --revision N` away. A compressed memory is genuinely less
 * useful at a glance — that is the point — but nothing is destroyed.
 *
 * @module dsh-loci/store/compact
 */

/** Levels in order. `0` is untouched. */
export const COMPACT_LEVELS = Object.freeze([
  { level: 0, name: 'full', bodyShare: 1, floor: 0, mark: '' },
  { level: 1, name: 'digested', bodyShare: 0.6, floor: 32, mark: '…' },
  { level: 2, name: 'core', bodyShare: 0.32, floor: 22, mark: '…' },
  { level: 3, name: 'mote', bodyShare: 0.16, floor: 12, mark: '…' },
]);

/**
 * Which level a position calls for.
 *
 * The thresholds mirror the regions, so a memory is compacted at the same place it changes colour on the axis.
 * One model, one set of boundaries — two would drift apart within a release.
 *
 * @param p - signed position.
 * @param entranceDepth - `R`.
 * @returns 0..3.
 */
export function levelFor(p, entranceDepth = 400) {
  const position = Number(p);
  if (!Number.isFinite(position)) return 0;
  const R = Math.max(1, Number(entranceDepth) || 400);
  if (position > 0.35 * R) return 0; // still arriving: untouched
  if (position > 0.05 * R) return 1; // digesting: trim the elaboration
  if (position > -0.6 * R) return 2; // around the habitat: keep the claim, drop the support
  return 3; // compressing or past it: keep a mote
}

/**
 * Shorten a body without a model.
 *
 * Deterministic, so the same entry always compacts to the same text and a re-run is a no-op rather than a slow
 * erosion. Sentence-aware, because cutting mid-sentence destroys meaning in a way that cutting at a boundary
 * does not.
 *
 * @param body - current body.
 * @param level - target level.
 * @returns the shortened body, unchanged when the level is 0 or nothing can be safely removed.
 */
export function shortenBody(body, level) {
  const text = String(body ?? '').trim();
  const spec = COMPACT_LEVELS[Math.max(0, Math.min(3, Number(level) || 0))];
  if (spec.level === 0 || text.length === 0) return text;
  // The floor is per level, not global. With one shared floor the harder level could keep a whole short
  // sentence and come out *longer* than the gentler one that had already truncated mid-sentence — the axis
  // would then show a memory growing as it aged.
  const cap = Math.max(spec.floor, Math.round(text.length * spec.bodyShare));
  if (text.length <= cap) return text;

  // Split on sentence boundaries in both scripts. Prefer cutting at a boundary, but never let that override
  // the cap: a compacted level must always be shorter than the one before it.
  const sentences = text.split(/(?<=[。！？；.!?;])\s*/u).filter((part) => part.length > 0);
  if (sentences.length > 1) {
    const keep = Math.max(1, Math.ceil(sentences.length * spec.bodyShare));
    const head = sentences.slice(0, keep).join('');
    if (head.length <= cap) return head;
  }
  return `${text.slice(0, cap).trimEnd()}${spec.mark}`;
}

/**
 * Decide what compaction would do to one entry, without doing it.
 *
 * Returning a plan rather than mutating keeps the caller in charge of the transaction, and makes the whole
 * thing testable without a database.
 *
 * @param entry - `{body, position, compactLevel}`.
 * @param entranceDepth - `R`.
 * @returns `{level, body, changed, from, to}`.
 */
export function planCompaction(entry, entranceDepth = 400) {
  const from = Number(entry.compactLevel ?? 0);
  const target = levelFor(entry.position, entranceDepth);
  const current = String(entry.body ?? '');
  if (target <= from) {
    return { level: from, body: current, changed: false, from, to: from };
  }
  const next = shortenBody(current, target);
  // If shortening the stored text achieves nothing, do not pretend it was compacted: recording a level that
  // did not change the content would make the axis claim work that never happened.
  if (next === current) {
    return { level: from, body: current, changed: false, from, to: from };
  }
  return { level: target, body: next, changed: true, from, to: target };
}

/**
 * The label a compacted entry carries in its flags, so the degradation is visible rather than inferred.
 * @param level - 0..3.
 * @returns a flag name, or null at level 0.
 */
export function compactFlag(level) {
  const spec = COMPACT_LEVELS[level];
  return spec === undefined || spec.level === 0 ? null : `compacted-${spec.name}`;
}
