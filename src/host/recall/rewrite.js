/**
 * Rewrite a question so the words match what was stored.
 *
 * Measured limitation this exists for (`scripts/eval-memory.mjs`, part A2): the lexical slice
 * misses about 40% of reworded questions at 600 entries, and no admission threshold fixes it —
 * `atlas 要发新版本` and `atlas 服务上线先走灰度` share exactly one token. A tokenizer cannot
 * bridge that gap. A model can: it knows that "which environment first" and "canary rollout" are
 * the same question, and it can say so in the words the store already uses.
 *
 * This is deliberately the **last** resort, not the first step:
 *
 * - the synchronous slice runs first and costs nothing;
 * - a rewrite costs one model call, so it only happens when the slice found nothing at all;
 * - and the result is capped, deduplicated and labelled, because a rewritten query that finds
 *   the wrong thing is more expensive than finding nothing — it looks authoritative.
 *
 * The rewrite runs in `agent/pre-step`, which is asynchronous. A prompt *section* cannot do this:
 * its `text` is `string | ((context) => string)`, synchronous, with no session and no messages.
 * @module dsh-loci/recall/rewrite
 */
import { CURATOR_SYSTEM_TINY } from './prompts.js';

/** How many alternative phrasings to ask for. Three is enough to cover wording drift. */
const REWRITE_COUNT = 3;

/** Longest alternative query accepted, in characters. */
const REWRITE_MAX_CHARS = 120;

/**
 * The instruction. Kept terse on purpose: this runs on every miss, so its own token cost is part
 * of the price of the feature.
 */
export const REWRITE_SYSTEM = CURATOR_SYSTEM_TINY;

/**
 * Build the rewrite prompt.
 * @param query - the user's question.
 * @param hints - terms already present in the store, as a nudge toward its vocabulary.
 * @returns the prompt string.
 */
export function buildRewritePrompt(query, hints = []) {
  const vocabulary = hints.length === 0 ? '' : `\nWords that appear in the stored notes: ${hints.slice(0, 12).join(', ')}`;
  return [
    'A search over a personal note store found nothing for this question:',
    String(query ?? '').slice(0, 600),
    vocabulary,
    '',
    `Write ${REWRITE_COUNT} alternative search queries that might match how the note was written.`,
    'Use different words for the same idea, not synonyms pasted together.',
    'Reply with ONLY a JSON array of strings, for example ["...","...","..."]. No prose.',
  ].join('\n');
}

/**
 * Parse the model's alternatives.
 *
 * Rejects anything that is not a short string: a rewrite is a search query, and a paragraph-long
 * one, an object, or a number is a sign the model did something else entirely.
 *
 * @param raw - the model reply.
 * @returns `string[]` (possibly empty).
 */
export function parseRewriteReply(raw) {
  const source = String(raw ?? '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    // A plain list is a reasonable shape too, and rejecting it would lose a usable rewrite over a
    // formatting choice. A *single line* of prose is not: it means the model declined, and turning
    // "no idea" into a search query spends a retrieval to learn nothing.
    if (!source.includes('\n')) return [];
    parsed = source
      .split('\n')
      .map((line) => line.replace(/^[-*\d.\s"']+/, '').replace(/["',]+$/, '').trim())
      .filter((line) => line.length > 0);
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  const seen = new Set();
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const query = item.replace(/\s+/g, ' ').trim();
    if (query.length < 3 || query.length > REWRITE_MAX_CHARS) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(query);
    if (out.length >= REWRITE_COUNT) break;
  }
  return out;
}

/**
 * Ask the model for alternative phrasings.
 *
 * @param options - `query`, `hints`, `complete` (`{system, prompt} → text`).
 * @returns `{queries, error}`; `queries` excludes the original.
 */
export async function rewriteQuery({ query, hints = [], complete }) {
  if (typeof complete !== 'function') return { queries: [], error: 'no model route' };
  if (typeof query !== 'string' || query.trim().length < 2) return { queries: [], error: 'query too short' };
  let reply;
  try {
    reply = await complete({ system: REWRITE_SYSTEM, prompt: buildRewritePrompt(query, hints) });
  } catch (error) {
    return { queries: [], error: `model call failed: ${String(error?.message ?? error)}` };
  }
  const queries = parseRewriteReply(reply).filter((candidate) => candidate.toLowerCase() !== query.trim().toLowerCase());
  if (queries.length === 0) return { queries: [], error: 'no usable rewrite' };
  return { queries, error: undefined };
}
