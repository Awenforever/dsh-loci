import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { buildKnowledge } from '../../src/host/store/activity.js';
import { resolveScopes } from '../../src/host/scope.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

test('the card shows what is understood, not what happened', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    ...workspaceFields(scopes),
    kind: 'rule',
    trustSource: 'user',
    title: '回滚窗口是 30 分钟',
    body: '超过 30 分钟必须人工决策。',
  });
  store.write({
    ...workspaceFields(scopes),
    kind: 'procedural',
    trustSource: 'user',
    title: '删除前先做路径断言',
    body: '因为上次裸变量带空格被拆成多参数，删错了目录。',
  });
  // An unconfirmed entry must not appear: the card is about understanding, not
  // about activity.
  store.write({
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'summary',
    title: '模型自己总结的一条',
    body: '没有任何证据。',
  });

  const knowledge = buildKnowledge(store, { scopeKeys: [scopes.workspace] });
  assert.equal(knowledge.items.length, 2, 'only verified entries are notes');
  assert.equal(knowledge.pending, 1, 'the candidate is mentioned as a count, not as a note');

  const rule = knowledge.items.find((item) => item.kind === 'rule');
  assert.equal(rule.title, '回滚窗口是 30 分钟');
  assert.equal(rule.gist, '超过 30 分钟必须人工决策', 'the gist is the fact sentence without its stop');
  assert.ok(Number.isFinite(rule.at), 'a note carries the moment it became true');

  const lesson = knowledge.items.find((item) => item.kind === 'procedural');
  assert.match(lesson.gist, /裸变量/);
});

test('a note does not repeat its title as its gist', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '生产机是 prod-01',
    body: '生产机是 prod-01。禁止直接跑迁移。',
  });
  const knowledge = buildKnowledge(store, { scopeKeys: [scopes.workspace] });
  assert.equal(knowledge.items[0].gist, null, 'restating the title reads worse than the title alone');
});

test('knowledge is scoped, and the newest understanding comes first', (t) => {
  const { store, scopes, home } = openTestStore(t);
  const older = store.write({
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '本项目的约定',
    body: '本项目的约定的正文说明。',
  });
  store.write({
    'scope': 'global',
    scopeKey: 'global:',
    scopeLabel: 'global',
    kind: 'semantic',
    trustSource: 'user',
    title: '全局偏好',
    body: '全局偏好的正文说明。',
  });
  const elsewhere = resolveScopes({ sessionId: 'x', cwd: join(home, 'elsewhere') });
  store.write({
    scope: 'workspace',
    scopeKey: elsewhere.workspace,
    scopeLabel: elsewhere.labels.workspace,
    kind: 'semantic',
    trustSource: 'user',
    title: '别的项目的事',
    body: '别的项目的事的正文说明。',
  });

  const knowledge = buildKnowledge(store, { scopeKeys: [scopes.workspace, 'global:'] });
  const titles = knowledge.items.map((item) => item.title);
  assert.ok(titles.includes('本项目的约定'));
  assert.ok(titles.includes('全局偏好'));
  assert.equal(titles.includes('别的项目的事'), false, 'another workspace must not appear');

  // Confirming an older entry today is newer knowledge than something written a
  // moment ago: the card orders by when it became trustworthy.
  store.setTrust(older.entry.id, 'verified', { actor: 'panel' });
  const after = buildKnowledge(store, { scopeKeys: [scopes.workspace, 'global:'] });
  assert.equal(after.items[0].title, '本项目的约定', 'a fresh confirmation rises to the top');
});
