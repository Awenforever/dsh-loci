#!/usr/bin/env node
/**
 * Optional MCP facade over the same store.
 *
 * Design constraints, in order:
 * 1. The native plugin is the first-class citizen; this process is a *reader*
 *    by default so exposing memory to another agent cannot silently rewrite it.
 * 2. It opens the same SQLite file read-only, so a Harness running beside it is
 *    never blocked and this process never migrates, writes audit lines, or
 *    repairs anything.
 * 3. Write mode (`--allow-write`) still refuses `status` escalation and purge:
 *    an external agent may propose a candidate, never certify one.
 *
 * Transport: JSON-RPC 2.0 over stdio (MCP `2024-11-05`), one JSON object per line.
 * Usage: node src/mcp/server.js [--home <path>] [--allow-write]
 */
import { createInterface } from 'node:readline';
import { loadStoreConfig, openFacadeStore } from './store-facade.js';

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? '' : value;
};
const allowWrite = argv.includes('--allow-write');
const home = flagValue('home');

const { store, paths } = openFacadeStore({ home, readOnly: !allowWrite });

const TOOLS = [
  {
    name: 'loci_search',
    description:
      'Search the user\'s long-term memory (verified facts, conventions, decisions, lessons). Hybrid lexical + entity retrieval; returns total and a cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        cursor: { type: 'string' },
        detail: { type: 'string', enum: ['snippet', 'overview', 'full'] },
        scope: { type: 'string', enum: ['session', 'workspace', 'project', 'global'] },
      },
      required: ['query'],
    },
  },
  {
    name: 'loci_get',
    description: 'Read one memory in full by id, with its revision history and evidence quote.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, revision: { type: 'integer' } },
      required: ['id'],
    },
  },
  {
    name: 'loci_stats',
    description: 'Counts, injection budget use, and retrieval channel health.',
    inputSchema: { type: 'object', properties: {} },
  },
];

if (allowWrite) {
  TOOLS.push({
    name: 'loci_write',
    description:
      'Propose a durable fact to the user\'s memory. It is stored as a candidate (never injected) until the user verifies it. Never write secrets.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        kind: { type: 'string', enum: ['semantic', 'procedural', 'rule', 'episodic'] },
        scope: { type: 'string', enum: ['workspace', 'project', 'global'] },
        tags: { type: 'array', items: { type: 'string' } },
        entities: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'body'],
    },
  });
}

/** Render a search result as text content. */
function renderSearch(result) {
  const lines = [`total=${result.total} returned=${result.returned} hasMore=${result.hasMore}${result.partial ? ' partial=true' : ''}`];
  for (const hit of result.hits) {
    lines.push(`${hit.id} · ${hit.kind} · ${hit.title}`);
    if (hit.snippet) lines.push(`  ${hit.snippet.replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  if (result.hasMore) lines.push(`next cursor: ${result.cursor}`);
  return lines.join('\n');
}

/** Call one tool. */
async function callTool(name, args) {
  switch (name) {
    case 'loci_search': {
      const query = String(args?.query ?? '').trim();
      if (query.length === 0) throw new Error('query is required');
      const { search } = await import('../host/store/search.js');
      const scopeKeys = store.allScopeKeys();
      const result = await search(store, {
        query,
        scopeKeys,
        statuses: ['verified'],
        limit: Math.max(1, Math.min(50, Number(args?.limit ?? 10))),
        cursor: typeof args?.cursor === 'string' ? args.cursor : undefined,
        detail: ['snippet', 'overview', 'full'].includes(args?.detail) ? args.detail : 'snippet',
      });
      return renderSearch(result);
    }
    case 'loci_get': {
      const id = String(args?.id ?? '');
      const entry = store.get(id, {
        revision: Number.isSafeInteger(args?.revision) ? args.revision : undefined,
        includeHistory: true,
      });
      const lines = [`${entry.entry.id}@${entry.entry.revision} · ${entry.entry.kind} · ${entry.entry.status}`, entry.entry.title, '', entry.entry.body];
      const quote = entry.entry.evidence?.quote;
      if (typeof quote === 'string' && quote.length > 0) lines.push('', `evidence: “${quote}”`);
      if (entry.history.length > 1) lines.push('', `history: ${entry.history.length} revisions`);
      return lines.join('\n');
    }
    case 'loci_stats': {
      const stats = store.stats({ scopeKeys: store.allScopeKeys() });
      return [
        `entries: ${stats.heads} · revisions: ${stats.revisions} · pending: ${stats.pendingCandidates}`,
        `store: ${stats.memoryRoot}`,
        `last injection: ${stats.lastInjection === null ? 'none' : `${stats.lastInjection.bytes} bytes`}`,
      ].join('\n');
    }
    case 'loci_write': {
      if (!allowWrite) throw new Error('this server is read-only; start it with --allow-write to propose memories');
      const scopeKeys = store.allScopeKeys();
      const scopeKey = scopeKeys[0] ?? 'workspace:mcp';
      const result = store.write({
        kind: ['semantic', 'procedural', 'rule', 'episodic'].includes(args?.kind) ? args.kind : 'semantic',
        scope: ['workspace', 'project', 'global'].includes(args?.scope) ? args.scope : 'workspace',
        scopeKey,
        scopeLabel: 'mcp',
        title: String(args?.title ?? ''),
        body: String(args?.body ?? ''),
        tags: Array.isArray(args?.tags) ? args.tags : [],
        entities: Array.isArray(args?.entities) ? args.entities : [],
        trustSource: 'import',
      });
      return `stored ${result.entry.id} as ${result.entry.status}; it is not injected until the user verifies it`;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/** Send one JSON-RPC message. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const text = line.trim();
  if (text.length === 0) return;
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const { id, method, params } = request;
  const isNotification = id === undefined || id === null;
  void (async () => {
    try {
      if (method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'loci', version: '1.0.0' },
          },
        });
        return;
      }
      if (method === 'notifications/initialized' || method === 'shutdown' || method === 'exit') {
        if (method === 'exit') process.exit(0);
        if (!isNotification) send({ jsonrpc: '2.0', id, result: null });
        return;
      }
      if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      }
      if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        return;
      }
      if (method === 'tools/call') {
        const name = String(params?.name ?? '');
        const text = await callTool(name, params?.arguments ?? {});
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
        return;
      }
      if (method === 'resources/list') {
        send({ jsonrpc: '2.0', id, result: { resources: [] } });
        return;
      }
      if (method === 'prompts/list') {
        send({ jsonrpc: '2.0', id, result: { prompts: [] } });
        return;
      }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true },
      });
    }
  })();
});

rl.on('close', () => {
  store.close();
  process.exit(0);
});

process.stderr.write(`loci mcp: ${allowWrite ? 'write' : 'read-only'} facade · ${paths.db}\n`);
