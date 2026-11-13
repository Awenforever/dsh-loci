import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIRM_ALL } from '../../src/host/store/store.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

test('forget-all refuses to run without the confirmation phrase', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: '一条事实', body: '正文。' });
  assert.throws(() => store.forgetAll({}), /requires confirm/);
  assert.throws(() => store.forgetAll({ confirm: 'yes' }), /requires confirm/);
  assert.equal(store.stats().heads, 1, 'a refused call changes nothing');
});

test('forget-all soft-deletes every entry and keeps the history readable', (t) => {
  const { store, scopes } = openTestStore(t);
  for (let i = 0; i < 3; i += 1) {
    store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: `事实 ${i}`, body: `正文 ${i}。` });
  }
  const result = store.forgetAll({ confirm: CONFIRM_ALL, actor: 'panel' });
  assert.equal(result.count, 3);
  assert.equal(store.stats().heads >= 0, true);
  const live = store.db.prepare("SELECT COUNT(*) AS n FROM memory_head WHERE status <> 'deleted'").get();
  assert.equal(Number(live.n), 0, 'nothing is left in an injectable state');
  const reversible = store.db.prepare('SELECT COUNT(*) AS n FROM memory').get();
  assert.ok(Number(reversible.n) >= 3, 'soft delete keeps the rows, so recovery is possible');
});

test('forget-all purge needs allowHardDelete as well as the phrase', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: '一条事实', body: '正文。' });
  assert.throws(() => store.forgetAll({ confirm: CONFIRM_ALL, mode: 'purge' }), /hard delete is disabled/);
  const { store: permissive, scopes: otherScopes } = openTestStore(t, { allowHardDelete: true });
  permissive.write({ ...workspaceFields(otherScopes), kind: 'semantic', trustSource: 'user', title: '一条事实', body: '正文。' });
  const result = permissive.forgetAll({ confirm: CONFIRM_ALL, mode: 'purge' });
  assert.equal(result.count, 1);
  assert.equal(permissive.db.prepare('SELECT COUNT(*) AS n FROM memory').get().n, 0);
});

test('forget-all can be limited to one scope', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: '本项目的', body: '正文。' });
  store.write({ scope: 'global', scopeKey: 'global:', scopeLabel: 'global', kind: 'semantic', trustSource: 'user', title: '全局的', body: '正文。' });

  assert.throws(() => store.forgetAll({ confirm: CONFIRM_ALL, scopeKey: scopes.workspace }), /requires confirm/);
  const result = store.forgetAll({ confirm: `forget ${scopes.workspace}`, scopeKey: scopes.workspace });
  assert.equal(result.count, 1);
  const left = store.db
    .prepare("SELECT title FROM memory WHERE status <> 'deleted' AND valid_to IS NULL")
    .all()
    .map((row) => row.title);
  assert.deepEqual(left, ['全局的'], 'the other scope survives');
});
