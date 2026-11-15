/**
 * Host wiring for Loci.
 *
 * One `apply` owns the store, the injected index, five tools, deterministic
 * capture, the owner-only panel API, `/loci`, and a background maintenance
 * timer. Everything is an effect of this context, so disabling the plugin
 * removes all of it and leaves the database intact.
 * @module dsh-loci/host
 */
import { randomUUID } from 'node:crypto';
import { cfg, effectiveConfig } from './config.js';
import { ensureMemoryRoot, layout, resolveDshHome, resolveMemoryRoot } from './paths.js';
import { readScopeKeys, resolveScopes } from './scope.js';
import { Store } from './store/store.js';
import { Capture } from './capture/capture.js';
import { createIndexSection, renderAssistBlock } from './inject/index-section.js';
import { registerTools } from './tools/tools.js';
import { registerApiRoutes } from './api/routes.js';
import { UpdateChecker } from './update.js';
import { Extractor, completeViaHost } from './extract/extractor.js';
import { detectHostVersion, hostLineOf } from './host-version.js';
import { registerCommands } from './commands.js';
import { runDoctor } from './doctor.js';

/** Version stamped into the database and diagnostics. */
export const VERSION = '2.5.0';

/** Optional collaborators; without them the plugin still serves tools. */
export const inject = ['systemPrompt', 'tools'];

/** Cap on the per-activation assist bookkeeping. */
const ASSIST_MEMORY = 500;

/**
 * Build a logger that never throws and never depends on an optional service.
 * @param ctx - plugin context.
 * @returns `{info, warn, error, debug}`.
 */
function makeLogger(ctx) {
  const logger = ctx.logger ?? (typeof ctx.get === 'function' ? ctx.get('logger') : undefined);
  const write = (level, message) => {
    try {
      if (typeof logger?.[level] === 'function') logger[level](message);
      else if (level === 'error' || level === 'warn') console.error(message);
    } catch {
      /* logging must never break a turn */
    }
  };
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    debug: (message) => write('debug', message),
  };
}

/**
 * Extract the first user-authored text from a pre-step message list.
 * @param messages - claimed inbox messages.
 * @returns the joined text, or `''`.
 */
function firstUserText(messages) {
  for (const message of messages ?? []) {
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text.length > 0) return text;
  }
  return '';
}

/**
 * Activate the plugin.
 * @param ctx - Cordis plugin context.
 * @param rawConfig - the Loader row config (volatile fields are live refs).
 */
export function apply(ctx, rawConfig = {}) {
  const log = makeLogger(ctx);
  const config = effectiveConfig(rawConfig);
  const read = (key) => cfg(rawConfig, key);

  // Capability self-check: fail loudly at activation instead of registering
  // tools that would throw on first call in a changed Host.
  if (typeof ctx.systemPrompt?.section !== 'function' || typeof ctx.tools?.register !== 'function') {
    log.error('loci: this Host does not expose systemPrompt.section + tools.register; refusing to activate');
    throw new Error('loci: incompatible Host (missing systemPrompt.section or tools.register)');
  }

  const home = resolveDshHome(config.home);
  const memoryRoot = resolveMemoryRoot(home);
  ensureMemoryRoot(memoryRoot);
  const paths = layout(memoryRoot);
  log.info(`loci: using ${memoryRoot}`);

  let capture;
  // Record which Harness this store is actually running on. `engines.dsh` is a
  // range; this field is the only one that says which point release met the file,
  // so a support report can be checked instead of guessed at.
  const detectedHost = detectHostVersion();
  const store = new Store({
    memoryRoot,
    paths,
    config,
    log,
    pluginVersion: VERSION,
    hostVersion: detectedHost?.version,
    live: read,
    quoteVerifier: (quote, options) => capture?.verifyQuote(quote, options) ?? false,
  });
  if (detectedHost !== undefined) {
    try {
      store.db
        .prepare("INSERT INTO meta (key, value) VALUES ('host_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(detectedHost.version);
    } catch {
      /* recording is best effort */
    }
    log?.info?.(`loci: host ${detectedHost.version} (${hostLineOf(detectedHost.version)})`);
  }

  const updates = new UpdateChecker({
    currentVersion: VERSION,
    registry: read('updateRegistry'),
    log,
  });

  const extractor = new Extractor({ store, config: read, log });
  capture = new Capture({
    store,
    config: read,
    log,
    resolveScopes,
    extractor,
  });

  const indexSection = createIndexSection({
    store,
    config: read,
    log,
    resolveContext: (assembly) => {
      const session = assembly?.agent?.session;
      if (session === undefined) return undefined;
      if ((session.header?.delegationDepth ?? 0) > 0) return undefined;
      const scopes = resolveScopes({ sessionId: session.id, cwd: session.header?.cwd });
      return {
        sessionId: session.id,
        scopeKey: scopes.workspace,
        scopeKeys: readScopeKeys(scopes, { includeGlobal: read('includeGlobal') }),
        scopeLabel: `workspace:${scopes.labels.workspace}`,
      };
    },
  });

  const disposers = [];
  // Disposal runs in reverse registration order, so this must be registered
  // FIRST to run LAST: the capture layer flushes session summaries through the
  // store on unload, and closing the database before that turned every summary
  // into a logged-and-lost error. The integrity check moved to `doctor()` for
  // the same reason — a synchronous check over every row on the agent's event
  // loop is not something a shutdown should do.
  disposers.push(
    ctx.effect(
      () => () => {
        try {
          store.close();
        } catch (error) {
          log.warn(`loci: store close failed: ${String(error?.message ?? error)}`);
        }
      },
      'loci: store close',
    ),
  );

  disposers.push(ctx.effect(() => ctx.systemPrompt.section(indexSection), 'loci: index section'));
  disposers.push(ctx.effect(() => registerTools(ctx, { store, config: read, log, capture }), 'loci: tools'));
  disposers.push(ctx.effect(() => capture.attach(ctx), 'loci: capture'));
  // Optional collaborators come and go with the composition: acquire them
  // through `ctx.inject` so the panel API and `/loci` mount whenever the
  // service appears, instead of being skipped forever because it was not yet
  // there at activation time (measured: the Web profile mounts `connection`
  // after a profile-installed bundle activates).
  disposers.push(
    ctx.inject(['connection'], (child) =>
      child.effect(() => registerApiRoutes(child, { store, paths, config, log, updates, version: VERSION }), 'loci: panel api'),
    ),
  );
  disposers.push(
    ctx.inject(['commands'], (child) =>
      child.effect(() => registerCommands(child, { store, paths, config, log }), 'loci: commands'),
    ),
  );
  // The extractor needs a model route. `llm` is provided by whichever provider
  // bundle the profile installed; when it is absent the feature simply stays
  // off (and reports `no-model` if someone switches it on).
  disposers.push(
    ctx.inject(['llm'], (child) =>
      child.effect(() => {
        const complete = completeViaHost(child.llm, {
          provider: child.agent?.config?.provider ?? undefined,
          model: child.agent?.config?.model ?? undefined,
        });
        if (complete === undefined) return () => {};
        extractor.complete = complete;
        return () => {
          extractor.complete = undefined;
        };
      }, 'loci: extractor model route'),
    ),
  );

  // Optional, bounded, once-per-session recall assist.
  const assisted = new Set();
  disposers.push(
    ctx.effect(
      () =>
        ctx.on('agent/pre-step', async (payload, next) => {
          const decision = await next();
          try {
            if (read('recallAssist') !== 'session-start') return decision;
            if (decision?.kind !== 'enter' || payload?.step !== 1) return decision;
            const session = payload?.agent?.session;
            if (session === undefined || (session.header?.delegationDepth ?? 0) > 0) return decision;
            if (assisted.has(session.id)) return decision;
            const query = firstUserText(decision.messages);
            if (query.length < 2) return decision;
            const scopes = resolveScopes({ sessionId: session.id, cwd: session.header?.cwd });
            const text = await renderAssistBlock({
              store,
              scopeKeys: readScopeKeys(scopes, { includeGlobal: read('includeGlobal') }),
              query,
              maxBytes: read('recallAssistBytes'),
            });
            assisted.add(session.id);
            if (assisted.size > ASSIST_MEMORY) assisted.clear();
            if (text.length === 0) return decision;
            return {
              ...decision,
              messages: [
                ...decision.messages,
                {
                  id: `loci-recall-${randomUUID()}`,
                  role: 'user',
                  content: [{ type: 'text', text }],
                  source: { kind: 'plugin:loci', form: 'block', summary: 'memory recall' },
                },
              ],
            };
          } catch (error) {
            log.warn(`loci: recall assist failed: ${String(error?.message ?? error)}`);
            return decision;
          }
        }),
      'loci: recall assist',
    ),
  );

  // Background maintenance: TTLs, index repair, query-planner statistics, and
  // (when enabled) embedding backfill. Never on the request path.
  if (read('maintenanceMode') === 'sweep') {
    const intervalMs = Math.max(30 * 60 * 1000, read('maintenanceIntervalHours') * 3600 * 1000);
    const run = async () => {
      try {
        store.maintenance();
        await store.backfillEmbeddings();
      } catch (error) {
        log.warn(`loci: maintenance failed: ${String(error?.message ?? error)}`);
      }
    };
    const first = setTimeout(run, Math.min(60_000, intervalMs));
    first.unref?.();
    const timer = setInterval(run, intervalMs);
    timer.unref?.();
    disposers.push(
      ctx.effect(
        () => () => {
          clearTimeout(first);
          clearInterval(timer);
        },
        'loci: maintenance timer',
      ),
    );
  }


  return {
    store,
    capture,
    paths,
    doctor: () => runDoctor({ store, paths, config }),
    dispose: () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose?.();
        } catch {
          /* one failing disposer must not block the rest */
        }
      }
    },
  };
}
