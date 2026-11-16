import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CORE_BUDGET_BYTES, composeRecall, selectCore, selectSlice } from '../../src/host/recall/compose.js';
import { createIndexSection } from '../../src/host/inject/index-section.js';
import { DEFAULTS } from '../../src/host/config.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * The section is composed per request instead of being a fixed list.
 *
 * Measured baseline this replaces (`scripts/eval-memory.mjs`): the fixed index spent 3.3 KB on
 * every request, its coverage fell from 87% to 12% as the store grew, and it found none of the
 * reworded questions. Three properties keep the replacement honest: the core must contain only
 * things that really are unconditional, the slice must stay inside its budget, and a question
 * that finds nothing must say so rather than looking like an empty store.
 */

function seed(store, scopes, entries) {
  for (const entry of entries) {
    store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', ...entry });
  }
}

const scopesOf = (scopes) => [scopes.workspace];
const compose = (store, scopes, query) =>
  composeRecall({ store, scopeKeys: scopesOf(scopes), scopeLabel: scopes.labels.workspace, query });

test('the core holds rules and pinned entries, never merely recent ones', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [
    { kind: 'rule', title: '永远不要在周五发版', body: '周五发版没人接。' },
    { kind: 'semantic', title: 'atlas 服务上线先走灰度', body: '先灰度再全量。' },
    { kind: 'semantic', title: '最近写入的普通事实', body: '越新越容易被当成永久的。' },
  ]);
  const core = selectCore({ store, scopeKeys: scopesOf(scopes) });
  assert.equal(core.lines.length, 1, 'only the rule belongs in the core');
  assert.match(core.lines[0], /永远不要在周五发版/);
  // A first version admitted every semantic entry ordered by recency, which put recent filler
  // at the top of the prompt under the heading "Always applies".
  assert.ok(!core.lines.some((line) => line.includes('最近写入的普通事实')));
});

test('the core stops at its byte budget', (t) => {
  const { store, scopes } = openTestStore(t);
  const entries = [];
  for (let i = 0; i < 40; i += 1) {
    entries.push({ kind: 'rule', title: `规则第 ${i} 条：这是一段用来占字节的比较长的规则文本`, body: '正文。' });
  }
  seed(store, scopes, entries);
  const core = selectCore({ store, scopeKeys: scopesOf(scopes), budgetBytes: 300 });
  assert.ok(core.bytes <= 300, `core must stay inside the budget, got ${core.bytes}`);
  assert.ok(core.lines.length > 0, 'and must still show something');
  assert.ok(core.lines.length < 40, 'it cannot show everything');
});

test('an exact-shape question is answered by the strict tier', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [
    { kind: 'semantic', title: 'atlas 的回滚窗口是三十分钟', body: '超过就升级。' },
    { kind: 'semantic', title: 'beacon 的负责人是平台组', body: '找平台组。' },
  ]);
  const slice = selectSlice({ store, scopeKeys: scopesOf(scopes), query: 'atlas 的回滚窗口多久？' });
  assert.equal(slice.tier, 'strict');
  assert.equal(slice.ids.length, 1);
  assert.match(slice.lines[0], /回滚窗口是三十分钟/);
});

test('a reworded question is answered by the loose tier, and says so', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'semantic', title: 'atlas 服务上线先走灰度', body: '先灰度。' }]);
  // Shares only the anchor, so no contiguous run is present: the strict pass returns nothing
  // and the second chance has to do the work.
  const slice = selectSlice({ store, scopeKeys: scopesOf(scopes), query: 'atlas 要发新版本第一步进哪个环境？' });
  assert.equal(slice.tier, 'loose');
  assert.equal(slice.ids.length, 1);
});

test('a question that matches nothing reports what it looked for', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'semantic', title: 'beacon 的负责人是平台组', body: '找平台组。' }]);
  const slice = selectSlice({ store, scopeKeys: scopesOf(scopes), query: 'zulu 的许可证是什么？' });
  assert.equal(slice.tier, 'none');
  assert.deepEqual(slice.ids, []);
  assert.ok(slice.topics.length > 0, 'the terms it searched for are reported, not discarded');
});

test('a truly empty store injects nothing', (t) => {
  const { store, scopes } = openTestStore(t);
  const composed = compose(store, scopes, '随便问点什么');
  assert.equal(composed.text, '');
  assert.equal(composed.bytes, 0);
});

test('an unverified candidate is announced, not silently dropped', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), kind: 'rule', trustSource: 'tool', title: '候选不该出现', body: '没引文。' });
  const composed = compose(store, scopes, '候选');
  assert.match(composed.text, /await review/, 'a person waiting to approve must be visible in the prompt');
  assert.doesNotMatch(composed.text, /候选不该出现/, 'but the candidate itself must not leak in as a fact');
});

test('a question that matches nothing still says the memory exists', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'semantic', title: 'beacon 的负责人是平台组', body: '找平台组。' }]);
  const composed = compose(store, scopes, '今天天气怎么样？');
  // Returning an empty section here was a real defect: it made "the store has an entry you did
  // not match" indistinguishable from "there is no memory at all", which is the case the
  // pointer exists for.
  assert.ok(composed.bytes > 0, 'the pointer must render');
  assert.match(composed.text, /more entr(y|ies) in scope/);
  assert.doesNotMatch(composed.text, /平台组/, 'and it must not show the entry it did not match');
});

test('the pointer counts what the section did not show', (t) => {
  const { store, scopes } = openTestStore(t);
  const entries = [{ kind: 'rule', title: '一条规则', body: '正文。' }];
  for (let i = 0; i < 25; i += 1) entries.push({ kind: 'semantic', title: `填充事实 ${i}`, body: '正文。' });
  seed(store, scopes, entries);
  const composed = compose(store, scopes, '一条规则');
  assert.match(composed.text, /more entr(y|ies) in scope/);
  assert.ok(composed.remaining > composed.core.ids.length + composed.slice.ids.length);
});

test('the section spends far less than the fixed index it replaces', (t) => {
  const { store, scopes } = openTestStore(t);
  const entries = [];
  for (let i = 0; i < 200; i += 1) entries.push({ kind: 'semantic', title: `事实 ${i} 的标题`, body: '正文。' });
  seed(store, scopes, entries);
  const composed = compose(store, scopes, '事实 7 的标题');
  assert.ok(composed.bytes > 0);
  assert.ok(composed.bytes <= 2000, `a per-question section must stay small, got ${composed.bytes}`);
});

test('slice mode changes what the registered section renders', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [
    { kind: 'rule', title: '删除前做断言', body: '先校验路径。' },
    { kind: 'semantic', title: 'atlas 的回滚窗口是三十分钟', body: '超过就升级。' },
  ]);
  const build = (mode) =>
    createIndexSection({
      store,
      config: (key) => ({ ...DEFAULTS, recallMode: mode })[key],
      resolveContext: () => ({
        sessionId: 'recall-test',
        scopeKey: scopes.workspace,
        scopeKeys: scopesOf(scopes),
        scopeLabel: scopes.labels.workspace,
        lastUserText: 'atlas 的回滚窗口多久？',
      }),
    });

  const sliceText = build('slice').text({});
  assert.match(sliceText, /Always applies/, 'slice mode groups by why an entry is shown');
  assert.match(sliceText, /Relevant to what you just asked/);
  assert.match(sliceText, /回滚窗口是三十分钟/);

  const indexText = build('index').text({});
  assert.doesNotMatch(indexText, /Always applies/, 'index mode is unchanged and keeps no headings');
});

test('the section degrades to the core when there is no question yet', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'rule', title: '删除前做断言', body: '先校验路径。' }]);
  const section = createIndexSection({
    store,
    config: (key) => ({ ...DEFAULTS, recallMode: 'slice' })[key],
    resolveContext: () => ({
      sessionId: 'recall-empty',
      scopeKey: scopes.workspace,
      scopeKeys: scopesOf(scopes),
      scopeLabel: scopes.labels.workspace,
      lastUserText: undefined,
    }),
  });
  const text = section.text({});
  assert.match(text, /删除前做断言/, 'the core is what applies before anything is asked');
  assert.doesNotMatch(text, /Relevant to what you just asked/);
});

test('a huge question cannot inflate the section', (t) => {
  const { store, scopes } = openTestStore(t);
  const entries = [];
  for (let i = 0; i < 60; i += 1) entries.push({ kind: 'semantic', title: `atlas 的第 ${i} 条记录说明`, body: '正文。' });
  seed(store, scopes, entries);
  const composed = compose(store, scopes, 'atlas '.repeat(200) + '的第');
  assert.ok(composed.bytes <= 2000, `budget must hold regardless of query size, got ${composed.bytes}`);
});

void CORE_BUDGET_BYTES;
