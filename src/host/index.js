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
import { composeSliceMessage } from './recall/compose.js';

/** Version stamped into the database and diagnostics. */
export const VERSION = '5.0.4';

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
 * Append a recall block to the messages this step is about to send.
 *
 * Added rather than merged, because the system prompt section is already rendered by the time the
 * waterfall runs — and because a memory that arrives as conversation content is auditable in the
 * transcript, which a silently altered system prompt is not.
 *
 * @param decision - the waterfall's decision object.
 * @param text - the recall block.
 * @returns a new decision with one more message.
 */
function withRecallMessage(decision, text) {
  return {
    ...decision,
    messages: [
      ...decision.messages,
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    ],
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
  /**
   * A short transcript per session, kept here for the same reason `lastUserText` is.
   *
   * `capture` filters `user/message` by `source.kind === 'user'`, which is right for durable
   * extraction and wrong for anything that needs the conversation: curation kept reporting
   * "nothing to read" while the session demonstrably had a transcript. This buffer keeps what the
   * events actually carry, bounded, and the capture buffer stays exactly as it was.
   */
  const transcripts = new Map();
  const TRANSCRIPT_KEEP = 40;
  /** What the tracker has seen, so a silent no-op can be told from a wrong shape. */
  const trackerSeen = { messages: 0, shapes: new Set(), sources: new Set() };
  /**
   * The curation trigger and the route it needs, published from the injection scope.
   *
   * `agent/disposed` is listened for on the main context, next to capture's listener, because that
   * is where the event demonstrably arrives — a listener on the injected child of `llm` did not
   * receive it for ordinary conversations, so curation silently never ran.
   */
  const curation = { trigger: undefined };
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
          transcriptOf: (sessionId) => transcripts.get(sessionId),
        });
        // Published for the outer handler, which owns the listener: a listener registered on an
        // injected child scope did not receive `agent/disposed` for ordinary conversations, so
        // curation never ran even though every other part of the route worked. The main context is
        // where capture's listener lives and where the same event demonstrably arrives.
        curation.trigger = curateOnDispose;
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
          curation.trigger = undefined;
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
        // Count what arrives, not just what is kept: "the listener never fired" and "it fired and
        // the content had no text" look identical from the outside, and only one of them is a bug
        // in this file. The counter is the difference.
        try {
          if (event?.type === 'user/message') {
            trackerSeen.messages += 1;
            const shape = Array.isArray(event.data?.content) ? 'array' : typeof event.data?.content;
            trackerSeen.shapes.add(shape);
            if (event.data?.source?.kind !== undefined) trackerSeen.sources.add(String(event.data.source.kind));
            writeMeta(store.db, 'user_tracker', JSON.stringify({
              messages: trackerSeen.messages,
              shapes: [...trackerSeen.shapes],
              sources: [...trackerSeen.sources],
              tracked: lastUserText.size,
            }));
          }
        } catch {
          /* diagnostic only */
        }
        if (event?.type !== 'user/message') return;
        const text = firstTextOf(event.data?.content);
        if (text.length === 0) return;
        if ((session?.header?.delegationDepth ?? 0) > 0) return;
        if (lastUserText.size >= 256) lastUserText.clear();
        lastUserText.set(session.id, text);
        const transcript = transcripts.get(session.id) ?? [];
        transcript.push({ role: 'user', text });
        if (transcript.length > TRANSCRIPT_KEEP) transcript.shift();
        if (transcripts.size >= 256) transcripts.clear();
        transcripts.set(session.id, transcript);
      }),
    ),
  );
  disposers.push(
    ctx.effect(() =>
      ctx.on('session/event', (session, event) => {
        if (event?.type !== 'assistant/message') return;
        if ((session?.header?.delegationDepth ?? 0) > 0) return;
        const text = firstTextOf(event.data?.message?.content) || firstTextOf(event.data?.content);
        if (text.length === 0) return;
        const transcript = transcripts.get(session.id) ?? [];
        transcript.push({ role: 'assistant', text });
        if (transcript.length > TRANSCRIPT_KEEP) transcript.shift();
        if (transcripts.size >= 256) transcripts.clear();
        transcripts.set(session.id, transcript);
      }),
    ),
  );

  // Curation runs when a conversation ends, triggered by the events that are *proven* to arrive.
  //
  // `agent/disposed` was the obvious signal and it never fired for ordinary conversations — not on
  // the injected `llm` child, and not on the main context either, while `agent/pre-step` and
  // `session/event` both fire there without difficulty. Rather than keep guessing at the scoping
  // rule, curation now listens on `turn/end`, which the capture layer demonstrably receives, and
  // keeps `agent/disposed` as a second chance. A once-per-session guard makes the two idempotent.
  //
  // The outcome is recorded in the audit either way: "did not run" and "ran and kept nothing" are
  // different results, and this project has spent six releases confusing the two.
  const curated = new Set();
  /** Attempts per session, so a conversation that never has enough content does not retry forever. */
  const curateAttempts = new Map();
  /**
   * How many events of each type this listener has actually seen.
   *
   * Not decoration: three triggers were wired for curation and none ran. The histogram settled it in
   * one row — `turn/end` is appended to the session but never dispatched through `session/event`,
   * while `step/end`, `user/message` and `assistant/message` all are. That is the check I should have
   * written before the first of the three attempts.
   */
  const seenEvents = new Map();
  const noteSeen = (type) => {
    seenEvents.set(type, (seenEvents.get(type) ?? 0) + 1);
    try {
      writeMeta(store.db, 'session_event_seen', JSON.stringify(Object.fromEntries(seenEvents)));
    } catch {
      /* diagnostic only */
    }
  };
  const runCuration = async (sessionId, session, trigger) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (curated.has(sessionId)) return;
    const attempts = curateAttempts.get(sessionId) ?? 0;
    if (attempts >= 3) return;
    curateAttempts.set(sessionId, attempts + 1);
    if (curateAttempts.size >= 256) curateAttempts.clear();
    // Recorded before the work, not after: an outcome recorded only on success cannot distinguish
    // "never called", "threw", and "returned nothing" — the three cases that have each cost a release.
    try {
      store.audit.append('curate-start', {
        sessionId,
        trigger,
        hasRoute: curation.trigger !== undefined,
        // The count, not the text. "nothing to read" has now been the answer for two releases, and
        // the two possible reasons — buffer empty, or buffer never filled — need different fixes.
        transcriptMessages: transcripts.get(sessionId)?.length ?? 0,
        captureMessages: capture?.messagesOf?.(sessionId)?.length ?? 0,
      });
    } catch {
      /* diagnostic only */
    }
    let outcome;
    try {
      outcome =
        curation.trigger === undefined
          ? { ran: false, reason: 'no model route' }
          : await curation.trigger({ session });
    } catch (error) {
      outcome = { ran: false, reason: `threw: ${String(error?.message ?? error)}` };
    }
    // Only a real run marks the session done. Marking it on any attempt meant the first event of a
    // conversation — which arrives before there is anything to read — used up the one chance.
    if (outcome?.ran === true) curated.add(sessionId);
    try {
      store.audit.append('curate', {
        sessionId,
        trigger,
        ran: outcome?.ran === true,
        reason: outcome?.reason ?? null,
        written: Array.isArray(outcome?.written) ? outcome.written.length : 0,
        // What came back, when the shape was wrong. "reply has no keep array" on its own cannot tell a
        // different key from a stringified apology, and guessing at that has cost releases before.
        rawHead: outcome?.rawHead ?? null,
      });
    } catch {
      /* the audit is best-effort */
    }
  };

  disposers.push(
    ctx.effect(() =>
      ctx.on('session/event', (session, event) => {
        noteSeen(event?.type ?? '(none)');
        // `step/end` is the event that marks a finished turn in practice: `turn/end` is recorded in
        // the session log but is not dispatched here, which the histogram in `meta` shows directly.
        if (event?.type !== 'step/end') return;
        if (read('curatorMode') !== 'session-end') return;
        if (session?.id === undefined) return;
        void runCuration(session.id, session, 'step-end');
      }),
    ),
  );
  disposers.push(
    ctx.effect(() =>
      ctx.on('agent/disposed', ({ agent } = {}) => {
        const session = agent?.session;
        if (session?.id === undefined) return;
        void runCuration(session.id, session, 'disposed');
      }),
    ),
  );

  // The per-turn recall slice, and the rewrite that backs it up when it misses.
  //
  // This is the only surface that can do it. `systemPrompt.assemble` runs *before* this waterfall, and
  // at that moment the turn's message is still in the agent's inbox — claimed, not yet in the session
  // log — so the section cannot see what was just asked. It used to search by the *previous* message
  // instead, which meant a turn that changed the subject was handed memory about the old one and
  // nothing noticed, because a stale query that happens to match looks exactly like a hit.
  //
  // So the section now renders only what does not depend on the question (rules, the count pointer, the
  // pending notice), and everything query-dependent happens here, where the question exists.
  disposers.push(
    ctx.effect(
      () =>
        ctx.on('agent/pre-step', async (payload, next) => {
          const decision = await next();
          try {
            if (read('recallMode') !== 'slice') return decision;
            if (decision?.kind !== 'enter' || payload?.step !== 1) return decision;
            const session = payload?.agent?.session;
            if (session === undefined || (session.header?.delegationDepth ?? 0) > 0) return decision;
            if (store.injectionExemptReason(session.id) !== undefined) return decision;
            const query = firstUserText(decision.messages);
            if (query.length < 2) return decision;

            const scopes = resolveScopes({ sessionId: session.id, cwd: session.header?.cwd });
            const scopeKeys = readScopeKeys(scopes, { includeGlobal: read('includeGlobal') });
            const evaluatedAt = Date.now();

            // The slice itself, synchronous and free.
            const slice = composeSliceMessage({
              store,
              scopeKeys,
              scopeLabel: scopes.labels.workspace,
              query,
              now: evaluatedAt,
            });
            if (slice.ids.length > 0) {
              try {
                store.audit.append('recall-slice', {
                  sessionId: session.id,
                  turn: payload?.turn ?? null,
                  queryChars: query.length,
                  tier: slice.slice.tier,
                  ids: slice.ids,
                  bytes: slice.bytes,
                });
              } catch {
                /* diagnostic only */
              }
              return withRecallMessage(decision, slice.text);
            }

            // Nothing matched. Only now is a model call worth paying for.
            if (read('recallRewrite') !== 'on-miss' || modelRoute.complete === undefined) return decision;
            const rescue = await rescueMiss({
              store,
              sessionId: session.id,
              scopeKeys,
              scopeKey: scopes.workspace,
              complete: modelRoute.complete,
              now: evaluatedAt,
              log,
              query,
              turnKey: payload?.turn,
            });
            if (rescue.rescued !== true || rescue.text.length === 0) return decision;
            return withRecallMessage(decision, rescue.text);
          } catch (error) {
            log?.debug?.(`loci: recall slice failed: ${String(error?.message ?? error)}`);
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
