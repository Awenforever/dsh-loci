/**
 * Owner-only JSON API behind the settings page and the sidebar panel.
 *
 * Every route is an *exact* `connection.fetch` route, so the Host's browser
 * fence (same-origin, authenticated owner Peer, `/api` prefix) applies before a
 * handler runs. On top of that: JSON content type required for writes, a hard
 * body cap, and no CORS headers. The panel is a local admin surface, so its
 * list/search default to every scope; the agent's tools never do.
 * @module dsh-loci/api
 */
import { readScopeKeys, resolveScopes } from '../scope.js';
import { search } from '../store/search.js';
import { exportMarkdown, importMarkdown } from '../store/export.js';
import { renderIndexBody } from '../inject/index-section.js';

/** Refuse request bodies above this size. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Default page size for the panel. */
const PANEL_PAGE = 50;

/** JSON response helper. */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Read a JSON body with the size cap applied. */
async function readJson(request) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) {
    return { error: json({ error: 'content-type must be application/json' }, 415) };
  }
  const length = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return { error: json({ error: 'body too large' }, 413) };
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { error: json({ error: 'body too large' }, 413) };
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: json({ error: 'body must be a JSON object' }, 400) };
    }
    return { value: parsed };
  } catch {
    return { error: json({ error: 'body is not valid JSON' }, 400) };
  }
}

/** Scope keys for an administrative read. */
function adminScopeKeys(store, scope) {
  if (typeof scope === 'string' && ['session', 'workspace', 'project', 'global'].includes(scope)) {
    return store.allScopeKeys().filter((key) => key.startsWith(`${scope}:`));
  }
  return store.allScopeKeys();
}

/** The synthetic scope context the panel writes to when it creates an entry. */
function panelScopes(body) {
  return resolveScopes({ sessionId: body.sessionId ?? 'panel', cwd: body.cwd });
}

/**
 * Register every route on the Host connection service.
 * @param ctx - plugin context that owns the registrations.
 * @param deps - `store`, `paths`, `config`, `log`.
 * @returns disposer.
 */
export function registerApiRoutes(ctx, deps) {
  const connection = ctx.get('connection');
  if (connection?.fetch?.register === undefined) {
    deps.log?.info?.('loci: no connection service; panel API not mounted (tools and index still work)');
    return () => {};
  }
  const { store, paths, config, log } = deps;
  const disposers = [];
  const route = (path, methods, handler) => {
    const dispose = connection.fetch.register({
      path,
      methods,
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return await handler(request);
        } catch (error) {
          log?.warn?.(`loci: ${path} failed: ${String(error?.message ?? error)}`);
          return json({ error: String(error?.message ?? error) }, 400);
        }
      },
    });
    disposers.push(dispose);
  };

  route('/api/loci/stats', ['GET'], async () => {
    const scopeKeys = store.allScopeKeys();
    return json({
      ...store.stats({ scopeKeys }),
      injections: store.recentInjections(50),
      audit: store.auditTail(50),
    });
  });

  route('/api/loci/preview', ['GET'], async () => {
    const scopeKeys = store.allScopeKeys();
    return json(
      renderIndexBody({
        store,
        scopeKeys,
        scopeLabel: scopeKeys.length === 0 ? 'empty store' : `${scopeKeys.length} scope(s)`,
        config: (key) => config[key],
        now: Date.now(),
      }),
    );
  });

  route('/api/loci/list', ['GET'], async (request) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') ?? '';
    const scopeKeys = adminScopeKeys(store, url.searchParams.get('scope'));
    const status = url.searchParams.get('status');
    const statuses = status === 'any' || status === null
      ? ['verified', 'candidate', 'disputed']
      : status.split(',').filter(Boolean);
    const kind = url.searchParams.get('kind');
    const kinds = kind === null || kind === 'all' ? undefined : kind.split(',').filter(Boolean);
    if (query.trim().length > 0) {
      const result = await search(store, {
        query,
        scopeKeys,
        statuses,
        kinds,
        limit: Number(url.searchParams.get('limit') ?? 20),
        cursor: url.searchParams.get('cursor') ?? undefined,
        detail: 'snippet',
        channel: store.embedding,
      });
      return json(result);
    }
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const result = store.list({ scopeKeys, statuses, kinds, limit: PANEL_PAGE, offset });
    return json({ ...result, offset, limit: PANEL_PAGE, hasMore: offset + result.items.length < result.total });
  });

  route('/api/loci/item', ['GET'], async (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (id === null) return json({ error: 'id is required' }, 400);
    const includeHistory = url.searchParams.get('history') !== '0';
    return json(store.get(id, { includeHistory }));
  });

  route('/api/loci/write', ['POST'], async (request) => {
    const parsed = await readJson(request);
    if (parsed.error !== undefined) return parsed.error;
    const body = parsed.value;
    const scopes = panelScopes(body);
    const scopeKind = ['session', 'workspace', 'project', 'global'].includes(body.scope) ? body.scope : 'workspace';
    const selected = { scope: scopeKind, key: scopes[scopeKind], label: scopes.labels[scopeKind] };
    const common = {
      kind: body.kind ?? 'semantic',
      scope: selected.scope,
      scopeKey: selected.key,
      scopeLabel: selected.label,
      title: String(body.title ?? ''),
      body: String(body.body ?? ''),
      tags: Array.isArray(body.tags) ? body.tags : [],
      entities: Array.isArray(body.entities) ? body.entities : [],
      trustSource: 'user',
      evidence: body.evidence ?? {},
      validFrom: Number.isFinite(body.validFrom) ? body.validFrom : undefined,
      validTo: Number.isFinite(body.validTo) ? body.validTo : undefined,
      pinned: body.pinned === true,
      force: body.force === true,
    };
    if (typeof body.id === 'string' && body.id.length > 0) {
      return json(store.update(body.id, {
        ...common,
        expectedRevision: Number.isSafeInteger(body.expectedRevision) ? body.expectedRevision : undefined,
        status: body.status,
      }));
    }
    return json(store.write({ ...common, status: body.status ?? 'verified' }));
  });

  route('/api/loci/verify', ['POST'], async (request) => {
    const parsed = await readJson(request);
    if (parsed.error !== undefined) return parsed.error;
    const { id, status, evidence } = parsed.value;
    if (typeof id !== 'string') return json({ error: 'id is required' }, 400);
    if (status === 'pin' || status === 'unpin') return json({ entry: store.setPinned(id, status === 'pin', 'panel') });
    return json({ entry: store.setTrust(id, status === 'disputed' ? 'disputed' : 'verified', { actor: 'panel', evidence }) });
  });

  route('/api/loci/delete', ['POST'], async (request) => {
    const parsed = await readJson(request);
    if (parsed.error !== undefined) return parsed.error;
    const { id, mode, reason, confirm } = parsed.value;
    if (typeof id !== 'string') return json({ error: 'id is required' }, 400);
    return json(store.forget(id, { mode: mode ?? 'soft', reason, confirm, actor: 'panel' }));
  });

  route('/api/loci/export', ['POST'], async (request) => {
    const parsed = await readJson(request);
    if (parsed.error !== undefined) return parsed.error;
    if (parsed.value.action === 'import') {
      const result = importMarkdown(store, paths, {
        dir: typeof parsed.value.dir === 'string' ? parsed.value.dir : undefined,
        scopeKey: `workspace:${(parsed.value.scopeLabel ?? 'imported').replace(/[^A-Za-z0-9._-]+/g, '_')}`,
        scopeLabel: String(parsed.value.scopeLabel ?? 'imported'),
      });
      return json(result);
    }
    return json(exportMarkdown(store, paths));
  });

  route('/api/loci/audit', ['GET'], async (request) => {
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 200)));
    return json({ events: store.auditTail(limit) });
  });

  route('/api/loci/config', ['GET'], async () => json({ config: { ...config } }));

  return () => {
    for (const dispose of disposers) dispose();
  };
}

export { json, readJson, adminScopeKeys, readScopeKeys };
