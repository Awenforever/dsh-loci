/**
 * The one tokenizer, used for both indexing and querying.
 *
 * SQLite's built-in tokenizers cannot segment Chinese: `unicode61` splits a
 * run of Han characters into one long token, so `用户` never matches `用户偏好`.
 * Loci therefore stores a pre-tokenized stream — Latin words plus overlapping
 * CJK bigrams — and queries it with FTS5 phrase expressions, which makes a
 * short CJK query behave like the substring search callers expect.
 *
 * Both sides MUST go through this module; a mismatch silently halves recall.
 * @module dsh-loci/store/tokenize
 */

/** A CJK code point (Han, Hiragana, Katakana, Hangul). */
const CJK_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Latin words and digits, the units FTS5 handles well on its own. */
const LATIN_WORD = /[a-z0-9_]+/g;

/** Characters that must never reach an FTS5 query string. */
const UNSAFE = /["'*():^-]/g;

/**
 * Fold text into the comparison form used by hashes, dedupe, and indexing.
 * @param text - arbitrary user text.
 * @returns NFKC, control-stripped, whitespace-collapsed, lowercased text.
 */
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    // C0/C1 controls and the unicode line/paragraph separators.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Split text into index tokens: Latin words (length >= 2) and CJK bigrams
 * (a one-character CJK run yields that single character).
 * @param text - arbitrary text.
 * @returns ordered, de-duplicated tokens.
 */
export function tokenize(text) {
  const normalized = normalizeText(text);
  const tokens = [];
  const seen = new Set();
  const push = (token) => {
    if (token.length === 0 || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };

  for (const word of normalized.match(LATIN_WORD) ?? []) {
    if (word.length >= 2) push(word);
  }

  let run = '';
  const flushRun = () => {
    if (run.length === 1) push(run);
    else for (let i = 0; i + 1 < run.length; i += 1) push(run.slice(i, i + 2));
    run = '';
  };
  for (const ch of normalized) {
    if (CJK_CHAR.test(ch)) run += ch;
    else flushRun();
  }
  flushRun();
  return tokens;
}

/**
 * The token stream written into FTS5.
 * @param text - arbitrary text.
 * @returns space-separated tokens.
 */
export function tokenStream(text) {
  return tokenize(text).join(' ');
}

/**
 * Split normalized text into runs so a query can build phrases per run.
 * @param text - arbitrary text.
 * @returns the CJK runs of the normalized text.
 */
function cjkRuns(text) {
  const runs = [];
  let run = '';
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) run += ch;
    else {
      if (run.length > 0) runs.push(run);
      run = '';
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * Build the FTS5 MATCH expression for a user query.
 *
 * - A CJK run of 3+ characters becomes a phrase of its consecutive bigrams,
 *   which is the substring semantics users expect from a short query.
 * - A 1-2 character CJK run becomes its single bigram (or a marked fallback).
 * - Latin words become prefix queries.
 *
 * @param query - raw user query.
 * @param options - `hub` predicate drops terms that are too common to be evidence.
 * @returns `{match, tokens, fallbackChars, latinTokens}`; `match` is `''` when
 *   nothing searchable remains.
 */
export function buildQueryPlan(query, options = {}) {
  const normalized = normalizeText(query).replace(UNSAFE, ' ');
  const latinTokens = (normalized.match(LATIN_WORD) ?? []).filter((word) => word.length >= 2);
  const phrases = [];
  const singles = [];
  const fallbackChars = [];

  // No token is dropped here. Precision is decided later by the admission
  // rule (a CJK run must be fully evidenced; word queries need half their
  // tokens), because dropping "hub" terms from the MATCH expression returns
  // nothing at all when every term in the query is common — which is exactly
  // what happened on a store where every title shared its subject words.
  for (const run of cjkRuns(normalized)) {
    if (run.length === 1) {
      fallbackChars.push(run);
      continue;
    }
    const bigrams = [];
    for (let i = 0; i + 1 < run.length; i += 1) bigrams.push(run.slice(i, i + 2));
    if (bigrams.length === 1) singles.push(bigrams[0]);
    else phrases.push(`"${bigrams.join(' ')}"`);
  }

  const terms = [];
  for (const phrase of phrases) terms.push(phrase);
  for (const token of singles) terms.push(token);
  // Exact terms, not prefix queries: FTS5 has no prefix index here, so `word*`
  // scans the whole term dictionary (measured: 1.4 s on a 10k-entry store).
  for (const word of latinTokens) terms.push(word);

  const tokens = [
    ...phrases.flatMap((phrase) => phrase.replace(/"/g, '').split(' ')),
    ...singles,
    ...latinTokens,
  ];
  return {
    match: terms.join(' OR '),
    tokens,
    runs: cjkRuns(normalized),
    fallbackChars,
    latinTokens,
    hub: options.hub,
  };
}

/**
 * Choose the words shown as a snippet: the longest query tokens that occur in
 * the body, in body order.
 * @param body - raw entry body.
 * @param tokens - query tokens (bigrams, words).
 * @param maxChars - snippet ceiling.
 * @returns a window around the first strong hit, or the body's head.
 */
export function makeSnippet(body, tokens, maxChars = 240) {
  const text = String(body ?? '');
  if (text.length <= maxChars) return text;
  const haystack = text.toLowerCase();
  let best = -1;
  let bestToken = '';
  for (const token of tokens) {
    if (token.length < 2) continue;
    const at = haystack.indexOf(token);
    if (at >= 0 && token.length > bestToken.length) {
      best = at;
      bestToken = token;
    }
  }
  if (best < 0) return `${text.slice(0, maxChars - 1)}…`;
  const start = Math.max(0, best - Math.floor(maxChars / 3));
  const end = Math.min(text.length, start + maxChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/**
 * Character-bigram Jaccard similarity, the duplicate heuristic.
 * @param a - first text.
 * @param b - second text.
 * @returns 0..1.
 */
export function bigramJaccard(a, b) {
  const grams = (value) => {
    const text = normalizeText(value).replace(/\s+/g, '');
    const set = new Set();
    if (text.length === 1) set.add(text);
    for (let i = 0; i + 1 < text.length; i += 1) set.add(text.slice(i, i + 2));
    return set;
  };
  const left = grams(a);
  const right = grams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}
