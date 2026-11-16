/**
 * Record: rules propose, a model decides.
 *
 * Measured (`scripts/eval-memory.mjs`, part B): the rule extractor has **100% precision and 50%
 * recall**. It never fires on chatter or on questions, and it misses half of what a careful
 * reader would keep — `以后部署先走灰度`, `约定发布窗口是周三`, `永远不要在周五发版`. Safe but
 * blind. That measurement is the argument for this layering, and the reason rules stay as a
 * *pre-filter* rather than the decision: a rule can cheaply say "this sentence might matter",
 * and only something that reads the whole conversation can say "this one does".
 *
 * The decision itself is a model call through an injected `callModel`, so:
 *
 * - the contract is ours, not the model's: it returns strict JSON, never prose, and the schema is
 *   validated here rather than trusted;
 * - the module is testable without a model, because the model is a dependency, not a global;
 * - the memory manager's own isolation (schema v6) is a precondition — a curator that has been
 *   injected has already been shaped by what it is judging.
 * @module dsh-loci/record
 */

/** The short system line. The full contract travels in the prompt, next to the transcript. */
export const CURATOR_SYSTEM =
  'You maintain a long-term memory store. Answer with one JSON object and nothing else.';

/** The contract handed to the curator model. Kept here so it cannot drift from the parser. */
export const CURATOR_CONTRACT = `You maintain a long-term memory store. You are given a conversation transcript and the
memories that already exist in scope. Decide what should be remembered.

Return ONLY a JSON object, no prose and no code fences:
{"keep":[{"kind":"rule|semantic|procedural","title":"...","body":"...","evidenceQuote":"...","topic":"..."}],"drop":[{"title":"...","why":"..."}]}

Rules you must follow:
- kind "rule" is a constraint that must always hold ("never deploy on Friday").
- kind "procedural" is how to do something in this project.
- kind "semantic" is a fact about the project or the person.
- title is one line, at most 120 characters, self-contained.
- body is the full statement, at most 2000 characters.
- evidenceQuote MUST be copied verbatim from a user message in the transcript. If you cannot quote
  it, do not keep it.
- Do not record: questions, plans, progress narration, values that change hourly, secrets, or
  anything already present in the existing memories.
- If nothing is worth remembering, return {"keep":[],"drop":[]}.
`;

/** Fields a curated item may carry. */
const KINDS = new Set(['rule', 'semantic', 'procedural']);

/** Longest accepted title and body, matching what the store will hold. */
const TITLE_MAX = 120;
const BODY_MAX = 2000;

/**
 * Cheap pre-filter: which user sentences could plausibly be durable.
 *
 * Deliberately permissive. The rule extractor used to be the decision, so it had to be strict
 * enough to never produce noise; now it only has to avoid *dropping* something a model would
 * have kept. The cost of a false positive is one line in a prompt to the curator; the cost of a
 * false negative is a memory that never had a chance.
 *
 * @param messages - `[{role, text}]` in order.
 * @param options - `maxSentences` cap.
 * @returns `[{seq, text}]` candidate sentences.
 */
export function prefilter(messages, options = {}) {
  const maxSentences = options.maxSentences ?? 80;
  const out = [];
  const seen = new Set();
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'user') continue;
    // The terminator is captured rather than used as a plain split. Splitting discards it, so a
    // question becomes indistinguishable from a statement and `要不要周末先发一版？` survives as
    // if it were a constraint — the same defect the rule extractor had to fix once already.
    for (const match of String(message.text ?? '').matchAll(/([^。！？!?\n]+)([。！？!?]?)/g)) {
      const body = String(match[1] ?? '').replace(/\s+/g, ' ').trim();
      const terminator = match[2] ?? '';
      if (body.length < 5 || body.length > 300) continue;
      // A question cannot be a constraint. This is the one thing the pre-filter decides, and it
      // decides only because it is free to.
      if (terminator === '？' || terminator === '?') continue;
      const key = body.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ seq: index, text: body });
      if (out.length >= maxSentences) return out;
    }
  }
  return out;
}

/**
 * Build the curator request.
 *
 * The transcript is included whole rather than only the pre-filtered sentences: a durable
 * statement often only makes sense next to the answer it corrected ("no, not that — the other
 * one"), and the model is being asked to judge, so it gets the evidence it needs to judge.
 *
 * @param options - `messages`, `existing` (titles already stored).
 * @returns the prompt string.
 */
export function buildCuratorPrompt({ messages, existing = [] }) {
  const transcript = messages
    .map((message) => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${String(message.text ?? '').slice(0, 1200)}`)
    .join('\n');
  const known = existing.length === 0 ? '(none)' : existing.map((title) => `- ${title}`).join('\n');
  return [
    CURATOR_CONTRACT,
    'Existing memories in scope (do NOT repeat these):',
    known,
    'Transcript:',
    transcript,
  ].join('\n\n');
}

/**
 * Find the first balanced JSON object in a string.
 *
 * The contract says "JSON only", and a model that adds a sentence around it is breaking the
 * contract. It is also extremely common, and the failure mode of being strict is that the whole
 * conversation's memory is discarded over a courtesy phrase. Extraction is bounded (one object,
 * balanced braces, string-aware) rather than a greedy match, so it cannot swallow unrelated text.
 *
 * @param text - the model's reply.
 * @returns the first balanced object, or `undefined`.
 */
export function extractJsonObject(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Parse and validate the curator's reply.
 *
 * Validation is not politeness: the model output is untrusted input that will be written to a
 * store and later injected into a prompt. Every field is checked, unknown kinds are rejected
 * rather than coerced, and an `evidenceQuote` that is not verbatim in the transcript drops the
 * item — the same rule the tools enforce, applied because the curator is not exempt from it.
 *
 * @param raw - the model's reply text.
 * @param options - `messages` for quote verification.
 * @returns `{items, dropped, error, extracted}`.
 */
/**
 * What the model actually said, for the audit line when the parse fails.
 *
 * Truncated and whitespace-collapsed: enough to see the shape, never enough to be a transcript. A
 * failure reason that only says "no keep array" leaves the next reader guessing, and this project has
 * already spent several releases on diagnostics that recorded *that* something failed rather than
 * *what* came back.
 *
 * @param source - the reply text.
 * @returns up to 160 characters.
 */
function headOf(source) {
  return String(source ?? '').replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * Parse the curator's reply.
 *
 * @param raw - the model reply.
 * @param options - `messages`, used as the corpus a verbatim quote must appear in.
 * @returns `{items, dropped, error, extracted}`.
 */
export function parseCuratorReply(raw, options = {}) {
  const messages = options.messages ?? [];
  const dropped = [];
  const source = String(raw ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  let extracted = false;
  try {
    parsed = JSON.parse(source);
  } catch {
    // Second attempt: the first balanced object in the reply. Recorded so a run that needed it is
    // visible — a model drifting away from the contract is worth knowing about even when the
    // memory is recovered.
    const candidate = extractJsonObject(source);
    if (candidate === undefined) {
      return { items: [], dropped, error: 'reply is not JSON', extracted: false, rawHead: headOf(source) };
    }
    try {
      parsed = JSON.parse(candidate);
      extracted = true;
    } catch {
      return { items: [], dropped, error: 'reply is not JSON', extracted: false, rawHead: headOf(source) };
    }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { items: [], dropped, error: 'reply is not JSON', extracted, rawHead: headOf(source) };
  }
  // A bare array is the same contract without its envelope, and rejecting it costs a turn's memory for
  // a formatting choice. Anything else keeps failing — but now says what came back, because "no keep
  // array" alone cannot distinguish a model using a different key from one returning a string.
  if (Array.isArray(parsed)) {
    parsed = { keep: parsed };
  }
  if (!Array.isArray(parsed.keep)) {
    return {
      items: [],
      dropped,
      error: 'reply has no keep array',
      extracted,
      rawHead: headOf(source),
    };
  }
  const corpus = messages.map((message) => String(message.text ?? '')).join('\n');
  const items = [];
  for (const candidate of parsed.keep) {
    if (candidate === null || typeof candidate !== 'object') {
      dropped.push({ reason: 'not an object' });
      continue;
    }
    const kind = String(candidate.kind ?? '').trim();
    const title = String(candidate.title ?? '').replace(/\s+/g, ' ').trim();
    const body = String(candidate.body ?? '').trim();
    const evidenceQuote = String(candidate.evidenceQuote ?? '').trim();
    if (!KINDS.has(kind)) {
      dropped.push({ title, reason: `unsupported kind: ${kind}` });
      continue;
    }
    if (title.length === 0 || title.length > TITLE_MAX) {
      dropped.push({ title, reason: `title must be 1..${TITLE_MAX} characters` });
      continue;
    }
    if (body.length === 0 || body.length > BODY_MAX) {
      dropped.push({ title, reason: `body must be 1..${BODY_MAX} characters` });
      continue;
    }
    if (evidenceQuote.length === 0 || !corpus.includes(evidenceQuote)) {
      dropped.push({ title, reason: 'evidenceQuote is not verbatim in the transcript' });
      continue;
    }
    items.push({
      kind,
      title,
      body,
      evidenceQuote,
      topic: typeof candidate.topic === 'string' ? candidate.topic.slice(0, 60) : undefined,
    });
  }
  return { items, dropped, error: undefined, extracted };
}

/**
 * Run one curation pass and write what survived validation.
 *
 * The write path is the ordinary one, so a curated memory is subject to the same evidence rule
 * and the same audit trail as a tool-written one. There is no privileged door.
 *
 * Trust comes from grounding, not from approval: an item whose `evidenceQuote` is verbatim in
 * this session's user messages passes the same quote gate a tool-supplied quote passes, and
 * lands verified. Anything else lands as a candidate and waits for a person. That is why the
 * curator needs the session id — without it the quote gate cannot ask "did the user say this".
 *
 * @param options - `store`, `scope`, `messages`, `callModel`, `sessionId`, `existing`, `dryRun`.
 * @returns `{items, dropped, written, error}`.
 */
export async function curate({ store, scope, messages, callModel, sessionId, existing = [], dryRun = false }) {
  if (typeof callModel !== 'function') return { items: [], dropped: [], written: [], error: 'no model available' };
  const prompt = buildCuratorPrompt({ messages, existing });
  let reply;
  try {
    reply = await callModel({ prompt, purpose: 'curate-memory' });
  } catch (error) {
    return { items: [], dropped: [], written: [], error: `model call failed: ${String(error?.message ?? error)}` };
  }
  const parsed = parseCuratorReply(reply, { messages });
  if (parsed.error !== undefined) {
    // `rawHead` travels with the error so the audit line can say what came back, not merely that the
    // shape was wrong.
    return { items: [], dropped: parsed.dropped, written: [], error: parsed.error, rawHead: parsed.rawHead };
  }
  if (dryRun) return { items: parsed.items, dropped: parsed.dropped, written: [], error: undefined };

  const written = [];
  for (const item of parsed.items) {
    try {
      const result = store.write({
        kind: item.kind,
        scope: scope.scope,
        scopeKey: scope.scopeKey,
        scopeLabel: scope.scopeLabel,
        title: item.title,
        body: item.body,
        // The shape the quote gate reads. A bare string here silently produced a candidate for
        // every curated item, which looked exactly like "the model judged nothing" and was
        // really "the evidence was never offered in the form the gate asks for".
        evidence: { quote: item.evidenceQuote, sessionId },
        trustSource: 'curator',
        tags: item.topic === undefined ? [] : [item.topic],
      });
      written.push({ id: result?.entry?.id, status: result?.entry?.status, title: item.title });
    } catch (error) {
      parsed.dropped.push({ title: item.title, reason: `store refused: ${String(error?.message ?? error)}` });
    }
  }
  return { items: parsed.items, dropped: parsed.dropped, written, error: undefined };
}
