/**
 * The five model-facing tools.
 *
 * Five is a budget, not an accident: every extra tool schema is permanent
 * prompt cost, and the measured memory plugins that shipped 17 or 22 tools paid
 * for it on every request. The set covers the whole loop — write, find, read,
 * forget, inspect — and the panel/MCP surfaces reuse the same store methods.
 * @module dsh-loci/tools
 */
import { readScopeKeys, resolveScopes, selectScope } from '../scope.js';
import { search } from '../store/search.js';
import { indexTitle, renderSafe } from '../inject/sanitize.js';
import { MemoryNotFoundError, MemoryRejectedError, RevisionConflictError } from '../store/store.js';
import { formatDate } from '../inject/index-section.js';

const KINDS = ['working', 'episodic', 'semantic', 'procedural', 'rule'];
const SCOPES = ['session', 'workspace', 'project', 'global'];
const OUTPUT_SCHEMA = { type: 'object' };
const DAY = 86_400_000;

/** A plain string argument. */
function str(args, key, options = {}) {
  const value = args?.[key];
  if (value === undefined || value === null) {
    if (options.required === true) throw new Error(`${key} is required`);
    return options.fallback;
  }
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  const trimmed = options.trim === false ? value : value.trim();
  if (options.required === true && trimmed.length === 0) throw new Error(`${key} must not be empty`);
  if (options.maxChars !== undefined && trimmed.length > options.maxChars) {
    throw new Error(`${key} must be at most ${options.maxChars} characters`);
  }
  return trimmed;
}

/** An integer argument with bounds. */
function int(args, key, options = {}) {
  const value = args?.[key];
  if (value === undefined || value === null) return options.fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${key} must be an integer`);
  if (options.min !== undefined && parsed < options.min) throw new Error(`${key} must be >= ${options.min}`);
  if (options.max !== undefined && parsed > options.max) throw new Error(`${key} must be <= ${options.max}`);
  return parsed;
}

/** A boolean argument. */
function bool(args, key, fallback) {
  const value = args?.[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
  return value;
}

/** One value from a fixed set. */
function oneOf(args, key, allowed, fallback) {
  const value = args?.[key];
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value)) throw new Error(`${key} must be one of: ${allowed.join(', ')}`);
  return value;
}

/** An array of short strings. */
function strList(args, key, options = {}) {
  const value = args?.[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  if (value.length > options.maxItems) throw new Error(`${key} must have at most ${options.maxItems} items`);
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error(`${key} must be an array of strings`);
    const trimmed = item.trim();
    if (trimmed.length === 0 || trimmed.length > options.maxChars) {
      throw new Error(`${key} items must be 1..${options.maxChars} characters`);
    }
    return trimmed;
  });
}

/**
 * Resolve the session identity behind one tool call.
 * @param exec - tool execution context.
 * @returns `{sessionId, scopes, header}`.
 */
function execContext(exec) {
  const session = exec?.agent?.session;
  const sessionId = session?.id;
  const cwd = session?.header?.cwd;
  return { sessionId, scopes: resolveScopes({ sessionId, cwd }), header: session?.header };
}

/** Compact one entry for a tool result. */
function renderEntryLine(hit) {
  return `${hit.id} · ${hit.kind} · ${formatDate(hit.validFrom)} · ${renderSafe(indexTitle(hit.title, 100))}`;
}

/**
 * Build the tool definitions.
 * @param deps - `store`, `config` (reader), `log`, `capture`.
 * @returns the five definitions.
 */
export function createTools(deps) {
  const { store, config, log, capture } = deps;

  const write = {
    name: 'loci_write',
    description:
      'Save one durable fact, convention, decision, or lesson to long-term memory, or update/re-verify an existing entry. ' +
      'Use it when the user states a lasting rule ("always", "never", "we agreed"), corrects something you will need next session, ' +
      'or when you find a non-obvious pitfall worth not repeating. Do not save progress, temporary state, or secrets. ' +
      '`evidenceQuote` must be a verbatim quote from this conversation: without it the entry is stored as unverified and is not injected.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['create', 'update', 'verify', 'dispute', 'pin', 'unpin', 'restore'] },
        id: { type: 'string', description: 'Target memory id for update/verify/dispute/pin/unpin/restore.' },
        expectedRevision: { type: 'integer', description: 'Optimistic lock for update; mismatch returns the current revision.' },
        kind: { type: 'string', enum: KINDS, description: 'semantic (fact), procedural (how-to), rule (hard constraint), episodic (event), working (this session only).' },
        scope: { type: 'string', enum: SCOPES, description: 'Default workspace. Use global only for user-wide preferences.' },
        title: { type: 'string', description: 'One line, self-contained: what a future session must know.' },
        body: { type: 'string', description: 'The fact plus why it matters, and the exact command or path when relevant.' },
        tags: { type: 'array', items: { type: 'string' } },
        entities: { type: 'array', items: { type: 'string' }, description: 'Projects, hosts, files, tools this fact is about.' },
        evidenceQuote: { type: 'string', description: 'Verbatim quote from the user that supports this entry.' },
        evidenceNote: { type: 'string' },
        validFrom: { type: 'string', description: 'ISO time the fact became true (default: now).' },
        ttlDays: { type: 'integer', description: 'Close the fact after N days (default: no expiry).' },
        pinned: { type: 'boolean' },
        force: { type: 'boolean', description: 'Keep a near-duplicate instead of reporting it.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderWrite(value) }],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const context = execContext(exec);
      const op = oneOf(args, 'op', ['create', 'update', 'verify', 'dispute', 'pin', 'unpin', 'restore'], 'create');
      const id = str(args, 'id', { fallback: undefined });

      if (op === 'verify' || op === 'dispute') {
        if (id === undefined) throw new Error('id is required for verify/dispute');
        const actor = op === 'verify' ? 'user' : 'user';
        const entry = store.setTrust(id, op === 'verify' ? 'verified' : 'disputed', { actor });
        return { op, entry, warnings: [], possibleDuplicates: [] };
      }
      if (op === 'pin' || op === 'unpin') {
        if (id === undefined) throw new Error('id is required for pin/unpin');
        return { op, entry: store.setPinned(id, op === 'pin'), warnings: [], possibleDuplicates: [] };
      }
      if (op === 'restore') {
        if (id === undefined) throw new Error('id is required for restore');
        store.forget(id, { mode: 'restore', actor: 'user' });
        return { op, entry: store.get(id).entry, warnings: [], possibleDuplicates: [] };
      }

      const scopeKind = oneOf(args, 'scope', SCOPES, config('defaultScope'));
      const selected = selectScope(context.scopes, scopeKind);
      const kind = oneOf(args, 'kind', KINDS, 'semantic');
      const title = str(args, 'title', { fallback: undefined });
      const body = str(args, 'body', { fallback: undefined });
      const evidenceQuote = str(args, 'evidenceQuote', { fallback: undefined });
      const tags = strList(args, 'tags', { maxItems: 16, maxChars: 48 });
      const entities = strList(args, 'entities', { maxItems: 32, maxChars: 64 });
      const ttlDays = int(args, 'ttlDays', { min: 1, max: 3650 });
      const validFromRaw = str(args, 'validFrom', { fallback: undefined });
      const validFrom = validFromRaw === undefined ? undefined : Date.parse(validFromRaw);
      if (validFromRaw !== undefined && Number.isNaN(validFrom)) throw new Error('validFrom must be an ISO timestamp');
      const now = Date.now();
      const lastUserSeq = capture?.lastUserSeq?.(context.sessionId);

      const base = {
        kind,
        scope: selected.scope,
        scopeKey: selected.key,
        scopeLabel: selected.label,
        tags,
        entities,
        sourceSession: context.sessionId ?? null,
        sourceEvent: Number.isSafeInteger(lastUserSeq) ? lastUserSeq : undefined,
        evidence: {
          ...(evidenceQuote === undefined ? {} : { quote: evidenceQuote }),
          ...(str(args, 'evidenceNote', { fallback: undefined }) === undefined
            ? {}
            : { note: str(args, 'evidenceNote', { fallback: undefined }) }),
          ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
          ...(Number.isSafeInteger(lastUserSeq) ? { eventSeq: lastUserSeq } : {}),
        },
        validFrom,
        validTo: ttlDays === undefined ? undefined : now + ttlDays * DAY,
        pinned: bool(args, 'pinned', false),
        force: bool(args, 'force', false),
        trustSource: 'tool',
      };

      if (op === 'update') {
        if (id === undefined) throw new Error('id is required for update');
        if (title === undefined || body === undefined) throw new Error('title and body are required for update');
        const result = store.update(id, {
          ...base,
          title,
          body,
          expectedRevision: int(args, 'expectedRevision', { min: 1 }),
        });
        return { op, ...result };
      }

      if (title === undefined || body === undefined) throw new Error('title and body are required');
      const result = store.write({ ...base, op: 'create', title, body });
      return { op: 'create', ...result };
    },
  };

  const searchTool = {
    name: 'loci_search',
    description:
      'Find saved memory by meaning and keywords. Hybrid: CJK bigram full-text, entity match, optional vectors, fused and ranked. ' +
      'Returns `total` and a `cursor`: page with the cursor when `hasMore` is true — never assume the first page is everything. ' +
      'To list everything, set limit:50 and keep calling with the returned cursor until hasMore is false. ' +
      'Use this before asking the user to repeat a convention, and after `loci_get` to see related facts.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for. Chinese and English are both fine; short Chinese queries match substrings.' },
        scope: { type: 'string', enum: SCOPES, description: 'Restrict to one scope. Omit to search session+workspace+project(+global).' },
        kinds: { type: 'array', items: { type: 'string', enum: KINDS } },
        tags: { type: 'array', items: { type: 'string' }, description: 'Require every listed tag.' },
        status: { type: 'string', enum: ['verified', 'any'], description: 'Default verified. `any` also returns pending and disputed entries.' },
        asOf: { type: 'string', description: 'ISO time: search what was true then (historical).' },
        limit: { type: 'integer', description: 'Page size, 1..50 (default from settings).' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous page.' },
        detail: { type: 'string', enum: ['snippet', 'overview', 'full'], description: 'Body detail: snippet (default), overview, full.' },
        includeGlobal: { type: 'boolean', description: 'Include global-scope memories (default true).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const context = execContext(exec);
      const query = str(args, 'query', { required: true, maxChars: 500 });
      const scopeKind = oneOf(args, 'scope', SCOPES, undefined);
      const includeGlobal = bool(args, 'includeGlobal', config('includeGlobal'));
      const status = oneOf(args, 'status', ['verified', 'any'], 'verified');
      const asOfRaw = str(args, 'asOf', { fallback: undefined });
      const asOf = asOfRaw === undefined ? undefined : Date.parse(asOfRaw);
      if (asOfRaw !== undefined && Number.isNaN(asOf)) throw new Error('asOf must be an ISO timestamp');
      const limit = int(args, 'limit', {
        min: 1,
        max: Math.max(1, Math.min(50, config('searchLimitMax'))),
        fallback: Math.max(1, Math.min(50, config('searchLimitDefault'))),
      });
      const scopeKeys = readScopeKeys(context.scopes, { scope: scopeKind, includeGlobal });
      const result = await search(store, {
        query,
        scopeKeys,
        statuses: status === 'any' ? ['verified', 'candidate', 'disputed'] : ['verified'],
        kinds: strList(args, 'kinds', { maxItems: 5, maxChars: 20 }),
        tags: strList(args, 'tags', { maxItems: 8, maxChars: 48 }),
        asOf,
        limit,
        cursor: str(args, 'cursor', { fallback: undefined }),
        detail: oneOf(args, 'detail', ['snippet', 'overview', 'full'], 'snippet'),
        sessionId: context.sessionId,
        scopeKey: context.scopes.workspace,
        channel: store.embedding,
        now: Date.now(),
      });
      return result;
    },
  };

  const get = {
    name: 'loci_get',
    description:
      'Read one memory in full by id, with its revision history and the verbatim evidence behind it. ' +
      'Use after `loci_search`, or when the injected index names an id you need the details of. ' +
      'History shows what the fact used to be and when it was superseded — cite the current revision, not an old one.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory id, e.g. m_01J...' },
        revision: { type: 'integer', description: 'Read one historical revision instead of the current one.' },
        includeHistory: { type: 'boolean', description: 'Include every revision (default true).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderGet(value) }],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const id = str(args, 'id', { required: true, maxChars: 64 });
      const revision = int(args, 'revision', { min: 1 });
      const includeHistory = bool(args, 'includeHistory', true);
      return store.get(id, { revision, includeHistory });
    },
  };

  const forget = {
    name: 'loci_forget',
    description:
      'Soft-delete a memory you know is wrong or obsolete, or restore one deleted by mistake. ' +
      'Deletion keeps every revision in history and is recorded in the audit log; nothing is physically erased here. ' +
      'Prefer this over writing a contradictory entry when the old one is simply false.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        mode: { type: 'string', enum: ['soft', 'restore'], description: 'Default soft.' },
        reason: { type: 'string', description: 'Why it is being removed; recorded in the audit log.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderForget(value) }],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const id = str(args, 'id', { required: true, maxChars: 64 });
      const mode = oneOf(args, 'mode', ['soft', 'restore'], 'soft');
      const reason = str(args, 'reason', { fallback: undefined, maxChars: 200 });
      return store.forget(id, { mode, reason, actor: 'model' });
    },
  };

  const stats = {
    name: 'loci_stats',
    description:
      'Report the memory store: counts by kind and status, pending candidates, the injected-section size of the latest request, ' +
      'retrieval channel health, and the database location. Use it when the user asks what is remembered, or when recall looks wrong.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: SCOPES, description: 'Limit counts to one scope (default: every scope in this session’s read set).' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderStats(value) }],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const context = execContext(exec);
      const scopeKind = oneOf(args, 'scope', SCOPES, undefined);
      const scopeKeys = scopeKind === undefined
        ? readScopeKeys(context.scopes, { includeGlobal: config('includeGlobal') })
        : [context.scopes[scopeKind]];
      const result = store.stats({ scopeKeys });
      return {
        ...result,
        audit: store.auditTail(5).map((event) => ({ ts: event.ts, event: event.event, ...(event.id === undefined ? {} : { id: event.id }) })),
      };
    },
  };

  return [write, searchTool, get, forget, stats];
}

/**
 * Register every tool on the plugin context.
 * @param ctx - plugin context with `tools`.
 * @param deps - dependencies forwarded to {@link createTools}.
 */
export function registerTools(ctx, deps) {
  const disposers = [];
  for (const tool of createTools(deps)) disposers.push(ctx.tools.register(tool));
  return () => {
    for (const dispose of disposers) dispose();
  };
}

// --------------------------------------------------------------- rendering

function renderWrite(value) {
  if (value?.entry === null || value?.entry === undefined) {
    const duplicates = (value?.possibleDuplicates ?? []).map((hit) => `${hit.id} (${hit.similarity})`).join(', ');
    return [`nothing written; possible duplicates: ${duplicates || 'none'}`, ...(value?.warnings ?? [])].join('\n');
  }
  const entry = value.entry;
  const lines = [
    `saved ${entry.id}@${entry.revision} · ${entry.status} · ${entry.kind} · ${entry.scope}:${entry.scopeLabel}`,
  ];
  if (value.deduplicated === true) lines.push('an identical entry already existed; returned it unchanged');
  if (value.updated === true) lines.push(`new revision; revision ${entry.revision - 1} is closed but still readable`);
  if (entry.status === 'candidate') {
    lines.push('status: candidate — not injected and not used for answers until evidence is confirmed (loci_write op:"verify")');
  }
  if (entry.status === 'disputed') lines.push('status: disputed — quarantined because the text reads like an instruction');
  if (entry.flags?.includes('secret-redacted')) lines.push('a credential-like string was redacted before storage');
  for (const warning of value.warnings ?? []) lines.push(`warning: ${warning}`);
  for (const hit of value.possibleDuplicates ?? []) {
    lines.push(`possible duplicate: ${hit.id} · ${renderSafe(indexTitle(hit.title, 80))}`);
  }
  return lines.join('\n');
}

/**
 * Render a search result.
 *
 * The three-way contract matters more than the formatting: a caller must be able
 * to tell **found**, **nothing matched**, and **the search failed** apart without
 * guessing. Reporting an empty result as a failure teaches the model to retry
 * forever; reporting a failure as "nothing found" teaches it to invent.
 */
function renderSearch(value) {
  if (value?.error !== undefined) {
    return `search failed: ${value.error}\nNothing was returned, so do not conclude the memory is empty.`;
  }
  const lines = [
    `total=${value.total} returned=${value.returned} hasMore=${value.hasMore}${value.cursor ? ` cursor=${value.cursor}` : ''}`,
  ];
  if (value.hits.length === 0) {
    lines.push('No relevant memory found for this query.');
    return lines.join('\n');
  }
  value.hits.forEach((hit, index) => {
    lines.push(`${index + 1}. ${renderEntryLine(hit)} [${hit.channels.join(',')}]`);
    const snippet = String(hit.snippet ?? '').trim();
    if (snippet.length > 0) lines.push(`   ${renderSafe(snippet.replace(/\s+/g, ' ')).slice(0, 400)}`);
  });
  if (value.hasMore) lines.push('next page: call loci_search again with the cursor above');
  // Never let a bounded window look like a complete answer.
  if (value.partial === true) {
    lines.push(
      `note: more than ${value.returned} entries match; the ranking covers a bounded window, so narrow the query (or add tags/kinds) to see the rest reliably`,
    );
  }
  return lines.join('\n');
}

function renderGet(value) {
  const entry = value?.entry;
  if (entry === undefined) {
    return 'No memory with that id. It may have been purged, or the id was mistyped — use loci_search to find it.';
  }
  const lines = [
    `${entry.id}@${entry.revision} · ${entry.kind} · ${entry.status} · ${entry.scope}:${entry.scopeLabel}`,
    `title: ${renderSafe(entry.title)}`,
    `valid: ${formatDate(entry.validFrom)} → ${entry.validTo === null ? 'now' : formatDate(entry.validTo)}`,
  ];
  if (entry.pinned) lines.push('pinned');
  if (entry.tags.length > 0) lines.push(`tags: ${entry.tags.join(', ')}`);
  lines.push('', renderSafe(entry.body));
  const quote = entry.evidence?.quote;
  if (typeof quote === 'string' && quote.length > 0) {
    lines.push('', `evidence: “${renderSafe(quote)}”${entry.sourceSession ? ` (session ${entry.sourceSession})` : ''}`);
  }
  const history = Array.isArray(value.history) ? value.history : [];
  if (history.length > 1) {
    lines.push('', `history: ${history.length} revisions`);
    for (const revision of history) {
      lines.push(
        `- r${revision.revision} ${revision.status} ${formatDate(revision.validFrom)}→${revision.validTo === null ? 'now' : formatDate(revision.validTo)}${revision.supersededBy ? ` → ${revision.supersededBy}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

function renderForget(value) {
  if (value.mode === 'restore') return `restored ${value.id} as a candidate; verify it again before relying on it`;
  return `soft-deleted ${value.id}; revisions stay readable and the deletion is in the audit log`;
}

function renderStats(value) {
  const statuses = Object.entries(value.byStatus ?? {}).map(([key, count]) => `${key}=${count}`).join(' ') || 'none';
  const kinds = Object.entries(value.byKind ?? {}).map(([key, count]) => `${key}=${count}`).join(' ') || 'none';
  const scopes = Object.entries(value.byScope ?? {}).map(([key, count]) => `${key}=${count}`).join(' ') || 'none';
  const lines = [
    `store: ${value.memoryRoot}`,
    `schema v${value.schemaVersion} · index rev ${value.indexRev} · ${value.revisions} revisions · ${value.dbBytes} bytes`,
    `status: ${statuses}`,
    `kind: ${kinds}`,
    `scope: ${scopes}`,
    `pending candidates: ${value.pendingCandidates} · disputed: ${value.disputed}`,
    `last injection: ${value.lastInjection === null ? 'none yet' : `${value.lastInjection.bytes} bytes, ${value.lastInjection.listed} listed, ${value.lastInjection.hidden} hidden`}`,
    `retrieval: lexical+entity ${value.vector?.mode === 'http' && value.vector.healthy ? '+ vector (healthy)' : `+ vector ${value.vector?.mode ?? 'off'}${value.vector?.lastError ? ` (${value.vector.lastError})` : ''}`}`,
  ];
  if (Array.isArray(value.audit) && value.audit.length > 0) {
    lines.push(`audit tail: ${value.audit.map((event) => event.event).join(', ')}`);
  }
  return lines.join('\n');
}

export { MemoryNotFoundError, MemoryRejectedError, RevisionConflictError };
