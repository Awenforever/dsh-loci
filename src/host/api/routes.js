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
import { buildActivity, buildKnowledge } from '../store/activity.js';
import { importPeer } from '../store/importers.js';

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
 * @param deps - `store`, `paths`, `config`, `log`, `updates`.
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
      pluginVersion: deps.version ?? '0.0.0',
      injections: store.recentInjections(50),
      audit: store.auditTail(50),
      // Which entries spend prompt bytes and are never opened. Aggregate request
      // stats cannot answer this, which is why schema v2 added per-entry counters.
      usage: store.usageReport({ scopeKeys, limit: 50 }),
    });
  });

  // What one chat actually sees is a *subset* of every stored scope, so the
  // preview must say which subset it rendered. `?cwd=` / `?session=` let the
  // panel ask "what does this conversation get" instead of "what exists".
  route('/api/loci/preview', ['GET'], async (request) => {
    const url = new URL(request.url);
    const cwd = url.searchParams.get('cwd') ?? undefined;
    const sessionId = url.searchParams.get('session') ?? undefined;
    const scoped = cwd !== undefined || sessionId !== undefined;
    const resolved = scoped ? resolveScopes({ cwd, sessionId }) : undefined;
    // `resolveScopes` returns `{session, workspace, project, global, labels, cwd,
    // projectRoot}` — there is no `readKeys` and no `label`, so this route threw
    // "Cannot read properties of undefined (reading 'length')" whenever a caller supplied
    // `?cwd=`. The panel never does, which is why it survived: a latent 400 on the one
    // endpoint that answers "what does this conversation get".
    const scopeKeys = scoped ? readScopeKeys(resolved, { includeGlobal: config.includeGlobal !== false }) : store.allScopeKeys();
    const scopeLabel = scoped
      ? [resolved.labels.workspace, resolved.labels.project].filter((value, index, all) => all.indexOf(value) === index).join(' / ')
      : `all ${scopeKeys.length} stored scope(s)`;
    return json({
      ...renderIndexBody({
        store,
        scopeKeys,
        scopeLabel,
        // `config` here is the effective-config *object* (index.js), so the
        // renderer gets a reader over it.
        config: (key) => config[key],
        now: Date.now(),
      }),
      scopeKeys,
      scopeLabel,
    });
  });

  // The sidebar mirror reads this: what changed, newest first, plus the two
  // counters the compact card shows. It carries ids and titles, never bodies.
  route('/api/loci/activity', ['GET'], async (request) => {
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 40)));
    const since = Number(url.searchParams.get('since') ?? '');
    return json(buildActivity(store, { limit, since: Number.isFinite(since) ? since : undefined }));
  });

  // What the sidebar card shows: the few things currently understood, as notes.
  // Scoped to the conversation's read set when the caller says which one, so the
  // card answers "what does *this* project's agent know", not "what exists".
  route('/api/loci/knowledge', ['GET'], async (request) => {
    const url = new URL(request.url);
    const cwd = url.searchParams.get('cwd') ?? undefined;
    const sessionId = url.searchParams.get('session') ?? undefined;
    const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit') ?? 4)));
    const scopeKeys =
      cwd === undefined && sessionId === undefined
        ? store.allScopeKeys()
        : readScopeKeys(resolveScopes({ cwd, sessionId }), { includeGlobal: config.includeGlobal !== false });
    return json(buildKnowledge(store, { limit, scopeKeys }));
  });

  // Version badge + update hint. The default answer is **cache only**: opening
  // the panel never contacts the registry, because the privacy page says the
  // plugin makes no network call unless the user configures one. `?refresh=1`
  // (the explicit press) is the only path that fetches.
  route('/api/loci/update', ['GET'], async (request) => {
    const url = new URL(request.url);
    const refresh = url.searchParams.get('refresh') === '1';
    if (deps.updates === undefined || config.updateCheck === false) return json(installedOnly(deps.version));
    if (!refresh) return json(deps.updates.cachedOrInstalled());
    return json(await deps.updates.check({ force: true }));
  });

  route('/api/loci/version', ['GET'], async () => json({ version: deps.version ?? '0.0.0' }));

  route('/api/loci/list', ['GET'], async (request) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') ?? '';
    const scopeKeys = adminScopeKeys(store, url.searchParams.get('scope'));
    const status = url.searchParams.get('status');
    const statuses = status === 'any' || status === null
      ? ['verified', 'candidate', 'disputed']
      : status.split(',').filter(Boolean);
    // Accept both spellings. The panel sent `kinds=` while this read `kind=`, so the
    // review tab's "only injectable kinds" filter was a no-op: every session summary
    // showed up in a queue that was designed to exclude them. A silently ignored query
    // parameter is the kind of bug that only shows up as "the list is full of noise".
    const kindParam = url.searchParams.get('kinds') ?? url.searchParams.get('kind');
    const kinds = kindParam === null || kindParam === 'all' ? undefined : kindParam.split(',').map((entry) => entry.trim()).filter(Boolean);
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
    // No `status` passthrough, on purpose.
    //
    // The store derives trust from `trustSource` and the content, and passing a
    // caller-supplied status here did two bad things: it let any same-origin script
    // assert a status directly, and `?? 'verified'` skipped the instruction-like
    // quarantine, so a panel write of instruction-shaped text landed as verified
    // instead of disputed. `trustSource: 'user'` above already means "a person
    // asserted this", which is what made the entry verified in the first place.
    if (typeof body.id === 'string' && body.id.length > 0) {
      return json(store.update(body.id, {
        ...common,
        expectedRevision: Number.isSafeInteger(body.expectedRevision) ? body.expectedRevision : undefined,
      }));
    }
    return json(store.write(common));
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

  // "Forget everything" is a privacy operation, not a bulk edit: the body must
  // echo the confirmation phrase, and hard deletion still needs allowHardDelete.
  // Fold near-duplicates into one entry. The sources are superseded, never
  // deleted, so the decision stays reviewable.
  route('/api/loci/merge', ['POST'], async (request) => {
    const parsed = await readJson(request);
    if (parsed.error !== undefined) return parsed.error;
    const { targetId, sourceIds, title, body } = parsed.value;
    if (typeof targetId !== 'string') return json({ error: 'targetId is required' }, 400);
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) return json({ error: 'sourceIds is required' }, 400);
    try {
      const result = store.merge({
        targetId,
        sourceIds: sourceIds.filter((value) => typeof value === 'string'),
        title: typeof title === 'string' ? title : undefined,
        body: typeof body === 'string' ? body : undefined,
        actor: 'panel',
        reason: 'merged in panel',
      });
      return json({ entry: result.entry, merged: result.merged, revision: result.revision });
    } catch (error) {
      return json({ error: String(error?.message ?? error) }, 400);
    }
  });

  route('/api/loci/forget-all', ['POST'], async (request) => {
    const parsed = await readJson(request);
    if (parsed.error !== undefined) return parsed.error;
    const { confirm, mode, scopeKey, reason } = parsed.value;
    try {
      return json(
        store.forgetAll({
          confirm,
          mode: mode === 'purge' ? 'purge' : 'soft',
          scopeKey: typeof scopeKey === 'string' ? scopeKey : undefined,
          reason: typeof reason === 'string' ? reason : 'forget all',
          actor: 'panel',
        }),
      );
    } catch (error) {
      return json({ error: String(error?.message ?? error) }, 400);
    }
  });
  // Import from another memory plugin's on-disk format. Everything lands as a
  // candidate: another plugin's trust level is not evidence for this store.
  route('/api/loci/import-peer', ['POST'], async (request) => {
    const parsed = await readJson(request);
    if (parsed.error !== undefined) return parsed.error;
    const { from, dir, dryRun } = parsed.value;
    try {
      const result = importPeer(store, { from, dir, dryRun: dryRun === true });
      return json(result);
    } catch (error) {
      return json({ error: String(error?.message ?? error) }, 400);
    }
  });

  route('/api/loci/export', ['POST'], async (request) => {    const parsed = await readJson(request);
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

  // The settings page needs the *effective* values, including defaults, not the
  // raw row from the profile (which usually has none of these keys).
  route('/api/loci/config', ['GET'], async () => json({ config: { ...config } }));

  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** The answer when no checker is wired: the installed version, nothing else. */
function installedOnly(version) {
  return {
    version: version ?? '0.0.0',
    latestVersion: null,
    updateAvailable: false,
    checkedAt: null,
    status: 'idle',
    // The card shows a "check" button; without this flag a disabled check looks
    // broken ("nothing happens") instead of switched off.
    checkEnabled: false,
  };
}

export { json, readJson, adminScopeKeys, readScopeKeys };
