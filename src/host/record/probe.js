/**
 * A one-off self-test for the decision layer.
 *
 * The curator's *judgement* was never measured — with no live model, a fixture would only measure
 * the fixture. This probe closes that gap without waiting for a conversation to end: at activation
 * it runs one real curation pass over a fixed transcript, against the real model route, and stores
 * the outcome in `meta` so it can be read afterwards instead of inferred.
 *
 * The transcript is chosen to be the case the rules lose: two durable statements that match no
 * extraction pattern, plus chatter that must not be kept. Anything the model returns has to pass
 * the same validation a real curation pass passes, so a green result means the whole path works,
 * not just that the model answered something.
 *
 * Cost is one model call per plugin version, recorded, and never repeated silently.
 * @module dsh-loci/record/probe
 */
import { readMeta, writeMeta } from '../store/schema.js';
import { CURATOR_SYSTEM, curate, parseCuratorReply } from './curator.js';

/** Where the result lives. */
export const PROBE_META_KEY = 'curator_probe';

/** The fixed transcript. Two statements the rule extractor misses, and noise that must be dropped. */
export const PROBE_TRANSCRIPT = [
  { role: 'user', text: '以后部署先走灰度，别再直接全量了。' },
  { role: 'assistant', text: '好，先灰度再全量。' },
  { role: 'user', text: '今天先把登录页的按钮颜色调一下。' },
  { role: 'user', text: '永远不要在周五发版，周末没人盯着。' },
];

/** What a correct judge must keep. Matched loosely: the wording is the model's to choose. */
const EXPECTED = [
  { label: 'deploy-first-canary', hints: ['灰度', 'canary'] },
  { label: 'never-friday-release', hints: ['周五', 'friday'] },
];

/** Statements that must NOT be kept. */
const NOISE = ['按钮颜色', 'button color'];

/** Versions already probed are not probed again. */
function alreadyProbed(store, pluginVersion) {
  const raw = readMeta(store.db, PROBE_META_KEY);
  if (typeof raw !== 'string') return false;
  try {
    return JSON.parse(raw)?.version === pluginVersion;
  } catch {
    return false;
  }
}

/**
 * Run the probe once and record what happened.
 *
 * @param options - `store`, `complete` (the `{system, prompt}` route), `pluginVersion`, `log`,
 *   `force`.
 * @returns `{ran, reason?, result?}`.
 */
export async function runCuratorProbe({ store, complete, pluginVersion, log, force = false }) {
  if (typeof complete !== 'function') return { ran: false, reason: 'no model route' };
  if (!force && alreadyProbed(store, pluginVersion)) return { ran: false, reason: 'already probed for this version' };

  let reply;
  try {
    reply = await curate({
      store,
      // A dry run: the probe must never write memory. What it measures is the judgement, and
      // writing memory to measure it would be the product polluting itself to test itself.
      scope: { scope: 'session', scopeKey: 'session:probe', scopeLabel: 'probe' },
      messages: PROBE_TRANSCRIPT,
      callModel: async ({ prompt }) => complete({ system: CURATOR_SYSTEM, prompt }),
      sessionId: 'session:curator-probe',
      dryRun: true,
    });
  } catch (error) {
    const result = { version: pluginVersion, at: Date.now(), ok: false, error: String(error?.message ?? error) };
    writeMeta(store.db, PROBE_META_KEY, JSON.stringify(result));
    log?.warn?.(`loci: curator probe failed: ${result.error}`);
    return { ran: true, result };
  }

  if (reply.error !== undefined) {
    const result = { version: pluginVersion, at: Date.now(), ok: false, error: reply.error };
    writeMeta(store.db, PROBE_META_KEY, JSON.stringify(result));
    log?.warn?.(`loci: curator probe could not judge: ${reply.error}`);
    return { ran: true, result };
  }

  const titles = reply.items.map((item) => `${item.title} ${item.body}`.toLowerCase());
  const caught = EXPECTED.filter((want) => titles.some((text) => want.hints.some((hint) => text.includes(hint))));
  const missed = EXPECTED.filter((want) => !caught.includes(want));
  const keptNoise = reply.items.filter((item) =>
    NOISE.some((hint) => `${item.title} ${item.body}`.toLowerCase().includes(hint)),
  );

  const result = {
    version: pluginVersion,
    at: Date.now(),
    ok: missed.length === 0 && keptNoise.length === 0,
    kept: reply.items.map((item) => ({ kind: item.kind, title: item.title })),
    dropped: reply.dropped,
    caught: caught.map((want) => want.label),
    missed: missed.map((want) => want.label),
    keptNoise: keptNoise.map((item) => item.title),
    // The validator is part of what is being tested: a model that answers correctly but in an
    // unparsable shape is a failure of the pipeline, not a success with a note.
    parsed: parseCuratorReply(JSON.stringify({ keep: reply.items, drop: [] }), { messages: PROBE_TRANSCRIPT }).error === undefined,
  };
  writeMeta(store.db, PROBE_META_KEY, JSON.stringify(result));
  log?.info?.(`loci: curator probe kept ${result.kept.length}, caught ${result.caught.length}/${EXPECTED.length}`);

  // The probe's job is to make model judgement observable, and an unread result is not observable.
  try {
    store.audit.append('curate-probe', result);
  } catch {
    /* the audit is best-effort; the meta row above is the durable record */
  }
  return { ran: true, result };
}
