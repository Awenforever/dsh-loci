/**
 * Candidate-only background extraction.
 *
 * The deterministic capture layer only records statements that announce
 * themselves ("always", "never", "we agreed"). A preference stated in passing —
 * "honestly I'd rather you show me the diff first" — carries no such marker and is
 * lost. This module asks a model to read the recent conversation and propose what
 * is worth remembering.
 *
 * Five rules keep it from becoming the thing users turn off:
 *
 * 1. **Off by default.** `extractMode` must be set explicitly.
 * 2. **Candidates only.** Everything it writes has status `candidate`; a person
 *    decides. Nothing here can reach the prompt by itself.
 * 3. **Budgeted.** A call cap per hour, a cap on candidates per run, an input cap
 *    and a timeout. Exhausting the budget is silent, not an error.
 * 4. **It can always fail.** No model configured, timeout, unparseable answer,
 *    store error — every path returns `{written: 0, reason}` and the turn is never
 *    affected.
 * 5. **Batch, don't drip.** `'session'` mode runs once, when a session ends, and
 *    proposes at most a handful of items in one go. `'turn'` mode still exists for
 *    people who want it, but reviewing one proposal per turn is how a review queue
 *    turns into a chore — the failure a heavy user described as "either it
 *    remembers too little or it makes me triage".
 *
 * @module dsh-loci/extract
 */

/** How many messages of context the extractor reads. */
const MAX_MESSAGES = 24;

/** Characters of conversation it will send, after which it gives up. */
const MAX_INPUT_CHARS = 12_000;

/** The instruction given to the model. Kept short: this runs in the background. */
const SYSTEM_PROMPT = [
  'You extract durable memory candidates from a coding conversation.',
  'Return ONLY a JSON array. Each element: {"title": string, "body": string, "kind": "semantic"|"procedural"|"rule"|"episodic", "quote": string}.',
  'Rules:',
  '- `quote` MUST be a verbatim substring of a user message in the transcript; without it the item is discarded.',
  '- Only durable facts: preferences, conventions, decisions, constraints, hard-won lessons.',
  '- Never include progress, temporary state, secrets, credentials, or anything the user did not actually say.',
  '- Prefer zero items over a guess. An empty array is a good answer.',
].join('\n');

/**
 * Render the recent conversation as plain text for the model.
 * @param messages - buffer messages (`{role, text}`).
 * @returns the transcript, or `''` when there is nothing worth reading.
 */
export function renderTranscript(messages) {
  const recent = messages.slice(-MAX_MESSAGES).filter((message) => message.role === 'user' || message.role === 'assistant');
  if (recent.length === 0) return '';
  const lines = recent.map((message) => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${String(message.text ?? '').trim()}`);
  const text = lines.join('\n\n');
  return text.length <= MAX_INPUT_CHARS ? text : text.slice(-MAX_INPUT_CHARS);
}

/**
 * Parse the model's answer into candidate shapes.
 *
 * Tolerates the usual noise: a fenced block, leading prose, a trailing comma.
 * Anything that does not survive is dropped rather than guessed at.
 * @param answer - raw model text.
 * @returns `{title, body, kind, quote}[]` (possibly empty).
 */
export function parseExtraction(answer) {
  if (typeof answer !== 'string') return [];
  const start = answer.indexOf('[');
  const end = answer.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  const slice = answer.slice(start, end + 1).replace(/,\s*]/g, ']');
  let parsed;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const KINDS = new Set(['semantic', 'procedural', 'rule', 'episodic']);
  return parsed
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      title: typeof item.title === 'string' ? item.title.trim() : '',
      body: typeof item.body === 'string' ? item.body.trim() : '',
      kind: KINDS.has(item.kind) ? item.kind : 'semantic',
      quote: typeof item.quote === 'string' ? item.quote.trim() : '',
    }))
    .filter((item) => item.title.length > 0 && item.body.length > 0 && item.quote.length >= 8);
}

/**
 * The extractor itself.
 */
export class Extractor {
  /**
   * @param options - `store`, `config` (reader), `complete` (`(prompt) => Promise<string>` | undefined),
   *   `log`, `now`.
   */
  constructor(options) {
    this.store = options.store;
    this.config = options.config;
    this.complete = options.complete;
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
    this.calls = [];
    this.lastReason = null;
  }

  /** Whether the feature is switched on *and* a model route exists. */
  enabled() {
    const mode = this.config('extractMode');
    return (mode === 'on' || mode === 'turn' || mode === 'session') && typeof this.complete === 'function';
  }

  /**
   * Count calls made in the last hour.
   * @returns how many calls remain in the hourly budget.
   */
  remainingCalls() {
    const hourAgo = this.now() - 3_600_000;
    this.calls = this.calls.filter((ts) => ts > hourAgo);
    const budget = Number(this.config('extractMaxCallsPerHour') ?? 6);
    return Math.max(0, budget - this.calls.length);
  }

  /**
   * Run one extraction pass over a session buffer.
   *
   * @param request - `sessionId`, `messages` (`{role, text}`), `scopeKey`, `scopeLabel`.
   * @returns `{written, reason, ids}` — never throws.
   */
  async run(request) {
    const fail = (reason) => {
      this.lastReason = reason;
      return { written: 0, reason, ids: [] };
    };
    const mode = this.config('extractMode');
    if (mode !== 'on' && mode !== 'turn' && mode !== 'session') return fail('disabled');
    if (typeof this.complete !== 'function') return fail('no-model');
    if (this.remainingCalls() <= 0) return fail('budget');

    const transcript = renderTranscript(request?.messages ?? []);
    if (transcript.length === 0) return fail('empty');

    let answer;
    this.calls.push(this.now());
    try {
      answer = await withTimeout(
        this.complete({ system: SYSTEM_PROMPT, prompt: transcript }),
        Number(this.config('extractTimeoutMs') ?? 20_000),
      );
    } catch (error) {
      this.log?.debug?.(`loci: extraction failed: ${String(error?.message ?? error)}`);
      return fail('model-error');
    }

    // A turn-sized batch and a session-sized digest are different products: three
    // proposals per turn is a queue nobody drains, five at the end of a session is
    // one sitting.
    const cap =
      request?.mode === 'session'
        ? Number(this.config('extractSessionMaxCandidates') ?? 5)
        : Number(this.config('extractMaxCandidates') ?? 3);
    const items = parseExtraction(answer).slice(0, cap);
    if (items.length === 0) return fail('nothing');

    // A quote that is not in the transcript means the model invented it; those
    // items are dropped here rather than stored and reviewed later.
    const userText = (request?.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => String(message.text ?? ''))
      .join('\n');
    const grounded = items.filter((item) => userText.includes(item.quote));
    if (grounded.length === 0) return fail('ungrounded');

    const ids = [];
    for (const item of grounded) {
      try {
        const result = this.store.write({
          kind: item.kind,
          scope: 'workspace',
          scopeKey: request.scopeKey,
          scopeLabel: request.scopeLabel,
          title: item.title,
          body: item.body,
          // `summary` is the trust source that never self-verifies: an extracted
          // preference is a proposal, not testimony.
          trustSource: 'summary',
          sourceSession: request.sessionId ?? null,
          evidence: { quote: item.quote, note: 'extracted from the conversation' },
        });
        ids.push(result.entry.id);
      } catch (error) {
        this.log?.debug?.(`loci: extracted item rejected: ${String(error?.message ?? error)}`);
      }
    }
    this.lastReason = ids.length === 0 ? 'store-rejected' : 'written';
    return { written: ids.length, reason: this.lastReason, ids };
  }
}

/**
 * Await a promise, rejecting after `ms`.
 * @param promise - the work.
 * @param ms - budget.
 * @returns the resolved value.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A `complete()` implementation over the Harness LLM service.
 *
 * The Host exposes `ctx.llm.stream(request)` and streams frames; the exact frame
 * shape belongs to the provider package, so this collects every frame that carries
 * text and joins them. It is deliberately tolerant rather than clever: if the
 * provider changes its chunk shape, the extractor records `model-error` and stays
 * out of the way instead of writing nothing-sentences.
 *
 * @param llm - the `llm` service from `ctx.inject(['llm'], ...)`.
 * @param modelConfig - `{provider, model}` to ask for.
 * @returns a `complete` function, or undefined when the service is unusable.
 */
export function completeViaHost(llm, modelConfig) {
  if (llm === undefined || typeof llm.stream !== 'function') return undefined;
  return async ({ system, prompt }) => {
    const request = {
      provider: modelConfig?.provider,
      model: modelConfig?.model,
      messages: [
        { role: 'system', content: [{ type: 'text', text: system }] },
        { role: 'user', content: [{ type: 'text', text: prompt }] },
      ],
    };
    const stream = llm.stream(request);
    let text = '';
    for await (const frame of stream) text += frameText(frame);
    return text;
  };
}

/**
 * Pull text out of one stream frame, whatever the provider called the field.
 * @param frame - a stream chunk.
 * @returns the text it carries, or `''`.
 */
function frameText(frame) {
  if (typeof frame === 'string') return frame;
  if (frame === null || typeof frame !== 'object') return '';
  if (typeof frame.text === 'string') return frame.text;
  if (typeof frame.delta?.text === 'string') return frame.delta.text;
  if (typeof frame.delta === 'string') return frame.delta;
  if (Array.isArray(frame.content)) {
    return frame.content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('');
  }
  return '';
}
