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

/** Hard storage ceilings; larger input is truncated, never rejected silently. */
export const LIMITS = Object.freeze({
  titleChars: 200,
  bodyChars: 8192,
  tagCount: 16,
  tagChars: 48,
  entityCount: 32,
  entityChars: 64,
  quoteChars: 1000,
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
 * Remove characters that must not survive into storage, collapse line endings,
 * and cap the length.
 * @param text - raw text.
 * @param maxChars - hard ceiling.
 * @returns cleaned text.
 */
export function cleanText(text, maxChars) {
  const cleaned = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
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
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{\{/g, '{\u200b{')
    .replace(/\}\}/g, '}\u200b}')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
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
 * @returns `{title, body, tags, entities, evidence, flags, redactions, instructionLike, rejected}`.
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

  return {
    title: safeTitle,
    body,
    tags,
    entities,
    evidence: {
      ...(input?.evidence ?? {}),
      quote: evidenceQuote,
      ...(typeof input?.evidence?.sessionId === 'string' ? { sessionId: input.evidence.sessionId } : {}),
      ...(Number.isSafeInteger(input?.evidence?.eventSeq) ? { eventSeq: input.evidence.eventSeq } : {}),
      ...(scannedQuote.hits.length > 0 ? { redacted: scannedQuote.hits } : {}),
    },
    flags,
    redactions: [...new Set(redactions)],
    instructionLike,
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
