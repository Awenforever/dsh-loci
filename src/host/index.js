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
import { writeMeta } from './store/schema.js';
import { Capture } from './capture/capture.js';
import { createIndexSection, renderAssistBlock } from './inject/index-section.js';
import { createCurationTrigger } from './record/trigger.js';import { CURATOR_SYSTEM } from './record/curator.js';
import { runCuratorProbe } from './record/probe.js';
import { createCompleter } from './record/model-route.js';
import { registerTools } from './tools/tools.js';
import { registerApiRoutes } from './api/routes.js';
import { UpdateChecker } from './update.js';
import { Extractor } from './extract/extractor.js';
import { detectHostVersion, hostLineOf } from './host-version.js';
import { registerCommands } from './commands.js';
import { runDoctor } from './doctor.js';
import { rescueMiss } from './recall/rescue.js';

/** Version stamped into the database and diagnostics. */
export const VERSION = '4.6.0';

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
 * Extract the text of one message's content blocks.
 *
 * Same shape as {@link firstUserText} but for a single content array, which is what a
 * `user/message` event carries.
 *
 * @param content - message content, string or blocks.
 * @returns the joined text, or `''`.
 */
function firstTextOf(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
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
  // The model route, shared between the injection scope that builds it and the `agent/pre-step`
  // handler that uses it for the rewrite rescue. A mutable holder rather than a closure variable
  // because the two live in different Cordis scopes.
  const modelRoute = { complete: undefined };
  /**
   * The most recent user message text per session, tracked here rather than through `capture`.
   *
   * `capture` deliberately ignores messages whose `source.kind` is not `user`, because durable
   * extraction must not treat an injected prompt as something the person said. Retrieval has the
   * opposite requirement: a turn opened by a harness-injected message still has a question worth
   * searching for, and reading nothing there made the rewrite rescue report "query too short" on
   * every goal round while every other part of the chain worked.
   */
  const lastUserText = new Map();
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
      // A conversation that manages memory must never be shown memory. This is the hard
      // constraint, and it is checked first and by its own stored fact: before schema v6 the
      // property held only because subagents happen to have `delegationDepth > 0`, which is a
      // fact about delegation rather than about being a manager, and would have broken silently
      // the first time a manager ran as a top-level session.
      if (store.injectionExemptReason(session.id) !== undefined) return undefined;
      if ((session.header?.delegationDepth ?? 0) > 0) return undefined;
      const scopes = resolveScopes({ sessionId: session.id, cwd: session.header?.cwd });
      return {
        sessionId: session.id,
        scopeKey: scopes.workspace,
        // Recorded so a surface outside the session (the panel's memory-boundary selector)
        // can resolve the same scopes: a scope key is a hash and cannot be reversed.
        cwd: scopes.cwd,
        scopeKeys: readScopeKeys(scopes, { includeGlobal: read('includeGlobal') }),
        scopeLabel: `workspace:${scopes.labels.workspace}`,
        // What the slice retrieves against. `PromptSection.text` receives only `{scope,
        // signal}`, so the question has to be handed in from here. The dedicated tracker wins over
        // the capture buffer because capture filters by source kind and this surface must not.
        lastUserText: lastUserText.get(session.id) ?? capture?.lastUserText?.(session.id),
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
  //
  // `agentDefaultModel` is injected with `llm` because the plugin has no agent of its own: reading
  // `child.agent` threw "cannot get property 'agent' without inject", which left provider and model
  // undefined and made every call return an empty string. The default selection is the only correct
  // answer here — this is a background pass, not a conversation, so there is no session to inherit.
  disposers.push(
    ctx.inject(['llm', 'agentDefaultModel'], (child) =>
      child.effect(() => {
        // Read the model selection defensively: a getter on a traced context can throw, and a
        // throw here is what previously stopped the whole route at the line below.
        const note = (step, detail) => {
          try {
            writeMeta(store.db, `llm_${step}`.replace(/[^a-z0-9_]/gi, '_').slice(0, 60), String(detail));
          } catch {
            /* diagnostic only */
          }
        };
        let provider;
        let model;
        try {
          const selection = child.agentDefaultModel?.currentSelection?.();
          note('route_seen', String(Date.now()));
          provider = selection?.provider ?? undefined;
          model = selection?.model ?? undefined;
          note('selection', `${provider ?? '(none)'} / ${model ?? '(none)'}`);
        } catch (error) {
          note('selection_error', String(error?.message ?? error));
        }
        const route = createCompleter({ llm: child.llm, provider, model, record: note });
        const complete = route.complete;
        note('complete', route.reason);
        // Published for handlers registered outside this injection scope — the rewrite rescue
        // lives on `agent/pre-step`, which is a sibling of this callback, not a child of it.
        modelRoute.complete = complete;
        if (complete === undefined) return () => {};
        extractor.complete = complete;
        // Curation reuses the same route: one model transport, two consumers. Registering the
        // dispose listener here — rather than only when `curatorMode` is on at load — means
        // turning the mode on later takes effect without a reload; the trigger re-reads the
        // config on every call and returns early while it is off.
        const curateOnDispose = createCurationTrigger({
          store,
          config: read,
          capture,
          callModel: async ({ prompt }) => complete({ system: CURATOR_SYSTEM, prompt }),
          resolveScopes,
          log,
        });
        const offDisposed = child.on('agent/disposed', async ({ agent } = {}) => {
          await curateOnDispose(agent);
        });
        // The decision layer's only unmeasured property was whether the model actually judges
        // well. This runs one real pass against a fixed transcript, once per version, and stores
        // the outcome so it can be read instead of assumed. It writes no memory.
        if (read('curatorMode') !== 'off') {
          void runCuratorProbe({ store, complete, pluginVersion: VERSION, log })
            .then((outcome) => {
              // A skipped probe must record why. Silence is what made 4.4.0's failure look like
              // "nothing to do" instead of "the model was never reachable".
              if (outcome?.ran === false) {
                try {
                  writeMeta(
                    store.db,
                    'curator_probe_skipped',
                    JSON.stringify({ reason: outcome.reason ?? 'unknown', at: Date.now(), version: VERSION }),
                  );
                } catch {
                  /* diagnostic only */
                }
              }
            })
            .catch((error) => {
              try {
                writeMeta(store.db, 'curator_probe_error', String(error?.message ?? error));
              } catch {
                /* diagnostic only */
              }
            });
        }
        return () => {
          offDisposed?.();
          extractor.complete = undefined;
          modelRoute.complete = undefined;
        };
      }, 'loci: extractor model route'),
    ),
  );

  // Track the newest user-message text per session, independent of `capture`'s source filtering.
  // Registration order matters only in that this must exist before the first assembly.
  disposers.push(
    ctx.effect(() =>
      ctx.on('session/event', (session, event) => {
        if (event?.type !== 'user/message') return;
        const text = firstTextOf(event.data?.content);
        if (text.length === 0) return;
        if ((session?.header?.delegationDepth ?? 0) > 0) return;
        if (lastUserText.size >= 256) lastUserText.clear();
        lastUserText.set(session.id, text);
      }),
    ),
  );

  // The rewrite rescue: when the synchronous slice found nothing, ask the model for other words.
  //
  // This runs on every turn, not once per session, because a miss can happen on any question. It
  // costs a model call only when the slice missed, and only once per turn — the guard lives in the
  // rescue module and keys off the note the section left behind.
  //
  // The ordering is what makes it possible at all: `systemPrompt.assemble` runs *before* this
  // waterfall, so the section can leave a note and this handler, which can await, acts on it in
  // time for the same turn.
  disposers.push(
    ctx.effect(
      () =>
        ctx.on('agent/pre-step', async (payload, next) => {
          const decision = await next();
          try {
            if (read('recallRewrite') !== 'on-miss') return decision;
            if (decision?.kind !== 'enter' || payload?.step !== 1) return decision;
            const session = payload?.agent?.session;
            if (session === undefined || (session.header?.delegationDepth ?? 0) > 0) return decision;
            if (store.injectionExemptReason(session.id) !== undefined) return decision;
            if (modelRoute.complete === undefined) return decision;
            const scopes = resolveScopes({ sessionId: session.id, cwd: session.header?.cwd });
            const rescue = await rescueMiss({
              store,
              sessionId: session.id,
              scopeKeys: readScopeKeys(scopes, { includeGlobal: read('includeGlobal') }),
              scopeKey: scopes.workspace,
              complete: modelRoute.complete,
              now: Date.now(),
              log,
            });
            if (rescue.rescued !== true || rescue.text.length === 0) return decision;
            // Appended as its own message rather than merged into the section: the section is
            // already rendered, and the rescue is by nature a correction to it.
            return {
              ...decision,
              messages: [
                ...decision.messages,
                {
                  role: 'user',
                  source: { kind: 'user' },
                  content: [{ type: 'text', text: rescue.text }],
                },
              ],
            };
          } catch (error) {
            log?.debug?.(`loci: rewrite rescue failed: ${String(error?.message ?? error)}`);
            return decision;
          }
        }),
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
            // The assist is a second injection surface. An exemption that only covered the
            // section would leave the manager shaped by exactly the memory it is curating, so
            // both surfaces consult the same stored fact.
            if (store.injectionExemptReason(session.id) !== undefined) return decision;
            if (assisted.has(session.id)) return decision;
            const query = firstUserText(decision.messages);
            if (query.length < 2) return decision;
            const scopes = resolveScopes({ sessionId: session.id, cwd: session.header?.cwd });
            const assistScopeKeys = readScopeKeys(scopes, { includeGlobal: read('includeGlobal') });
            // One instant, used for the evaluation *and* the record. Reading the clock
            // twice would make the recorded time disagree with the time the ranking saw,
            // and R3 asks that a replay of (snapshot, query, scopes, now) reproduce the
            // same ids — which only holds if both halves use the same value.
            const evaluatedAt = Date.now();
            const snapshotRev = store.indexRev?.() ?? null;
            const assist = await renderAssistBlock({
              store,
              scopeKeys: assistScopeKeys,
              query,
              maxBytes: read('recallAssistBytes'),
              sessionId: session.id,
              scopeKey: scopes.workspace,
              now: evaluatedAt,
            });
            assisted.add(session.id);
            if (assisted.size > ASSIST_MEMORY) assisted.clear();
            if (assist.text.length === 0) return decision;
            // Record it. This path injected entries into the conversation and wrote
            // nothing anywhere, so the panel could not answer "why did this appear in
            // that session" — the project's own R4 rule, broken by its own feature.
            try {
              store.recordInjection({
                sessionId: session.id,
                scopeKey: scopes.workspace,
                cwd: scopes.cwd,
                bytes: assist.bytes,
                listed: assist.ids.length,
                hidden: 0,
                ids: assist.ids,
                source: 'assist',
                ts: evaluatedAt,
                indexRev: snapshotRev,
              });
            } catch (error) {
              // Recording must never break the turn it is recording.
              log.warn(`loci: could not record the recall injection: ${String(error?.message ?? error)}`);
            }
            return {
              ...decision,
              messages: [
                ...decision.messages,
                {
                  id: `loci-recall-${randomUUID()}`,
                  role: 'user',
                  content: [{ type: 'text', text: assist.text }],
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
