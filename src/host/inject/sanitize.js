/**
 * Content preparation and the two rendering guards.
 *
 * Three different jobs live here on purpose, because getting their order wrong
 * is how prompt-injection bugs happen:
 *
 * 1. `prepareForStorage` runs once, at the persistence boundary: it cleans
 *    control characters, caps sizes, redacts high-confidence secrets, and
 *    classifies instruction-shaped text. It never escapes.
 * 2. `renderSafe` runs on every model-visible rendering: it escapes the
 *    characters that could close a fence or look like a template reference.
 *    Escaping at storage time would corrupt the stored text and double-escape
 *    later reads.
 * 3. `detectInstructionLike` decides trust, not formatting. A memory that
 *    reads like an order is not injected; it waits for a human or an explicit
 *    verification.
 * @module dsh-loci/inject/sanitize
 */

import { looksLikeIndexLine } from './fence.js';

/** Hard storage ceilings; larger input is truncated, never rejected silently. */
export const LIMITS = Object.freeze({
  titleChars: 200,
  bodyChars: 8192,
  tagCount: 16,
  tagChars: 48,
  entityCount: 32,
  entityChars: 64,
  quoteChars: 1000,
  /** A citation like `src/host/store.js:120`; enough for a path and one line number. */
  sourceRefChars: 160,
});

/**
 * Fold a title into its comparison form: NFKC, lowercase, punctuation and
 * whitespace removed. Two titles with the same fold are the same fact.
 * @param title - raw title.
 * @returns the comparison key.
 */
export function normalizeTitle(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * Characters that have no business in stored memory: C0/C1 controls, the Unicode
 * "format" class (zero-width spaces, joiners, BOM) and, most importantly, the
 * bidirectional overrides.
 *
 * Bidi is the interesting one. `\u202E` makes the *rendered* order differ from
 * the stored order, so a candidate can read as harmless in the panel — the only
 * place a human ever approves it — while the model consumes hostile text. Storage
 * is the right place to remove it, because every surface (prompt, panel, MCP,
 * export) then sees the same string.
 */
const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g;

/**
 * Remove characters that must not survive into storage, collapse line endings,
 * and cap the length.
 * @param text - raw text.
 * @param maxChars - hard ceiling.
 * @returns cleaned text.
 */
export function cleanText(text, maxChars) {
  const cleaned = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE_CHARS, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Escape text for the one place it becomes model-visible.
 *
 * - `<` / `>` / `&` become entities, so stored text can never close the
 *   `<loci-context>` fence or start a new tag.
 * - `{{` / `}}` gain a zero-width space, so even a host that interpolates
 *   prompt sections cannot see a variable reference. Two independent guards,
 *   because a regression in one must not become a system-prompt injection.
 * - Remaining C0 controls are dropped.
 *
 * @param text - stored text.
 * @returns text safe to place inside a prompt fence.
 */
export function renderSafe(text) {
  // Strip first, escape second: the `{{` guard deliberately *inserts* a
  // zero-width space, so removing unsafe characters afterwards would undo it.
  return String(text ?? '')
    .replace(UNSAFE_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{\{/g, '{\u200b{')
    .replace(/\}\}/g, '}\u200b}');
}

/** High-confidence credential shapes. Ordered most specific first. */
const SECRET_PATTERNS = Object.freeze([
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', re: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: 'connection-string', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/g },
  {
    name: 'credential-assignment',
    re: /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{16,}["']?/gi,
  },
  // The product is Chinese-first; a scanner that only knows English words misses
  // the most likely way a Chinese-speaking user leaks a credential.
  {
    name: 'credential-assignment-cjk',
    re: /(?:密码|口令|密钥|秘钥|令牌|私钥|访问令牌)\s*[:：=]\s*\S{6,}/g,
  },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: 'slack-token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { name: 'gitlab-token', re: /\bglpat-[0-9A-Za-z_-]{16,}\b/g },
  { name: 'npm-token', re: /\bnpm_[0-9A-Za-z]{30,}\b/g },
  // A presigned URL grants access without any header, so the signature segment is
  // the credential even though it looks like a hex blob.
  { name: 'presigned-url', re: /[?&](?:X-Amz-Signature|X-Amz-Credential|Signature|sig|token)=[0-9A-Za-z%._~-]{16,}/gi },
  { name: 'basic-auth-header', re: /\bAuthorization\s*:\s*(?:Basic|Token)\s+[A-Za-z0-9+/=._-]{16,}/gi },
]);

/** Instruction-shaped text: never injected until a human promotes it. */
const INSTRUCTION_PATTERNS = Object.freeze([
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i,
  /disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i,
  /forget\s+(?:all\s+)?(?:your|the)\s+(?:instructions?|rules?)/i,
  /you\s+are\s+now\s+(?:a|an|the)\b/i,
  /\bsystem\s*(?:prompt|message|instruction)\s*[:：]/i,
  /\bdo\s+not\s+(?:tell|inform|mention(?:\s+\w+)?\s+to)\s+the\s+user/i,
  /\b(?:run|execute)\s+(?:the\s+following|this)\s+(?:command|code|script)/i,
  /忽略(?:之前|以上|上面|前面|先前)(?:的)?(?:所有)?(?:指令|指示|规则|提示|要求)/,
  /无视(?:之前|以上|上面|前面|先前)(?:的)?(?:所有)?(?:指令|指示|规则|提示|要求)/,
  /(?:忘记|清空)(?:你)?(?:之前|以上|上面|先前)(?:的)?(?:所有)?(?:指令|规则|设定)/,
  /你现在是|从现在开始你是|你不再是/,
  /(?:不要|别)(?:告诉|告知)(?:用户|他|她)/,
  /(?:请)?(?:执行|运行)(?:以下|下面|这个)(?:命令|代码|脚本)/,
  /系统提示(?:词)?\s*[:：]/,
]);

/**
 * Shannon entropy of a string, used to decide whether an anonymous long token
 * looks like a key rather than prose.
 * @param value - candidate token.
 * @returns bits per character.
 */
function entropy(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Find and (depending on policy) replace high-confidence secrets.
 * @param text - candidate text.
 * @param policy - `'redact'` replaces each hit, `'reject'` reports it.
 * @returns `{text, hits}` where `hits` is a list of pattern names.
 */
export function scanSecrets(text, policy = 'redact') {
  let output = String(text ?? '');
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    if (!pattern.re.test(output)) continue;
    pattern.re.lastIndex = 0;
    hits.push(pattern.name);
    if (policy === 'redact') {
      pattern.re.lastIndex = 0;
      output = output.replace(pattern.re, `[REDACTED:${pattern.name}]`);
    }
  }
  // Anonymous high-entropy tokens: a long base64/hex run with mixed classes.
  const blob = /[A-Za-z0-9+/_=-]{40,}/g;
  for (const match of [...output.matchAll(blob)]) {
    const token = match[0];
    const classes =
      (/[a-z]/.test(token) ? 1 : 0) + (/[A-Z]/.test(token) ? 1 : 0) + (/[0-9]/.test(token) ? 1 : 0);
    if (classes < 2 || entropy(token) < 4.2) continue;
    hits.push('high-entropy-token');
    if (policy === 'redact') output = output.replace(token, '[REDACTED:high-entropy-token]');
  }
  return { text: output, hits: [...new Set(hits)] };
}

/**
 * Whether text reads like an instruction to the model rather than a fact about
 * the user's world.
 * @param text - candidate text.
 * @returns true when any instruction shape matches.
 */
export function detectInstructionLike(text) {
  const value = String(text ?? '');
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Clean and vet one memory's content before it is stored.
 *
 * @param input - `{title, body, tags, entities, evidence}`.
 * @param config - effective config (`secretPolicy`, `indexLineMaxChars`).
 * @returns `{title, body, tags, entities, evidence, flags, redactions, instructionLike, indexEcho, rejected}`.
 */
export function prepareForStorage(input, config) {
  const policy = config?.secretPolicy === 'reject' ? 'reject' : 'redact';
  const flags = [];
  const redactions = [];

  const title = cleanText(input?.title, LIMITS.titleChars);
  let body = cleanText(input?.body, LIMITS.bodyChars);
  let evidenceQuote = cleanText(input?.evidence?.quote, LIMITS.quoteChars);

  const scannedBody = scanSecrets(body, policy);
  const scannedTitle = scanSecrets(title, policy);
  const scannedQuote = scanSecrets(evidenceQuote, policy);
  body = scannedBody.text;
  const safeTitle = scannedTitle.text;
  evidenceQuote = scannedQuote.text;
  for (const hit of [...scannedBody.hits, ...scannedTitle.hits, ...scannedQuote.hits]) {
    redactions.push(hit);
    if (!flags.includes('secret-redacted')) flags.push('secret-redacted');
  }

  const instructionLike = detectInstructionLike(`${safeTitle}\n${body}`);
  if (instructionLike) flags.push('instruction-like');

  // Second line of defence against the injection feedback loop.
  //
  // The first is `stripInjected` where the user message enters the transcript, and it depends on the wrapper
  // tag being present. If a format change loses the tag, the shape of a rendered index line still gives it
  // away: an entry id followed by `· <kind> · <n> μ ago ·` is not something a person types.
  //
  // **Flagging is not enough.** The first version pushed a flag and stored the entry anyway, verified — so a
  // real echo landed in the live store at 13:56 with `flags: ["index-echo"]` and full trust, which is the
  // loop continuing with a label on it. It is quarantined like any other instruction-shaped text: `indexEcho`
  // tells the store to store it as `disputed`, where it is kept for inspection and never injected.
  const indexEcho = looksLikeIndexLine(safeTitle) || looksLikeIndexLine(body);
  if (indexEcho) flags.push('index-echo');

  // A citation back to the code the fact came from (`src/host/store.js:120`).
  // It lives with the evidence rather than in its own column: provenance is what
  // evidence already means, and the trust gate reads only `quote`.
  const sourceRef = cleanText(input?.sourceRef, LIMITS.sourceRefChars);
  const scannedRef = sourceRef.length === 0 ? undefined : scanSecrets(sourceRef, policy);
  if (scannedRef !== undefined && scannedRef.hits.length > 0) {
    redactions.push(...scannedRef.hits);
    if (!flags.includes('secret-redacted')) flags.push('secret-redacted');
  }

  const tags = Array.isArray(input?.tags)
    ? [...new Set(input.tags.map((tag) => cleanText(tag, LIMITS.tagChars)).filter(Boolean))].slice(0, LIMITS.tagCount)
    : [];

  const entities = Array.isArray(input?.entities)
    ? input.entities
        .map((entity) => {
          const name = cleanText(typeof entity === 'string' ? entity : entity?.name, LIMITS.entityChars);
          const kind = cleanText(typeof entity === 'string' ? 'thing' : entity?.kind ?? 'thing', 24) || 'thing';
          return name.length === 0 ? undefined : { name, kind };
        })
        .filter(Boolean)
        .slice(0, LIMITS.entityCount)
    : [];

  // Tags and entities are rendered, exported and returned by search like any
  // other field, so they get the same secret scan. Before this, a token pasted
  // into a tag was stored verbatim while the same token in the body was redacted.
  const scannedTags = tags.map((tag) => scanSecrets(tag, policy));
  const scannedEntities = entities.map((entity) => scanSecrets(entity.name, policy));
  for (const hit of [...scannedTags.flatMap((s) => s.hits), ...scannedEntities.flatMap((s) => s.hits)]) {
    redactions.push(hit);
    if (!flags.includes('secret-redacted')) flags.push('secret-redacted');
  }

  return {
    title: safeTitle,
    body,
    tags: scannedTags.map((entry) => entry.text),
    entities: entities.map((entity, index) => ({ ...entity, name: scannedEntities[index].text })),
    evidence: {
      ...(input?.evidence ?? {}),
      quote: evidenceQuote,
      ...(scannedRef !== undefined && scannedRef.hits.length === 0 ? { ref: scannedRef.text } : {}),
      ...(typeof input?.evidence?.sessionId === 'string' ? { sessionId: input.evidence.sessionId } : {}),
      ...(Number.isSafeInteger(input?.evidence?.eventSeq) ? { eventSeq: input.evidence.eventSeq } : {}),
      ...(scannedQuote.hits.length > 0 ? { redacted: scannedQuote.hits } : {}),
    },
    flags,
    redactions: [...new Set(redactions)],
    instructionLike,
    indexEcho,
    rejected: policy === 'reject' && redactions.length > 0,
  };
}

/**
 * Structural caps for a title shown in the index.
 * @param title - raw title.
 * @param maxChars - ceiling.
 * @returns a single-line, size-bounded title.
 */
export function indexTitle(title, maxChars) {
  const flat = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(0, maxChars - 1))}…`;
}
