import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findDuplicateGroups, similarity, SIMILARITY_THRESHOLD } from '../../src/host/store/duplicates.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

test('similarity catches a restated sentence and rejects an unrelated one', () => {
  assert.ok(similarity('删除前必须做路径断言', '删除前先做路径断言') >= SIMILARITY_THRESHOLD);
  assert.ok(similarity('不要用 sleep 写测试', '写测试时不要用 sleep') >= SIMILARITY_THRESHOLD);
  assert.ok(similarity('生产机不跑迁移', '发布顺序 staging 先行') < 0.2);
  assert.equal(similarity('', 'x'), 0);
});

test('findDuplicateGroups reports a verified pair and ignores candidates', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    ...workspaceFields(scopes),
    kind: 'rule',
    trustSource: 'user',
    title: '删除前必须做路径断言',
    body: '任何删除动作之前先校验绝对路径。',
  });
  store.write({
    ...workspaceFields(scopes),
    kind: 'rule',
    trustSource: 'user',
    title: '删除前先做路径断言',
    body: '删除动作之前先校验绝对路径与白名单。',
  });
  // A candidate that looks identical must not be reported: it is not injected yet,
  // so merging it would be advice about a phantom.
  store.write({
    ...workspaceFields(scopes),
    kind: 'rule',
    trustSource: 'summary',
    title: '删除前必须做路径断言',
    body: '这条是候选。',
  });

  const result = findDuplicateGroups(store);
  assert.equal(result.scanned, 2, 'only verified heads are scanned');
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].titles.length, 2);
  assert.ok(result.groups[0].similarity >= SIMILARITY_THRESHOLD);
});

test('findDuplicateGroups stays quiet on a clean store', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: '回滚窗口 30 分钟', body: '超过必须人工决策。' });
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: '发布顺序', body: 'staging → canary → 全量。' });
  const result = findDuplicateGroups(store);
  assert.deepEqual(result.groups, []);
  assert.equal(result.scanned, 2);
});

test('the scan is bounded and the report is capped', (t) => {
  const { store, scopes } = openTestStore(t);
  for (let i = 0; i < 12; i += 1) {
    // Twelve entries that are all near-copies of one another: 66 possible pairs.
    store.write({
      ...workspaceFields(scopes),
      kind: 'rule',
      trustSource: 'user',
      title: `删除前必须做路径断言 ${i}`,
      body: '任何删除动作之前先校验绝对路径。',
    });
  }
  const result = findDuplicateGroups(store, { limit: 3 });
  assert.equal(result.groups.length, 3, 'the report is capped');
  assert.ok(result.scanned <= 2000);
});

test('the doctor surfaces duplicates as a warning, not a failure', async (t) => {
  const { store, scopes, paths } = openTestStore(t);
  const { runDoctor } = await import('../../src/host/doctor.js');
  const { effectiveConfig } = await import('../../src/host/config.js');

  store.write({
    ...workspaceFields(scopes),
    kind: 'rule',
    trustSource: 'user',
    title: '删除前必须做路径断言',
    body: '任何删除动作之前先校验绝对路径。',
  });
  store.write({
    ...workspaceFields(scopes),
    kind: 'rule',
    trustSource: 'user',
    title: '删除前先做路径断言',
    body: '删除动作之前先校验绝对路径与白名单。',
  });

  const report = runDoctor({ store, paths, config: effectiveConfig({}) });
  const row = report.checks.find((check) => check.name === 'duplicates');
  assert.ok(row, 'the doctor prints a duplicates row');
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /near-duplicate/);
  assert.notEqual(report.status, 'fail', 'a duplicate is advice, not a fault');
});
