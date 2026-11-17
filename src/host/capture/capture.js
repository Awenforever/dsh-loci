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

import { effectiveWriteScope } from '../scope.js';
import { stripInjected } from '../inject/fence.js';

/** Longest text kept per buffered message. */
const MESSAGE_CHAR_CAP = 4000;

/** Buffered messages per session. */
const MESSAGE_COUNT_CAP = 40;

/** Buffered bytes per session. */
const BUFFER_BYTE_CAP = 24 * 1024;

/**
 * Sentence patterns that mark a durable statement, with the kind they imply.
 *
 * These run on every user message by default, so a false positive does not stay a
 * candidate — with `autoVerifyCaptured` on it becomes a `verified` rule in the
 * `Rules (must follow)` block. Bare substring matching was therefore expensive: `别`
 * matched inside 级别, 特别, 识别, 区别 and 分别, and five ordinary sentences were measured
 * turning into rules ("我特别想看 diff", "两者区别不大，随便选"). An imperative is now
 * required to open a clause, and `不要` cannot be the tail of `要不要`.
 */
const CLAUSE_START = String.raw`(?:^|[，,、。；;：:！？!?\s]|但是|然后|所以|而且|并且|另外)`;
const DURABLE_PATTERNS = Object.freeze([
  // A forward-looking commitment. The time word is what makes it strong regardless of
  // where the clause begins.
  { re: /(?:以后|今后|下次)(?:都|一律|必须|要|不要|别再?|禁止)/, kind: 'rule' },
  {
    re: new RegExp(`${CLAUSE_START}(?:不要|别再?|禁止|不得|不允许|不可以)`, 'u'),
    kind: 'rule',
  },
  { re: /(?:必须先|一定要|务必|记得先|一定要先)/, kind: 'procedural' },
  { re: /(?:流程是|步骤是|做法是|顺序是)/, kind: 'procedural' },
  { re: /(?:记住|记一下|记下来|帮我记住)/, kind: 'semantic' },
  { re: /(?:我的|我们的)(?:偏好|习惯|约定|规则|要求|标准)/, kind: 'semantic' },
  // `约定` on its own reads as a reference ("按约定处理"), not an announcement, so it
  // needs the copula the way the others already had it.
  { re: /(?:约定是|规则是|标准是|原则是)/, kind: 'semantic' },
  { re: /\b(?:always|never|from now on|remember that|we agreed|our rule)\b/i, kind: 'rule' },
]);

/** Sentence separators for the extractor. */
const SENTENCE_SPLIT = /[。！？!?；;\n]+/;
/**
 * A sentence *plus* the punctuation that ended it.
 *
 * `split()` throws the terminator away, and whether a segment ended in `？` is the
 * difference between a statement and a question — `要不要一起吃饭？` matched the 不要
 * pattern and became a rule because that information was gone.
 */
const SENTENCE_WITH_END = /([^。！？!?；;\n]+)([。！？!?；;\n]*)/g;

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
      // Paths this session actually touched, most recent last. A tool call is the only
      // honest source: it is what the model asked to do, not what it said it did.
      files: [],
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

  /**
   * Pull file paths out of one tool call.
   *
   * Deliberately narrow: only the argument names that actually carry paths, and only
   * values that still look like a path after trimming. A false positive here would put
   * a sentence into the resumption list, which is worse than missing a file.
   *
   * @param buffer - the session buffer.
   * @param name - tool name (kept for the debug trail).
   * @param rawArguments - the JSON argument string.
   */
  #noteFiles(buffer, name, rawArguments) {
    const KEYS = /"(path|file|file_path|filePath|dir|directory|cwd|target|pattern|notebook_path)"\s*:\s*"([^"]{1,300})"/g;
    let match;
    let added = 0;
    while ((match = KEYS.exec(rawArguments)) !== null && added < 8) {
      const value = match[2].replace(/\\/g, '/').trim();
      if (value.length < 2 || value.length > 300) continue;
      // A glob is not a path someone can open; keep the directory part when it has one.
      const cleaned = value.replace(/\*\*?.*$/, '').replace(/\/$/, '');
      if (cleaned.length < 2) continue;
      if (buffer.files.includes(cleaned)) continue;
      buffer.files.push(cleaned);
      added += 1;
      if (buffer.files.length > 40) buffer.files.shift();
    }
    if (added > 0) this.log?.debug?.(`loci: ${name} touched ${added} path(s)`);
  }

  /** Record one event; never throws into the session commit path. */
  onSessionEvent(session, event) {
    try {
      if (!this.#isRoot(session)) return;
      const sessionId = session.id;
      const buffer = this.#buffer(sessionId, session);
      if (event.type === 'user/message') {
        if (event.data?.source?.kind !== 'user') return;
        // The recall block is appended as its own user message, and it is tagged `source.kind === 'user'`
        // like anything the person typed — so this filter alone let the block through to rule extraction.
        // 5.1.3 fixed the curator's transcript and missed this path; a stored entry whose title was a
        // rendered index line appeared afterwards, which is how the miss was found.
        const raw = contentText(event.data.content);
        const text = stripInjected(raw).slice(0, MESSAGE_CHAR_CAP);
        if (text.trim().length === 0) return;
        // A message that was *only* the block is not something the person said; skip it rather than
        // recording an empty turn.
        if (raw.trim().length > 0 && text.trim().length === 0) return;
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
      if (event.type === 'tool/call') {
        const name = String(event.data?.name ?? '');
        const args = event.data?.arguments;
        if (typeof args === 'string' && Buffer.byteLength(args, 'utf8') <= 8192) {
          this.#noteFiles(buffer, name, args);
        }
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
    const mode = this.config('extractMode');
    // 'session' deliberately does not schedule per turn: that is the whole point of
    // the mode. It runs once, in summarize(), when the session ends.
    if ((mode !== 'on' && mode !== 'turn') || this.extractor === undefined) return;
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
            mode: 'turn',
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

  /**
   * Where an auto-captured summary belongs.
   *
   * These follow the same boundary as an explicit write: a session summary is about one
   * conversation, so `session` and `project` both keep it local. It used to be pinned to
   * `workspace`, which put one product's conversation summaries in another product's bucket —
   * harmless for the prompt (captures are candidates and never injected) but wrong in the
   * panel and in the export, where they read as shared facts.
   *
   * @returns `{key, label}` for the effective scope of this session.
   */
  #scopeFor(cwd, sessionId) {
    const scopes = this.resolveScopes({ sessionId, cwd });
    const override = this.store?.getSessionScope?.(sessionId);
    const chosen = effectiveWriteScope(scopes, {
      override,
      configured: this.config?.('defaultScope'),
    });
    return { key: chosen.key, label: chosen.label };
  }

  /** Workspace scope key for a buffer's directory. */
  #workspaceKey(cwd, sessionId) {
    return this.#scopeFor(cwd, sessionId).key;
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
   * The buffered transcript of one session, for surfaces that read back the conversation.
   *
   * The curation pass needs the whole exchange, not just the durable-looking sentences: a
   * statement usually only makes sense next to the answer it corrected. Returning the buffer
   * itself would let a caller mutate it, so a shallow copy is returned.
   *
   * @param sessionId - the session.
   * @returns `[{seq, role, text}]` in order, or an empty array.
   */
  messagesOf(sessionId) {
    const buffer = this.sessions.get(sessionId);
    if (buffer === undefined) return [];
    return buffer.messages.map((message) => ({ ...message }));
  }

  /**
   * The text of the last user message for a session.
   *
   * The prompt section cannot see the conversation — `PromptSection.text` receives only
   * `{scope, signal}` — so retrieval has to be handed the current question. This is where it
   * comes from: the capture layer already buffers user messages, so nothing new is stored.
   *
   * @param sessionId - the session.
   * @returns the concatenated text of the newest user message, or `undefined`.
   */
  lastUserText(sessionId) {
    const buffer = this.sessions.get(sessionId);
    if (buffer === undefined) return undefined;
    for (let i = buffer.messages.length - 1; i >= 0; i -= 1) {
      const message = buffer.messages[i];
      if (message.role !== 'user') continue;
      const text = String(message.text ?? '').trim();
      return text.length === 0 ? undefined : text;
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

  /**
   * One extraction pass for a whole session, run as it ends.
   *
   * This is the middle ground the review asked for: deterministic rules catch
   * statements that announce themselves, per-turn extraction catches everything but
   * costs one review decision per turn. A session digest reads the whole
   * conversation once and proposes at most a handful of items in one sitting.
   *
   * Fire-and-forget by design: the buffer is copied before the asynchronous call so
   * releasing it cannot race with the model.
   *
   * @param sessionId - session id.
   * @param buffer - the buffered messages.
   */
  #runSessionDigest(sessionId, buffer) {
    const extractor = this.extractor;
    if (extractor === undefined || buffer === undefined || buffer.messages.length < 4) return;
    const messages = [...buffer.messages];
    const scopeKey = this.#workspaceKey(buffer.cwd, sessionId);
    const scopeLabel = this.#workspaceLabel(buffer.cwd);
    Promise.resolve()
      .then(() => extractor.run({ sessionId, mode: 'session', messages, scopeKey, scopeLabel }))
      .then((result) => {
        if (result?.written > 0) {
          this.statistics.extracted += result.written;
          this.log?.debug?.(`loci: session digest proposed ${result.written} item(s)`);
        }
      })
      .catch((error) => {
        this.log?.debug?.(`loci: session digest failed: ${String(error?.message ?? error)}`);
      });
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
    // The digest is independent of the episodic summary: a user can want one and not
    // the other, and the digest must still run when summaries are off.
    if (this.config('extractMode') === 'session' && buffer !== undefined) {
      this.#runSessionDigest(sessionId, buffer);
    }
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
        body: buffer.files.length > 0
          // The episodic entry is history: it is never injected, so this list costs the
          // prompt nothing and only helps `loci_search` answer "where were we".
          ? `${body}\n\nFiles touched this session:\n${buffer.files.slice(-20).map((file) => `- ${file}`).join('\n')}`
          : body,
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
    // Keep the terminator: whether a segment ended in a question mark decides whether it
    // can be a statement at all. `要不要一起吃饭？` used to match the 不要 pattern and
    // become a rule; split() discards the separator, so the distinction was unavailable.
    for (const match of String(message.text ?? '').matchAll(SENTENCE_WITH_END)) {
      const terminator = match[2] ?? '';
      if (terminator === '？' || terminator === '?') continue;
      const sentence = String(match[1] ?? '').replace(/\s+/g, ' ').trim();
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
