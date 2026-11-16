import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeSliceMessage, composeStable } from '../../src/host/recall/compose.js';
import { resetRescueGuard, rescueMiss } from '../../src/host/recall/rescue.js';
import { buildRewritePrompt, parseRewriteReply, rewriteQuery } from '../../src/host/recall/rewrite.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * Where the question comes from, and why the section no longer answers it.
 *
 * Measured ordering fact: `systemPrompt.assemble` runs inside `preStep`, and at that moment the turn's
 * message is still in the agent's inbox — claimed, not yet appended to the session log. So a prompt
 * section that searched by "the current question" could only ever search by the *previous* one, which
 * is what it did: a turn that changed the subject was handed memory about the old one, and nothing
 * detected it because a stale query that happens to match looks exactly like a hit.
 *
 * The split that fixes it: the section renders what does not depend on the question, and the waterfall
 * — which is handed the claimed messages — renders the part that does.
 */

function seed(store, scopes, entries) {
  for (const entry of entries) {
    store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', ...entry });
  }
}

function scopesOf(scopes) {
  return [scopes.workspace];
}

test('the stable half holds no question-dependent entry', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [
    { kind: 'rule', title: '删除前做断言', body: '先校验路径。' },
    { kind: 'semantic', title: 'atlas 的回滚窗口是三十分钟', body: '超过就升级。' },
  ]);
  const stable = composeStable({ store, scopeKeys: scopesOf(scopes), scopeLabel: scopes.labels.workspace });
  assert.match(stable.text, /Always applies/);
  assert.doesNotMatch(stable.text, /回滚窗口/, 'a topic-specific entry must not reach the section');
  assert.ok(stable.remaining >= 1, 'but the pointer says it exists');
});

test('the same question produces the match in the per-turn block', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [
    { kind: 'rule', title: '删除前做断言', body: '先校验路径。' },
    { kind: 'semantic', title: 'atlas 的回滚窗口是三十分钟', body: '超过就升级。' },
  ]);
  const block = composeSliceMessage({
    store,
    scopeKeys: scopesOf(scopes),
    scopeLabel: scopes.labels.workspace,
    query: 'atlas 的回滚窗口多久？',
  });
  assert.match(block.text, /回滚窗口是三十分钟/);
  assert.equal(block.slice.tier !== 'none', true);
});

test('a different question gets a different answer, which is the whole point', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [
    { kind: 'semantic', title: 'atlas 的回滚窗口是三十分钟', body: '超过就升级。' },
    { kind: 'semantic', title: 'beacon 的负责人是平台组', body: '找平台组。' },
  ]);
  const aboutAtlas = composeSliceMessage({
    store,
    scopeKeys: scopesOf(scopes),
    scopeLabel: scopes.labels.workspace,
    query: 'atlas 的回滚窗口多久？',
  });
  const aboutBeacon = composeSliceMessage({
    store,
    scopeKeys: scopesOf(scopes),
    scopeLabel: scopes.labels.workspace,
    query: 'beacon 的负责人是谁？',
  });
  assert.match(aboutAtlas.text, /atlas 的回滚窗口/);
  assert.doesNotMatch(aboutAtlas.text, /beacon 的负责人/);
  assert.match(aboutBeacon.text, /beacon 的负责人/);
  assert.doesNotMatch(aboutBeacon.text, /atlas 的回滚窗口/);
});

test('an empty question yields no block rather than a block about nothing', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'semantic', title: 'atlas 的回滚窗口是三十分钟', body: '超过就升级。' }]);
  const block = composeSliceMessage({ store, scopeKeys: scopesOf(scopes), scopeLabel: 'x', query: '' });
  assert.equal(block.text, '');
  assert.deepEqual(block.ids, []);
});

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

test('a rescue runs only when it is given a question', async (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'semantic', title: 'atlas 服务上线先走灰度', body: '先灰度。' }]);
  resetRescueGuard();
  let calls = 0;
  const result = await rescueMiss({
    store,
    sessionId: 'session-empty',
    scopeKeys: scopesOf(scopes),
    complete: async () => {
      calls += 1;
      return '["anything"]';
    },
    turnKey: 1,
  });
  assert.equal(result.rescued, false);
  assert.equal(calls, 0, 'no question means no model call');
  assert.match(result.error, /too short/);
});

test('a rescue finds what the original query could not', async (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'semantic', title: 'atlas 服务上线先走灰度', body: '先灰度再全量。' }]);
  resetRescueGuard();
  const result = await rescueMiss({
    store,
    sessionId: 'session-miss',
    scopeKeys: scopesOf(scopes),
    complete: async () => '["atlas 上线先走灰度"]',
    query: 'atlas 要发新版本第一步进哪个环境',
    turnKey: 1,
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
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return '["atlas 上线先走灰度"]';
  };
  const options = {
    store,
    sessionId: 'session-once',
    scopeKeys: scopesOf(scopes),
    complete,
    query: 'atlas 要发新版本',
    turnKey: 7,
  };
  await rescueMiss(options);
  const second = await rescueMiss(options);
  assert.equal(second.rescued, false, 'the second step of the same turn must not pay again');
  assert.equal(calls, 1);

  // A different turn is a different question and may pay again.
  const third = await rescueMiss({ ...options, turnKey: 8 });
  assert.equal(calls, 2, 'a new turn gets its own chance');
  assert.equal(third.rescued, true);
});

test('a rewrite that finds nothing is reported, not invented', async (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'semantic', title: 'beacon 的负责人是平台组', body: '找平台组。' }]);
  resetRescueGuard();
  const result = await rescueMiss({
    store,
    sessionId: 'session-none',
    scopeKeys: scopesOf(scopes),
    complete: async () => '["zulu license"]',
    query: 'zulu 的许可证是什么',
    turnKey: 1,
  });
  assert.equal(result.rescued, false);
  assert.equal(result.text, '');
});
