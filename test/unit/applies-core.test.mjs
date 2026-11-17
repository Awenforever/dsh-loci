import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../../src/host/config.js';
import { composeSliceMessage, composeStable, selectCore } from '../../src/host/recall/compose.js';
import { workspaceFields } from '../helpers.mjs';
import { openTestStore } from '../helpers.mjs';

/**
 * `applies` — whether an entry is shown every turn or found by retrieval.
 *
 * The live store forced this column: one rule about icon placement was injected 397 times into a session
 * that was rarely touching icon placement. The cause was not a bad sort — it was that nothing in the
 * write contract could say "this only applies when the subject comes up", so every `rule` entered the core
 * and stayed there, because ordering fell through to a clock that every injection reset.
 */

const scopesOf = (scopes) => [scopes.workspace];

function write(store, scopes, entry) {
  return store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', ...entry });
}

test('a standing rule reaches the core; a topical rule does not', (t) => {
  const { store, scopes } = openTestStore(t);
  write(store, scopes, { kind: 'rule', applies: 'always', title: '最终验收必须亲自截图', body: '否则整改。' });
  write(store, scopes, { kind: 'rule', title: '位置切换图标不要用左右箭头', body: '换更美观的图标。' });

  const core = selectCore({ store, scopeKeys: scopesOf(scopes) });
  assert.equal(core.lines.length, 1, 'only the standing rule belongs in the core');
  assert.match(core.lines[0], /最终验收必须亲自截图/);
  assert.equal(core.lines.some((line) => line.includes('位置切换图标')), false, 'the topical rule must stay out');
});

test('"rule" alone no longer qualifies — being a rule says nothing about when it applies', (t) => {
  // This is the exact regression: every `kind: 'rule'` used to enter the core, which is how a preference
  // about one screen ended up in front of every task.
  const { store, scopes } = openTestStore(t);
  write(store, scopes, { kind: 'rule', title: '一条完全没有 applies 的规则', body: '默认是 topic。' });
  const core = selectCore({ store, scopeKeys: scopesOf(scopes) });
  assert.equal(core.lines.length, 0, 'a rule with no applies is topical by default');
});

test('the default is topic, because "we never asked" is not evidence of standing', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = write(store, scopes, { kind: 'rule', title: '没有说明适用范围的规则', body: '正文。' });
  const row = store.db.prepare('SELECT applies FROM memory WHERE id = ?').get(written.entry.id);
  assert.equal(row.applies, 'topic');
});

test('applies survives a write and a revision', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = write(store, scopes, { kind: 'rule', applies: 'always', title: '常驻规则', body: '正文。' });
  // A revision is requested through `store.update`, not `write` — `op` is a tool-level argument.
  store.update(written.entry.id, {
    ...workspaceFields(scopes),
    expectedRevision: 1,
    title: '常驻规则（改写）',
    body: '新的正文。',
  });
  const row = store.db.prepare('SELECT applies FROM memory WHERE id = ? AND revision = 2').get(written.entry.id);
  assert.ok(row !== undefined, 'a revision was written');
  // An update that does not restate `applies` keeps the previous verdict rather than resetting to topic:
  // reclassifying is a decision, and silence is not one.
  assert.equal(row.applies, 'always');
});

test('pinned still reaches the core — a person saying "show me this" outranks the default', (t) => {
  const { store, scopes } = openTestStore(t);
  write(store, scopes, { kind: 'semantic', pinned: true, title: '用户要求常驻的一条事实', body: '正文。' });
  const core = selectCore({ store, scopeKeys: scopesOf(scopes) });
  assert.equal(core.lines.length, 1);
  assert.match(core.lines[0], /用户要求常驻的一条事实/);
});

test('an empty core is a correct result and does not get filled with topical filler', (t) => {
  // Filling the gap would make the contract unverifiable: a reader would see a core and assume everything
  // in it is standing, which is precisely the assumption that broke.
  const { store, scopes } = openTestStore(t);
  for (let i = 0; i < 5; i += 1) {
    write(store, scopes, { kind: 'rule', importance: 5, title: `热门但局限的规则 ${i}`, body: '正文。' });
  }
  const core = selectCore({ store, scopeKeys: scopesOf(scopes) });
  assert.equal(core.lines.length, 0, 'no always entries means no core');
  assert.equal(core.bytes, 0);
  assert.equal(core.total, 0);
});

test('the section still renders when the core is empty', (t) => {
  // The empty case has to produce a usable prompt, not a crash and not a header claiming standing rules
  // it does not have. It renders the index line and the "there is more, go look" hint instead.
  const { store, scopes } = openTestStore(t);
  write(store, scopes, { kind: 'semantic', title: 'atlas 的回滚窗口是三十分钟', body: '超过就升级。' });
  const stable = composeStable({ store, scopeKeys: scopesOf(scopes), scopeLabel: 'workspace 测试' });
  assert.equal(stable.core.lines.length, 0, 'the core is empty');
  assert.equal(/Always applies/.test(stable.text), false, 'no "Always applies" header over an empty core');
  assert.match(stable.text, /Index —/, 'but the block still identifies its scope');
  assert.match(stable.text, /loci_search/, 'and says where the rest of the memory went');
  assert.match(stable.text, /positions are in μ/, 'and still explains the unit the slice will use');
});

test('a topical entry is still reachable through the slice — the point of topic is retrieval, not exclusion', (t) => {
  const { store, scopes } = openTestStore(t);
  write(store, scopes, { kind: 'rule', title: '位置切换图标不要用左右箭头', body: '换更美观的图标。' });
  const core = selectCore({ store, scopeKeys: scopesOf(scopes) });
  assert.equal(core.lines.length, 0, 'not in the core');
  // And the slice finds it when the question is actually about it.
  const slice = composeSliceMessage({
    store,
    scopeKeys: scopesOf(scopes),
    scopeLabel: 'x',
    query: '位置切换图标用什么',
  });
  assert.match(slice.text, /位置切换图标/, 'but the slice surfaces it on a matching question');
});

test('the band configuration is untouched by this change', () => {
  // Guard against a refactor quietly changing an unrelated contract.
  assert.equal(DEFAULTS.muBandEdges, 'auto');
  assert.equal(DEFAULTS.muRetireAfter, 0);
});

test('a condition is rendered with the line, so a premise is never invisible', (t) => {
  // `whenCondition` was stored on every entry type and displayed on none. A conditional fact reached the
  // model as an unconditional title — worse than not injecting it, because the model then reasons from a
  // premise it cannot see.
  const { store, scopes } = openTestStore(t);
  write(store, scopes, {
    kind: 'semantic',
    applies: 'always',
    title: 'VM 可达',
    body: 'VM 运行在 invictus 上。',
    whenCondition: 'invictus 可达时',
  });
  const core = selectCore({ store, scopeKeys: scopesOf(scopes) });
  assert.equal(core.lines.length, 1);
  assert.match(core.lines[0], /when: invictus 可达时/, 'the premise is on the line');
});

test('an entry with no condition renders exactly as before — no empty marker', (t) => {
  const { store, scopes } = openTestStore(t);
  write(store, scopes, { kind: 'rule', applies: 'always', title: '无条件规则', body: '正文。' });
  const core = selectCore({ store, scopeKeys: scopesOf(scopes) });
  assert.equal(/when:/.test(core.lines[0]), false, 'a missing condition adds no bytes');
});

test('a long condition is truncated but still says a premise exists', (t) => {
  const { store, scopes } = openTestStore(t);
  write(store, scopes, {
    kind: 'semantic',
    applies: 'always',
    title: '长条件',
    body: '正文。',
    whenCondition: '当 invictus 可达且 VM 正在运行且 sshd 未卡死且网络没有分区的情况下',
  });
  const core = selectCore({ store, scopeKeys: scopesOf(scopes) });
  assert.match(core.lines[0], /when: /, 'the marker survives truncation');
  assert.ok(Buffer.byteLength(core.lines[0], 'utf8') < 400, 'and the line stays bounded');
});

test('the condition reaches the slice too, not only the core', (t) => {
  const { store, scopes } = openTestStore(t);
  write(store, scopes, {
    kind: 'semantic',
    title: 'SSH 端口走跳板机',
    body: '直接连会被拒。',
    whenCondition: '不在 tailnet 内时',
  });
  const slice = composeSliceMessage({
    store,
    scopeKeys: scopesOf(scopes),
    scopeLabel: 'x',
    query: 'SSH 端口怎么连',
  });
  assert.match(slice.text, /when: 不在 tailnet 内时/);
});

test('the audit records whether the caller supplied the verdicts, not just the resulting values', (t) => {
  // Without this, a deliberate `topic` and a write that never mentioned the field produce identical rows.
  // After 5.2.0 shipped, three curator writes came back all-topic and there was no way to tell whether the
  // new prompt was working or being ignored.
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', kind: 'rule', title: '声明了', body: '正文。', applies: 'always', importance: 4 });
  store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', kind: 'rule', title: '没声明', body: '正文。' });

  const writes = store.auditTail(20).filter((event) => event.event === 'write');
  const declared = writes.find((event) => event.supplied?.applies === true);
  const silent = writes.find((event) => event.supplied?.applies === false);
  assert.ok(declared !== undefined, 'a stated verdict is recorded as supplied');
  assert.equal(declared.supplied.importance, true);
  assert.ok(silent !== undefined, 'a defaulted verdict is recorded as unsupplied');
  assert.equal(silent.supplied.importance, false);
});

test('an index echo is quarantined, even when the caller claims verified', (t) => {
  // The first version flagged it and stored it anyway. A real echo landed in the live store at 13:56 with
  // `flags: ["index-echo"]` and full trust — the feedback loop continuing with a label on it. The caller
  // claiming `verified` is precisely the case that cannot be trusted, because the extractor that produced
  // the echo believed it had found a rule.
  const { store, scopes } = openTestStore(t);
  const written = store.write({
    ...workspaceFields(scopes),
    status: 'verified',
    trustSource: 'rule',
    kind: 'rule',
    title: '- m_01M7JR74R4K636SPA01Q · rule · 701 μ ago · MFC 面板预留空白宽度只能略微增加',
    body: '这条是渲染出来的索引行，不是人说的话。',
  });
  assert.equal(written.entry.status, 'disputed', 'an echo never becomes verified');
  assert.ok(written.entry.flags.includes('index-echo'), 'and it says why');
});

test('the same text written without the echo shape keeps its verified status', (t) => {
  // The quarantine must not swallow ordinary memories: only the rendered-line shape is caught.
  const { store, scopes } = openTestStore(t);
  const written = store.write({
    ...workspaceFields(scopes),
    status: 'verified',
    trustSource: 'user',
    kind: 'rule',
    title: 'MFC 面板预留空白宽度只能略微增加',
    body: '禁止一次扩充 200%。',
  });
  assert.equal(written.entry.status, 'verified');
  assert.equal(written.entry.flags.includes('index-echo'), false);
});
