/**
 * Deterministic session capture.
 *
 * This module exists because the two obvious alternatives are both wrong for a
 * long-lived memory layer: a model call per session makes cost invisible, and
 * recording everything turns the store into a transcript. So v1.0 captures only
 *
 * - explicit durable statements the user actually said ("always", "never",
 *   "we agreed", "remember this"), as *candidate* entries that are not
 *   injected until someone verifies them, and
 * - one episodic summary per session, written when the root agent is disposed.
 *
 * Both are cheap, both are auditable, and neither can grow the prompt.
 * @module dsh-loci/capture
 */

/** Longest text kept per buffered message. */
const MESSAGE_CHAR_CAP = 4000;

/** Buffered messages per session. */
const MESSAGE_COUNT_CAP = 40;

/** Buffered bytes per session. */
const BUFFER_BYTE_CAP = 24 * 1024;

/** Sentence patterns that mark a durable statement, with the kind they imply. */
const DURABLE_PATTERNS = Object.freeze([
  { re: /(?:以后|今后|下次)(?:都|一律|必须|要|不要|别)/, kind: 'rule' },
  { re: /(?:不要|别|禁止|不得|不允许|不能再|不可以)/, kind: 'rule' },
  { re: /(?:必须先|一定要|务必|记得先|一定要先)/, kind: 'procedural' },
  { re: /(?:流程是|步骤是|做法是|顺序是)/, kind: 'procedural' },
  { re: /(?:记住|记一下|记下来|帮我记住)/, kind: 'semantic' },
  { re: /(?:我的|我们的)(?:偏好|习惯|约定|规则|要求|标准)/, kind: 'semantic' },
  { re: /(?:约定|规则是|标准是|原则是)/, kind: 'semantic' },
  { re: /\b(?:always|never|from now on|remember that|we agreed|our rule)\b/i, kind: 'rule' },
]);

/** Sentence separators for the extractor. */
const SENTENCE_SPLIT = /[。！？!?；;\n]+/;

/**
 * Flatten message content into plain text.
 * @param content - message content blocks or a string.
 * @returns the text blocks joined by newlines.
 */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Collapse whitespace so a verbatim check is not defeated by layout.
 * @param text - raw text.
 * @returns normalized comparison text.
 */
export function quoteForm(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Per-session transcript window, durable-statement extractor, and summary
 * writer. One instance per plugin activation.
 */
export class Capture {
  /**
   * @param options - `store`, `config` (reader), `log`, `now`, `resolveScopes`.
   */
  constructor(options) {
    this.store = options.store;
    this.config = options.config;
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
    this.resolveScopes = options.resolveScopes;
    /** Optional background extractor; absent unless the feature is wired and on. */
    this.extractor = options.extractor;
    /** @type {Map<string, {messages: {seq:number, role:string, text:string}[], bytes:number, captures:number, timer:NodeJS.Timeout|undefined, turn:number, cwd:string|undefined}>} */
    this.sessions = new Map();
    this.attached = false;
    this.statistics = { captured: 0, summaries: 0, skipped: 0, extracted: 0 };
  }

  /**
   * Subscribe to session events and agent disposal.
   * @param ctx - plugin context.
   * @returns disposer.
   */
  attach(ctx) {
    if (this.attached) throw new Error('loci: capture is already attached');
    this.attached = true;
    const offEvent = ctx.on('session/event', (session, event) => this.onSessionEvent(session, event));
    const offDisposed = ctx.on('agent/disposed', ({ agent } = {}) => this.onAgentDisposed(agent));
    return () => {
      offEvent?.();
      offDisposed?.();
      this.disposeAll();
      this.attached = false;
    };
  }

  /** Whether this session is a root, user-facing session. */
  #isRoot(session) {
    const header = session?.header;
    if (header === undefined) return false;
    if (header.origin === 'subagent') return false;
    return (header.delegationDepth ?? 0) === 0;
  }

  /** The buffer for one session, created on demand. */
  #buffer(sessionId, session) {
    let buffer = this.sessions.get(sessionId);
    if (buffer === undefined) {
      buffer = {
        messages: [],
        bytes: 0,
        captures: 0,
        timer: undefined,
        turn: 0,
        cwd: session?.header?.cwd,
      };
      this.sessions.set(sessionId, buffer);
    }
    return buffer;
  }

  /** Trim a buffer to its caps, oldest first. */
  #trim(buffer) {
    while (buffer.messages.length > MESSAGE_COUNT_CAP) {
      const dropped = buffer.messages.shift();
      buffer.bytes -= Buffer.byteLength(dropped.text, 'utf8');
    }
    while (buffer.bytes > BUFFER_BYTE_CAP && buffer.messages.length > 1) {
      const dropped = buffer.messages.shift();
      buffer.bytes -= Buffer.byteLength(dropped.text, 'utf8');
    }
  }

  /** Record one event; never throws into the session commit path. */
  onSessionEvent(session, event) {
    try {
      if (!this.#isRoot(session)) return;
      const sessionId = session.id;
      const buffer = this.#buffer(sessionId, session);
      if (event.type === 'user/message') {
        if (event.data?.source?.kind !== 'user') return;
        const text = contentText(event.data.content).slice(0, MESSAGE_CHAR_CAP);
        if (text.trim().length === 0) return;
        buffer.messages.push({ seq: event.seq, role: 'user', text });
        buffer.bytes += Buffer.byteLength(text, 'utf8');
        this.#trim(buffer);
        return;
      }
      if (event.type === 'assistant/message') {
        const text = contentText(event.data?.message?.content).slice(0, MESSAGE_CHAR_CAP);
        if (text.trim().length === 0) return;
        buffer.messages.push({ seq: event.seq, role: 'assistant', text });
        buffer.bytes += Buffer.byteLength(text, 'utf8');
        this.#trim(buffer);
        return;
      }
      if (event.type === 'turn/end') {
        buffer.turn = Number(event.data?.turn ?? buffer.turn);
        if (event.data?.reason?.kind === 'completed') {
          this.#schedule(sessionId, buffer);
          // The extractor reads the same buffer, on its own timer and its own
          // budget; a failure here must never touch the turn.
          this.#scheduleExtraction(sessionId, buffer);
        }
      }
    } catch (error) {
      this.log?.warn?.(`loci: capture listener failed: ${String(error?.message ?? error)}`);
    }
  }

  /**
   * Debounced extraction pass.
   *
   * Separate timer from capture on purpose: extraction is the expensive one, and a
   * slow model must not delay the rule capture that costs nothing.
   */
  #scheduleExtraction(sessionId, buffer) {
    if (this.config('extractMode') !== 'on' || this.extractor === undefined) return;
    if (buffer.extractTimer !== undefined) return;
    const delay = Math.max(0, Number(this.config('captureDebounceMs') ?? 30000));
    buffer.extractTimer = setTimeout(() => {
      buffer.extractTimer = undefined;
      const extractor = this.extractor;
      if (extractor === undefined) return;
      Promise.resolve()
        .then(() =>
          extractor.run({
            sessionId,
            messages: buffer.messages,
            scopeKey: this.#workspaceKey(buffer.cwd, sessionId),
            scopeLabel: this.#workspaceLabel(buffer.cwd),
          }),
        )
        .then((result) => {
          if (result.written > 0) this.statistics.extracted += result.written;
        })
        .catch((error) => {
          this.log?.debug?.(`loci: extraction pass failed: ${String(error?.message ?? error)}`);
        });
    }, delay);
    buffer.extractTimer.unref?.();
  }
  /** Debounced capture pass; the timer never holds the process open. */
  #schedule(sessionId, buffer) {
    if (this.config('captureMode') !== 'rules') return;
    if (buffer.captures >= this.config('captureMaxPerSession')) return;
    if (buffer.timer !== undefined) return;
    const delay = Math.max(0, Number(this.config('captureDebounceMs') ?? 30000));
    buffer.timer = setTimeout(() => {
      buffer.timer = undefined;
      this.runCapture(sessionId);
    }, delay);
    buffer.timer.unref?.();
  }

  /**
   * Run one capture pass for a session now.
   * @param sessionId - session id.
   * @returns how many entries were written.
   */
  runCapture(sessionId) {
    const buffer = this.sessions.get(sessionId);
    if (buffer === undefined) return 0;
    if (buffer.captures >= this.config('captureMaxPerSession')) return 0;
    buffer.captures += 1;
    const userMessages = buffer.messages.filter((message) => message.role === 'user');
    const candidates = extractDurableStatements(userMessages, this.config('captureMaxPerStatementChars'));
    if (candidates.length === 0) {
      this.statistics.skipped += 1;
      return 0;
    }
    let written = 0;
    for (const candidate of candidates.slice(0, 3)) {
      try {
        this.store.write({
          kind: candidate.kind,
          scope: 'workspace',
          scopeKey: this.#workspaceKey(buffer.cwd, sessionId),
          scopeLabel: this.#workspaceLabel(buffer.cwd),
          title: candidate.title,
          body: candidate.text,
          trustSource: 'rule',
          sourceSession: sessionId,
          sourceEvent: candidate.seq,
          evidence: { quote: candidate.text, sessionId, eventSeq: candidate.seq },
        });
        written += 1;
        this.statistics.captured += 1;
      } catch (error) {
        this.log?.warn?.(`loci: capture write failed: ${String(error?.message ?? error)}`);
      }
    }
    return written;
  }

  /** Workspace scope key for a buffer's directory. */
  #workspaceKey(cwd, sessionId) {
    return this.resolveScopes({ sessionId, cwd }).workspace;
  }

  /** Workspace display label for a buffer's directory. */
  #workspaceLabel(cwd) {
    return this.resolveScopes({ sessionId: 'capture', cwd }).labels.workspace;
  }

  /** The last user message sequence seen for a session. */
  lastUserSeq(sessionId) {
    const buffer = this.sessions.get(sessionId);
    if (buffer === undefined) return undefined;
    for (let i = buffer.messages.length - 1; i >= 0; i -= 1) {
      if (buffer.messages[i].role === 'user') return buffer.messages[i].seq;
    }
    return undefined;
  }

  /**
   * Check that a quote really occurred in this session's user messages.
   * @param quote - claimed verbatim quote.
   * @param options - `sessionId`.
   * @returns true when the quote is present.
   */
  verifyQuote(quote, options = {}) {
    const target = quoteForm(quote);
    if (target.length < 4) return false;
    const buffer = this.sessions.get(options.sessionId);
    if (buffer === undefined) return false;
    return buffer.messages.some(
      (message) => message.role === 'user' && quoteForm(message.text).includes(target),
    );
  }

  /** Write the episodic summary for one session and drop its buffer. */
  summarize(sessionId, reason = 'dispose') {
    const buffer = this.sessions.get(sessionId);
    // The buffer is released even when no summary is written. Returning early
    // without this left one session's transcript (up to 24 KB) alive for the
    // lifetime of the process whenever summaries were off.
    const release = () => {
      if (buffer === undefined) return;
      if (buffer.timer !== undefined) clearTimeout(buffer.timer);
      if (buffer.extractTimer !== undefined) clearTimeout(buffer.extractTimer);
      this.sessions.delete(sessionId);
    };
    if (this.config('summaryOnDispose') !== true) {
      release();
      return 0;
    }
    if (buffer === undefined || buffer.messages.length < 2) {
      release();
      return 0;
    }
    const firstUser = buffer.messages.find((message) => message.role === 'user');
    if (firstUser === undefined) {
      release();
      return 0;
    }
    const title = `Session ${new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ')} — ${firstUser.text.replace(/\s+/g, ' ').slice(0, 60)}`;
    const body = [
      `Session summary (${reason}). ${buffer.turn} turn(s).`,
      ...buffer.messages
        .slice(-24)
        .map((message) => `- ${message.role}: ${message.text.replace(/\s+/g, ' ').slice(0, 300)}`),
    ]
      .join('\n')
      .slice(0, 4000);
    try {
      this.store.write({
        kind: 'episodic',
        scope: 'workspace',
        scopeKey: this.#workspaceKey(buffer.cwd, sessionId),
        scopeLabel: this.#workspaceLabel(buffer.cwd),
        title,
        body,
        trustSource: 'summary',
        sourceSession: sessionId,
        sourceEvent: buffer.messages.at(-1)?.seq,
        evidence: { note: 'auto summary', sessionId },
      });
      this.statistics.summaries += 1;
    } catch (error) {
      this.log?.warn?.(`loci: summary write failed: ${String(error?.message ?? error)}`);
    } finally {
      release();
    }
    return 1;
  }

  /** Summarize on root-agent disposal, then release the buffer. */
  onAgentDisposed(agent) {
    try {
      const session = agent?.session;
      if (session === undefined || !this.#isRoot(session)) return;
      this.summarize(session.id, 'dispose');
    } catch (error) {
      this.log?.warn?.(`loci: dispose capture failed: ${String(error?.message ?? error)}`);
    }
  }

  /** Summarize and clear every still-buffered session (plugin unload). */
  disposeAll() {
    for (const sessionId of [...this.sessions.keys()]) {
      try {
        this.summarize(sessionId, 'unload');
      } catch {
        /* a failing summary must not block unload */
      }
      const buffer = this.sessions.get(sessionId);
      if (buffer?.timer !== undefined) clearTimeout(buffer.timer);
      this.sessions.delete(sessionId);
    }
  }
}

/**
 * Extract candidate durable statements from user messages.
 *
 * The extractor is deliberately conservative: a sentence must match an
 * explicit "always/never/remember/we agreed" shape, be long enough to carry a
 * fact, and survive a duplicate fold. Everything it produces is a candidate,
 * so a false positive costs a row in the review queue, never a prompt token.
 *
 * @param userMessages - `[{seq, text}]` in order.
 * @param maxChars - longest accepted statement.
 * @returns `[{kind, title, text, seq}]`.
 */
export function extractDurableStatements(userMessages, maxChars = 200) {
  const out = [];
  const seen = new Set();
  for (const message of userMessages) {
    for (const raw of String(message.text ?? '').split(SENTENCE_SPLIT)) {
      const sentence = raw.replace(/\s+/g, ' ').trim();
      if (sentence.length < 6 || sentence.length > maxChars) continue;
      const matched = DURABLE_PATTERNS.find((pattern) => pattern.re.test(sentence));
      if (matched === undefined) continue;
      const key = sentence.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: matched.kind,
        title: sentence.length > 60 ? `${sentence.slice(0, 59)}…` : sentence,
        text: sentence,
        seq: message.seq,
      });
    }
  }
  return out;
}
