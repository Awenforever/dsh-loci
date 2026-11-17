/**
 * Where the injected block begins and ends, and how to tell it apart from what a person wrote.
 *
 * These two functions live in their own module because both sides need them and one side already imports
 * the other: `compose.js` renders the block and imports `sanitize.js`, so putting the strip in either one
 * creates a cycle. A module with no imports of its own breaks it.
 *
 * The problem they solve is a feedback loop. The block is prepended to the user message during
 * `agent/pre-step`, and the session log is written *after* that, so `session/event` reports a user message
 * that already contains it. The curator's transcript and rule extraction both read that message as what
 * the person said. In the live store this produced four entries whose titles were index lines, one of them
 * quoting another — the loop had already run twice.
 * @module dsh-loci/inject/fence
 */

/** The tag the block is wrapped in. */
export const FENCE_TAG = 'loci-context';

/**
 * Remove every injected block from a message.
 *
 * @param text - a message as it appears in the session log.
 * @returns the same message with the blocks removed and the edges trimmed.
 */
export function stripInjected(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  // Two rules, not one: a truncated frame can leave the opening tag without a close, and half an index
  // leaking into the transcript is the same bug in a rarer shape.
  return text
    .replace(/<loci-context\b[^>]*>[\s\S]*?<\/loci-context>/g, '')
    .replace(/<loci-context\b[^>]*>[\s\S]*$/g, '')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');
}

/**
 * Does this text look like a rendered index line rather than something a person wrote?
 *
 * The second line of defence, for the case where the wrapper is gone: an entry id followed by the
 * `· <kind> ·` separators, or a rendered `<n> μ ago` between them, is a shape no human types.
 *
 * @param text - candidate title or body.
 * @returns true when it should never be stored as memory.
 */
export function looksLikeIndexLine(text) {
  if (typeof text !== 'string') return false;
  return (
    /^\s*-\s*m_[0-9A-Z]{20,}\s*·/.test(text) ||
    /^\s*m_[0-9A-Z]{20,}\s*·/.test(text) ||
    /·\s*(?:now|\d+(?:\.\d+)?\s*μ ago)\s*·/.test(text)
  );
}

/**
 * Does this text still carry the opening tag anywhere?
 *
 * Used by tests and by the audit, to catch a fence that survived stripping.
 *
 * @param text - any text.
 * @returns true when the tag appears.
 */
export function hasFence(text) {
  return typeof text === 'string' && text.includes(`<${FENCE_TAG}`);
}
