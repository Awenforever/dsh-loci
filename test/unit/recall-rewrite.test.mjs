import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRewritePrompt, parseRewriteReply, rewriteQuery } from '../../src/host/recall/rewrite.js';
import { resetRescueGuard, rescueMiss } from '../../src/host/recall/rescue.js';
import { lastSliceOf, recordLastSlice } from '../../src/host/recall/compose.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * Rewriting a question so the words match what was stored.
 *
 * The measured reason this exists (`scripts/eval-memory.mjs`): about 40% of reworded questions miss
 * at 600 entries, and no admission threshold fixes it — `atlas 要发新版本` and
 * `atlas 服务上线先走灰度` share exactly one token. A tokenizer cannot bridge that; a model can.
 *
 * These tests pin the guards rather than the quality: a rescue costs a model call, so it must only
 * happen on a genuine miss, only once per turn, and it must not replace an answer that was already
 * found.
 */

function seed(store, scopes, entries) {
  for (const entry of entries) {
    store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', ...entry });
  }
}

test('a JSON array of alternatives is parsed and deduplicated', () => {
  const queries = parseRewriteReply('["which environment first","canary rollout","which environment first"]');
  assert.deepEqual(queries, ['which environment first', 'canary rollout']);
});

test('a fenced array and a plain list are both tolerated', () => {
  assert.equal(parseRewriteReply('```json\n["first deploy step"]\n```').length, 1);
  // A model that answered as a list instead of JSON is still giving usable queries; the cost of
  // rejecting them is a missed memory, and the cost of accepting them is a validated string.
  assert.equal(parseRewriteReply('1. first deploy step\n2. canary rollout').length, 2);
});

test('junk is rejected rather than used as a search query', () => {
  assert.deepEqual(parseRewriteReply('no idea'), [], 'a single line of prose is a refusal, not a query');
  // An object with the alternatives nested is not the requested shape and must not be turned into
  // a query by stringifying it.
  assert.deepEqual(parseRewriteReply('{"queries":["a usable one"]}'), []);
  assert.deepEqual(parseRewriteReply('[1, null, {}, "x"]'), []);
  // Over-long "queries" are paragraphs, not searches.
  assert.deepEqual(parseRewriteReply(`["${'x'.repeat(200)}"]`), []);
});

test('the rewrite excludes the original question', async () => {
  const result = await rewriteQuery({
    query: 'atlas 要发新版本',
    complete: async () => '["atlas 要发新版本","atlas 上线先走灰度"]',
  });
  assert.deepEqual(result.queries, ['atlas 上线先走灰度']);
});

test('the prompt asks for rewording, not synonyms pasted together', () => {
  const prompt = buildRewritePrompt('atlas 要发新版本', ['灰度', '回滚窗口']);
  assert.match(prompt, /different words for the same idea/);
  assert.match(prompt, /灰度, 回滚窗口/, 'the store vocabulary is offered as a hint');
  assert.match(prompt, /ONLY a JSON array/);
});

test('no model route is stated, not silently ignored', async () => {
  const result = await rewriteQuery({ query: 'anything', complete: undefined });
  assert.match(result.error, /no model route/);
});

test('the section leaves a note that a later handler can read', () => {
  recordLastSlice('session-note', { tier: 'none', query: 'atlas 要发新版本', ids: [] });
  const note = lastSliceOf('session-note');
  assert.equal(note.tier, 'none');
  assert.equal(note.query, 'atlas 要发新版本');
  // A stale note must not trigger a rewrite on some later turn.
  assert.equal(lastSliceOf('session-note', -1), undefined);
});

test('a rescue runs only on a miss', async (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'semantic', title: 'atlas 服务上线先走灰度', body: '先灰度。' }]);
  resetRescueGuard();
  recordLastSlice('session-hit', { tier: 'strict', query: 'atlas 上线先走灰度', ids: ['x'] });
  let calls = 0;
  const result = await rescueMiss({
    store,
    sessionId: 'session-hit',
    scopeKeys: [scopes.workspace],
    complete: async () => {
      calls += 1;
      return '["anything"]';
    },
  });
  assert.equal(result.rescued, false);
  assert.equal(calls, 0, 'a rewrite when the slice already answered spends a call to second-guess it');
});

test('a rescue finds what the original query could not', async (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'semantic', title: 'atlas 服务上线先走灰度', body: '先灰度再全量。' }]);
  resetRescueGuard();
  recordLastSlice('session-miss', { tier: 'none', query: 'atlas 要发新版本第一步进哪个环境', ids: [] });

  const result = await rescueMiss({
    store,
    sessionId: 'session-miss',
    scopeKeys: [scopes.workspace],
    complete: async () => '["atlas 上线先走灰度"]',
  });
  assert.equal(result.rescued, true, JSON.stringify(result));
  assert.equal(result.ids.length, 1);
  assert.match(result.text, /atlas 服务上线先走灰度/);
  assert.match(result.text, /renamed:/, 'the rescue says which words found it');
});

test('one turn pays for at most one rescue', async (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'semantic', title: 'atlas 服务上线先走灰度', body: '先灰度。' }]);
  resetRescueGuard();
  recordLastSlice('session-once', { tier: 'none', query: 'atlas 要发新版本', ids: [] });
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return '["atlas 上线先走灰度"]';
  };
  const options = { store, sessionId: 'session-once', scopeKeys: [scopes.workspace], complete };
  await rescueMiss(options);
  const second = await rescueMiss(options);
  assert.equal(second.rescued, false, 'the second step of the same turn must not pay again');
  assert.equal(calls, 1);
});

test('a rewrite that finds nothing is reported, not invented', async (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'semantic', title: 'beacon 的负责人是平台组', body: '找平台组。' }]);
  resetRescueGuard();
  recordLastSlice('session-empty', { tier: 'none', query: 'zulu 的许可证是什么', ids: [] });
  const result = await rescueMiss({
    store,
    sessionId: 'session-empty',
    scopeKeys: [scopes.workspace],
    complete: async () => '["zulu license"]',
  });
  assert.equal(result.rescued, false);
  assert.equal(result.text, '');
});
