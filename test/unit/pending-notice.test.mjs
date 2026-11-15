import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { renderIndexBody } from '../../src/host/inject/index-section.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * Verified-only injection has a failure mode the user cannot see: a fact written
 * at midnight is absent at 9 a.m., and "never saved" looks identical to "saved but
 * waiting". These tests pin the one line that tells them apart — and that it costs
 * exactly zero bytes when there is nothing to say.
 */
function render(store, scopes, overrides = {}) {
  const config = (key) => ({ ...effectiveConfig(overrides), ...overrides })[key];
  return renderIndexBody({
    store,
    scopeKeys: [scopes.workspace],
    scopeLabel: scopes.labels.workspace,
    config,
  });
}

test('an empty store injects nothing at all, even with the notice wired in', (t) => {
  const { store, scopes } = openTestStore(t);
  const rendered = render(store, scopes);
  assert.equal(rendered.text, '');
  assert.equal(rendered.bytes, 0);
});

test('a pending candidate is announced, and says it is absent on purpose', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'tool', title: '模型写的候选', body: '没有引文。' });
  const rendered = render(store, scopes);
  assert.match(rendered.text, /1 item\(s\) await review/);
  assert.match(rendered.text, /deliberately absent/);
  assert.match(rendered.text, /\/loci review/);
  // The candidate itself must not leak into the index as a fact.
  assert.doesNotMatch(rendered.text, /模型写的候选/);
});

test('the notice disappears once nothing is pending, and costs no bytes', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    ...workspaceFields(scopes),
    kind: 'rule',
    trustSource: 'user',
    title: '删除前做断言',
    body: '先校验路径。',
  });
  const before = render(store, scopes);
  assert.doesNotMatch(before.text, /await review/);
  const baseline = before.bytes;

  // A candidate appears, then the same entry is verified by a person: the entry
  // count is unchanged, so the notice is the only thing that grows or shrinks.
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'tool', title: '候选一条', body: '没有引文。' });
  const during = render(store, scopes);
  assert.match(during.text, /await review/);
  assert.ok(during.bytes > baseline, 'the notice has a real cost while it is shown');
});

test('the notice is counted per scope and never crosses a scope boundary', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    kind: 'semantic',
    scope: 'workspace',
    scopeKey: 'workspace:someone-else',
    scopeLabel: 'someone-else',
    trustSource: 'tool',
    title: '别人的候选',
    body: '不该出现在这里。',
  });
  const rendered = render(store, scopes);
  assert.equal(rendered.text, '', 'a pending entry in another scope must not announce itself here');
});

test('the notice stays inside the footer reserve even at the byte ceiling', (t) => {
  const { store, scopes } = openTestStore(t);
  for (let i = 0; i < 40; i += 1) {
    store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'tool', title: `候选 ${i}`, body: '等待审批。' });
  }
  const rendered = render(store, scopes, { sectionMaxBytes: 1024 });
  assert.ok(rendered.bytes <= 1024, `section exceeded its budget: ${rendered.bytes}`);
  assert.match(rendered.text, /40 item\(s\) await review/);
});

test('the render cache is invalidated when the pending count changes', async (t) => {
  const { createIndexSection } = await import('../../src/host/inject/index-section.js');
  const { store, scopes } = openTestStore(t);
  const config = (key) => effectiveConfig({})[key];
  const section = createIndexSection({
    store,
    config,
    resolveContext: () => ({ sessionId: 'cache-test', scopeKeys: [scopes.workspace], scopeKey: scopes.workspace, scopeLabel: scopes.labels.workspace }),
  });

  store.write({ ...workspaceFields(scopes), kind: 'rule', trustSource: 'user', title: '一条规则', body: '正文。' });
  const first = section.text({});
  assert.doesNotMatch(first, /await review/);

  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'tool', title: '新候选', body: '没有引文。' });
  const second = section.text({});
  assert.match(second, /await review/, 'a new candidate must be visible on the next request, not after a restart');
});
