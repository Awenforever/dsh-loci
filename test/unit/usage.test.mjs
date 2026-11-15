import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { renderIndexBody } from '../../src/host/inject/index-section.js';
import { openTestStore } from '../helpers.mjs';

/**
 * Prompt economy only becomes measurable when each entry carries its own counters.
 * Aggregate request statistics answer "how big was the section"; they cannot answer
 * "which line is spending bytes and never being opened", which is the question that
 * decides what to delete.
 */
const reader = (overrides = {}) => {
  const values = { ...effectiveConfig(overrides), ...overrides };
  return (key) => values[key];
};

function renderAndRecord(store, scopes) {
  const rendered = renderIndexBody({
    store,
    scopeKeys: [scopes.workspace],
    scopeLabel: scopes.labels.workspace,
    config: reader(),
    now: Date.now(),
  });
  store.recordInjection({
    sessionId: 'usage-test',
    scopeKey: scopes.workspace,
    bytes: rendered.bytes,
    listed: rendered.listed,
    hidden: rendered.hidden,
    ids: rendered.ids,
  });
  return rendered;
}

test('a listed entry counts one injection, and a read counts one read', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'semantic',
    trustSource: 'user',
    title: '生产机不跑迁移',
    body: '迁移只在维护窗口做。',
  });

  renderAndRecord(store, scopes);
  renderAndRecord(store, scopes);
  store.recordRead(written.entry.id);

  const [row] = store.usageReport({ scopeKeys: [scopes.workspace] });
  assert.equal(row.id, written.entry.id);
  assert.equal(row.injections, 2);
  assert.equal(row.reads, 1);
  assert.ok(row.lastInjectedAt > 0);
  assert.ok(row.lastReadAt > 0);
});

test('an entry that is injected but never opened is visible as dead weight', (t) => {
  const { store, scopes } = openTestStore(t);
  const opened = store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'semantic',
    trustSource: 'user',
    title: '经常被打开的一条',
    body: '正文。',
  });
  const never = store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'semantic',
    trustSource: 'user',
    title: '从没被打开的一条',
    body: '正文。',
  });

  renderAndRecord(store, scopes);
  store.recordRead(opened.entry.id);

  const rows = store.usageReport({ scopeKeys: [scopes.workspace] });
  const dead = rows.find((row) => row.id === never.entry.id);
  assert.equal(dead.injections, 1);
  assert.equal(dead.reads, 0, 'this is the row a person should consider deleting');
});

test('counters are scoped, so a report never mixes projects', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    scope: 'workspace',
    scopeKey: 'workspace:other-project',
    scopeLabel: 'other-project',
    kind: 'semantic',
    trustSource: 'user',
    title: '别的项目的一条',
    body: '正文。',
  });
  renderAndRecord(store, scopes);
  const rows = store.usageReport({ scopeKeys: [scopes.workspace] });
  assert.equal(rows.length, 0, 'no entries in this scope, so no report rows');
});

test('recording a read for an unknown id is harmless', (t) => {
  const { store } = openTestStore(t);
  assert.doesNotThrow(() => store.recordRead('m_does_not_exist'));
  assert.doesNotThrow(() => store.recordRead(undefined));
});

test('an entry that was never injected still appears with zero counters', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'rule',
    trustSource: 'user',
    title: '还没被注入过的',
    body: '正文。',
  });
  const rows = store.usageReport({ scopeKeys: [scopes.workspace] });
  const row = rows.find((entry) => entry.id === written.entry.id);
  assert.ok(row, 'the LEFT JOIN must not hide an entry with no usage row');
  assert.equal(row.injections, 0);
  assert.equal(row.reads, 0);
});
