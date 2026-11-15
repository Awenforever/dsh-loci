import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { renderIndexBody } from '../../src/host/inject/index-section.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * A lesson stored as free text is unreadable six months later: you remember the rule
 * but not why it exists. These tests pin the shape — and that ordinary facts are
 * byte-identical to before, because the index line only grows for procedural entries
 * that actually carry `prevents`.
 */
const reader = (overrides = {}) => {
  const values = { ...effectiveConfig(overrides), ...overrides };
  return (key) => values[key];
};

function lesson(store, scopes, extra = {}) {
  return store.write({
    ...workspaceFields(scopes),
    kind: 'procedural',
    trustSource: 'user',
    title: '用脚本改代码前确认引号',
    body: '补丁脚本里的反引号会被吞。',
    pattern: '反引号紧跟点号吞字符',
    fix: '改用 edit 工具或 IO.File::WriteAllText',
    prevents: '静默写入错误内容，本地全绿 CI 红',
    whenCondition: '用脚本批量改代码时',
    ...extra,
  });
}

test('the four lesson fields round-trip through a write and a read', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = lesson(store, scopes);
  assert.equal(written.entry.pattern, '反引号紧跟点号吞字符');
  assert.equal(written.entry.fix, '改用 edit 工具或 IO.File::WriteAllText');
  assert.equal(written.entry.prevents, '静默写入错误内容，本地全绿 CI 红');
  assert.equal(written.entry.whenCondition, '用脚本批量改代码时');

  const fetched = store.get(written.entry.id).entry;
  assert.equal(fetched.prevents, '静默写入错误内容，本地全绿 CI 红');
});

test('an ordinary fact has no lesson shape, and null is the single representation', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: '普通事实', body: '正文。' });
  assert.equal(written.entry.pattern, null);
  assert.equal(written.entry.fix, null);
  assert.equal(written.entry.prevents, null);
  assert.equal(written.entry.whenCondition, null);
});

test('empty strings are stored as null, not as empty columns', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = lesson(store, scopes, { prevents: '   ', pattern: '' });
  assert.equal(written.entry.prevents, null);
  assert.equal(written.entry.pattern, null);
});

test('the index line carries prevents for a lesson, and nothing extra for a fact', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: '普通事实', body: '正文。' });
  lesson(store, scopes);
  const rendered = renderIndexBody({
    store,
    scopeKeys: [scopes.workspace],
    scopeLabel: scopes.labels.workspace,
    config: reader(),
  });
  assert.match(rendered.text, /· procedural ·.*— prevents: 静默写入错误内容/);
  assert.doesNotMatch(rendered.text, /普通事实 — prevents/);
});

test('the fact line is byte-identical whether or not a lesson exists beside it', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: '普通事实', body: '正文。' });
  const before = renderIndexBody({
    store,
    scopeKeys: [scopes.workspace],
    scopeLabel: scopes.labels.workspace,
    config: reader(),
  }).text;
  lesson(store, scopes);
  const after = renderIndexBody({
    store,
    scopeKeys: [scopes.workspace],
    scopeLabel: scopes.labels.workspace,
    config: reader(),
  }).text;
  const factLine = (text) => text.split('\n').find((line) => line.includes('· semantic ·'));
  assert.equal(factLine(after), factLine(before));
});

test('an update that does not restate the lesson keeps the previous shape', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = lesson(store, scopes);
  const updated = store.update(written.entry.id, {
    ...workspaceFields(scopes),
    kind: 'procedural',
    trustSource: 'user',
    title: '改了个错别字',
    body: '补丁脚本里的反引号会被吞。',
  });
  assert.equal(updated.entry.prevents, '静默写入错误内容，本地全绿 CI 红', 'editing a title must not erase why the lesson exists');
  assert.equal(updated.entry.revision, 2);
});

test('the lesson shape never raises trust', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = store.write({
    ...workspaceFields(scopes),
    kind: 'procedural',
    trustSource: 'tool',
    title: '模型自己写的教训',
    body: '正文。',
    prevents: '它说会坏的东西',
  });
  assert.equal(written.entry.status, 'candidate');
  assert.equal(store.indexEntries({ scopeKeys: [scopes.workspace] }).length, 0);
});
