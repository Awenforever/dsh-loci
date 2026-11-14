/**
 * Near-duplicate detection for `loci doctor`.
 *
 * This is a *read-only* diagnostic: it points at entries that look like the same
 * fact stated twice and leaves the decision to a person, because merging is a
 * judgement call (two similar sentences can be two genuinely different rules).
 *
 * Cost matters more than recall here — `doctor` runs on every support call, so the
 * scan is bounded:
 *   - only the head revision of live, injectable entries is considered;
 *   - candidate pairs come from a shared-tag or shared-title-token index, so the
 *     expensive comparison only runs on plausible pairs;
 *   - the scan stops at `maxEntries`.
 *
 * @module dsh-loci/store/duplicates
 */

/** How many entries one scan will look at. */
const MAX_ENTRIES = 2000;

/** How many groups the report will carry. */
const MAX_GROUPS = 20;

/** Pairs at or above this title/body overlap are reported. */
export const SIMILARITY_THRESHOLD = 0.62;

/**
 * Character-bigram Jaccard, ignoring case and whitespace.
 * @param a - first text.
 * @param b - second text.
 * @returns overlap in [0, 1].
 */
export function similarity(a, b) {
  const grams = (value) => {
    const text = String(value ?? '')
      .toLowerCase()
      .replace(/\s+/g, '');
    const set = new Set();
    // A one- or two-character title still needs one gram to compare.
    if (text.length < 2) {
      if (text.length === 1) set.add(text);
      return set;
    }
    for (let index = 0; index + 1 < text.length; index += 1) set.add(text.slice(index, index + 2));
    return set;
  };
  const left = grams(a);
  const right = grams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  const jaccard = shared / (left.size + right.size - shared);
  // Containment answers a different question — "is one of these essentially the
  // other, with a word added?" — and it is the question that catches real
  // duplicates, because a restated sentence usually keeps most of the shorter
  // one. Taking the larger of the two keeps short CJK titles detectable without
  // lowering the bar for unrelated text.
  const containment = shared / Math.min(left.size, right.size);
  return Math.max(jaccard, containment);
}

/**
 * Find groups of near-duplicate entries.
 *
 * @param store - open store (needs `db`).
 * @param options - `limit` (groups), `maxEntries`, `threshold`.
 * @returns `{scanned, groups: [{ids, titles, similarity}]}`.
 */
export function findDuplicateGroups(store, options = {}) {
  const limit = Math.max(1, Math.min(MAX_GROUPS, options.limit ?? 5));
  const maxEntries = Math.max(1, Math.min(MAX_ENTRIES, options.maxEntries ?? MAX_ENTRIES));
  const threshold = Number.isFinite(options.threshold) ? options.threshold : SIMILARITY_THRESHOLD;

  const rows = store.db
    .prepare(
      `SELECT id, title, body, tags
       FROM memory m
       WHERE m.revision = (SELECT MAX(revision) FROM memory x WHERE x.id = m.id)
         AND m.status = 'verified'
         AND m.deleted_at IS NULL
         AND m.valid_to IS NULL
       ORDER BY m.ord DESC
       LIMIT ?`,
    )
    .all(maxEntries);

  // Bucket by shared tag and by a title token, so only plausible pairs are compared.
  const buckets = new Map();
  const bucket = (key, index) => {
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [index]);
    else list.push(index);
  };
  const parseTags = (value) => {
    try {
      const parsed = JSON.parse(value ?? '[]');
      return Array.isArray(parsed) ? parsed.map((tag) => String(tag).toLowerCase()) : [];
    } catch {
      return [];
    }
  };

  rows.forEach((row, index) => {
    for (const tag of parseTags(row.tags)) bucket(`tag:${tag}`, index);
    const title = String(row.title ?? '');
    // A 4-character window is long enough to be distinctive in both languages.
    // Step 1, not 2: two restatements rarely insert their extra word at the same
    // offset, and an aligned-only window set misses them completely.
    const flat = title.toLowerCase().replace(/\s+/g, '');
    for (let start = 0; start + 4 <= flat.length; start += 1) bucket(`win:${flat.slice(start, start + 4)}`, index);
  });

  const compared = new Set();
  const groups = [];
  for (const indexes of buckets.values()) {
    if (indexes.length < 2) continue;
    for (let i = 0; i < indexes.length; i += 1) {
      for (let j = i + 1; j < indexes.length; j += 1) {
        const left = indexes[i];
        const right = indexes[j];
        const key = left < right ? `${left}:${right}` : `${right}:${left}`;
        if (compared.has(key)) continue;
        compared.add(key);
        const a = rows[left];
        const b = rows[right];
        // The title carries the claim; the body only breaks ties.
        const score = Math.max(similarity(a.title, b.title), 0.9 * similarity(`${a.title}\n${a.body}`, `${b.title}\n${b.body}`));
        if (score < threshold) continue;
        groups.push({
          ids: [a.id, b.id],
          titles: [a.title, b.title],
          similarity: Number(score.toFixed(3)),
        });
      }
    }
  }

  groups.sort((a, b) => b.similarity - a.similarity);
  return { scanned: rows.length, groups: groups.slice(0, limit) };
}
