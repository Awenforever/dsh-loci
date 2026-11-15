import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAssistBlock } from '../../src/host/inject/index-section.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * R4 for the one conditional injection path.
 *
 * `recallAssist` put entries into the conversation and recorded **nothing** — no
 * `request_stat` row, no per-entry counter, no ids in the audit line, and the search call
 * that produced it did not even carry a session id. The panel could therefore not answer
 * "why did this entry appear in that session" for the only feature that injects
 * conditionally, which is exactly what the project's own R4 rule requires.
 *
 * These tests pin the recording, not the rendering.
 */
async function seed(t) {
  const { store, scopes } = openTestStore(t);
  const fields = workspaceFields(scopes);
  const written = store.write({ ...fields, kind: 'semantic', trustSource: 'user', title: '回滚窗口是三十分钟', body: '出问题后三十分钟内决定。' });
  store.write({ ...fields, kind: 'semantic', trustSource: 'user', title: '发布顺序是 staging 到 canary 到全量', body: '任何一步失败立刻停。' });
  return { store, scopes, id: written.entry.id };
}

test('the assist block reports the ids it rendered', async (t) => {
  const { store, scopes, id } = await seed(t);
  const block = await renderAssistBlock({
    store,
    scopeKeys: [scopes.workspace],
    query: '回滚窗口多久？',
    maxBytes: 512,
    sessionId: 'sess-r4',
    scopeKey: scopes.workspace,
  });
  assert.deepEqual(block.ids, [id]);
  assert.ok(block.bytes > 0);
  assert.ok(block.text.includes(id));
});

test('nothing matched means no ids and no bytes', async (t) => {
  const { store, scopes } = await seed(t);
  const block = await renderAssistBlock({
    store,
    scopeKeys: [scopes.workspace],
    query: '今天天气怎么样？',
    maxBytes: 512,
    sessionId: 'sess-r4b',
    scopeKey: scopes.workspace,
  });
  assert.deepEqual(block.ids, []);
  assert.equal(block.bytes, 0);
  assert.equal(block.text, '');
});

test('an assist injection is written with source "assist" and its ids', async (t) => {
  const { store, scopes, id } = await seed(t);
  const block = await renderAssistBlock({
    store,
    scopeKeys: [scopes.workspace],
    query: '回滚窗口多久？',
    maxBytes: 512,
    sessionId: 'sess-r4c',
    scopeKey: scopes.workspace,
  });
  store.recordInjection({
    sessionId: 'sess-r4c',
    scopeKey: scopes.workspace,
    bytes: block.bytes,
    listed: block.ids.length,
    hidden: 0,
    ids: block.ids,
    source: 'assist',
  });

  const row = store.db.prepare('SELECT session_id, source, entries_listed FROM request_stat ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.source, 'assist', 'the panel must be able to tell the two surfaces apart');
  assert.equal(row.session_id, 'sess-r4c');
  assert.equal(row.entries_listed, 1);

  // The per-entry counter is what answers "was this line ever actually used".
  const usage = store.db.prepare('SELECT inject_count FROM memory_usage WHERE id = ?').get(id);
  assert.ok(usage !== undefined, 'the injected entry must get a usage row');
  assert.equal(Number(usage.inject_count), 1);

  assert.equal(store.stats().lastInjection.source, 'assist');
});

test('a section injection still records itself as "section"', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: '一条事实', body: '正文。' });
  store.recordInjection({ sessionId: 'sess-section', scopeKey: scopes.workspace, bytes: 120, listed: 1, hidden: 0 });
  const row = store.db.prepare('SELECT source FROM request_stat ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.source, 'section', 'the default must stay the index, so old rows and new ones agree');
});
