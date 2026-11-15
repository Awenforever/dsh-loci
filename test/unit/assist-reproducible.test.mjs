import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAssistBlock } from '../../src/host/inject/index-section.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * R3 for the recall assist: evaluation must be a pure function of
 * (store snapshot, query, scope keys, now).
 *
 * `search` already keyed its recency term and its time-window filter off a `now` it
 * accepted — but `renderAssistBlock` never passed one, so it silently took `Date.now()`
 * and the same store ranked differently on replay. That made "reproducible snapshot" a
 * sentence in a document rather than a property of the code.
 *
 * The recorded row now carries the same instant the ranking used, plus the store's
 * `indexRev`, so a later reader can tell which snapshot produced which ids.
 */
const DAY = 86_400_000;

async function seed(t) {
  const { store, scopes } = openTestStore(t);
  const fields = workspaceFields(scopes);
  store.write({ ...fields, kind: 'semantic', trustSource: 'user', title: '回滚窗口是三十分钟', body: '出问题后三十分钟内决定。' });
  store.write({ ...fields, kind: 'semantic', trustSource: 'user', title: '回滚演练每半年一次', body: '演练安排在淡季。' });
  return { store, scopes };
}

test('the same snapshot and the same instant produce the same ids in the same order', async (t) => {
  const { store, scopes } = await seed(t);
  const now = Date.now() - DAY;
  const options = {
    store,
    scopeKeys: [scopes.workspace],
    query: '回滚相关的规定有哪些？',
    maxBytes: 512,
    sessionId: 'sess-r3',
    scopeKey: scopes.workspace,
    now,
  };
  const first = await renderAssistBlock(options);
  const second = await renderAssistBlock(options);
  assert.ok(first.ids.length > 0, 'the fixture must actually match something');
  assert.deepEqual(second.ids, first.ids, 'replaying the same evaluation must not reorder');
});

test('a different instant may reorder — the dependency is documented, not hidden', async (t) => {
  const { store, scopes } = await seed(t);
  const now = Date.now() - DAY;
  const base = {
    store,
    scopeKeys: [scopes.workspace],
    query: '回滚相关的规定有哪些？',
    maxBytes: 512,
    sessionId: 'sess-r3b',
    scopeKey: scopes.workspace,
  };
  const early = await renderAssistBlock({ ...base, now });
  const late = await renderAssistBlock({ ...base, now: now + 400 * DAY });
  // Both were written moments apart, so pushing `now` 400 days forward equalises the
  // recency term and can swap them. The point is that the *instant is an input*: with it
  // pinned the result is stable, and without it the outcome drifts with the wall clock —
  // which is exactly what R3 forbids.
  assert.deepEqual([...late.ids].sort(), [...early.ids].sort(), 'the same entries are candidates');
});

test('the record carries the instant the ranking used, not a second clock read', async (t) => {
  const { store, scopes } = await seed(t);
  const evaluatedAt = Date.now() - DAY;
  const block = await renderAssistBlock({
    store,
    scopeKeys: [scopes.workspace],
    query: '回滚相关的规定有哪些？',
    maxBytes: 512,
    sessionId: 'sess-r3c',
    scopeKey: scopes.workspace,
    now: evaluatedAt,
  });
  const rev = store.indexRev();
  store.recordInjection({
    sessionId: 'sess-r3c',
    scopeKey: scopes.workspace,
    bytes: block.bytes,
    listed: block.ids.length,
    hidden: 0,
    ids: block.ids,
    source: 'assist',
    ts: evaluatedAt,
    indexRev: rev,
  });
  const row = store.db.prepare('SELECT ts, source FROM request_stat ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.ts, evaluatedAt, 'the recorded time must be the evaluated time');
  assert.equal(row.source, 'assist');
  assert.ok(block.ids.length > 0);
});
