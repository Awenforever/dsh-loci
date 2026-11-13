import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { effectiveConfig } from '../../src/host/config.js';
import { ensureMemoryRoot, layout } from '../../src/host/paths.js';
import { resolveScopes, selectScope } from '../../src/host/scope.js';
import { Store } from '../../src/host/store/store.js';
import { search } from '../../src/host/store/search.js';
import { openTestStore } from '../helpers.mjs';

const base = (scopes) => {
  const { scope, key, label } = selectScope(scopes, 'workspace');
  return { scope, scopeKey: key, scopeLabel: label };
};

test('writes a candidate when the evidence gate is not satisfied', (t) => {
  const { store, scopes } = openTestStore(t);
  const result = store.write({
    ...base(scopes),
    kind: 'semantic',
    title: '生产机是 prod-01',
    body: '生产机 prod-01 上禁止直接跑迁移脚本，必须先在本项目 staging 演练。',
    evidence: { quote: '在 prod-01 上直接跑迁移' },
  });
  assert.equal(result.created, true);
  assert.equal(result.entry.status, 'candidate');
  assert.equal(result.entry.revision, 1);
  assert.equal(store.indexEntries({ scopeKeys: [scopes.workspace] }).length, 0);
});

test('a user-asserted fact is verified and reaches the index', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    ...base(scopes),
    kind: 'rule',
    trustSource: 'user',
    title: '删除前必须做路径断言',
    body: '任何删除动作之前先校验绝对路径与白名单根，再执行。',
  });
  const index = store.indexEntries({ scopeKeys: [scopes.workspace] });
  assert.equal(index.length, 1);
  assert.equal(index[0].kind, 'rule');
  assert.equal(index[0].title, '删除前必须做路径断言');
});

test('deduplicates an identical fact in the same scope', (t) => {
  const { store, scopes } = openTestStore(t);
  const input = {
    ...base(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '发布顺序',
    body: 'staging → canary 10% → 全量',
  };
  const first = store.write(input);
  const second = store.write(input);
  assert.equal(first.created, true);
  assert.equal(second.deduplicated, true);
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(store.stats().heads, 1);
});

test('a same-title write becomes a new revision and keeps history', (t) => {
  const { store, scopes } = openTestStore(t);
  const first = store.write({
    ...base(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '回滚窗口',
    body: '30 分钟',
  });
  const second = store.write({
    ...base(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '回滚窗口',
    body: '45 分钟，超过就必须人工决策',
  });
  assert.equal(second.created, false);
  assert.equal(second.updated, true);
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(second.entry.revision, 2);
  const fetched = store.get(first.entry.id);
  assert.equal(fetched.history.length, 2);
  assert.equal(fetched.history[0].status, 'superseded');
  assert.equal(fetched.history[0].supersededBy, `${first.entry.id}@2`);
  assert.equal(fetched.history[1].body, undefined, 'history rows must not carry bodies');
  assert.equal(fetched.entry.body, '45 分钟，超过就必须人工决策');
});

test('optimistic revision rejects a stale edit', (t) => {
  const { store, scopes } = openTestStore(t);
  const first = store.write({
    ...base(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '约定',
    body: '第一版',
  });
  assert.throws(
    () => store.update(first.entry.id, { ...base(scopes), kind: 'semantic', title: '约定', body: '第二版', expectedRevision: 9 }),
    /revision/,
  );
});

test('Chinese bigrams recall a fact from a two-character query', async (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    ...base(scopes),
    kind: 'procedural',
    trustSource: 'user',
    title: '数据库迁移流程',
    body: '迁移前先用 pg_dump 做全量备份，把备份路径写进发布记录，然后再执行脚本。',
  });
  store.write({
    ...base(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '无关条目',
    body: '前端主题的按钮圆角是 6px。',
  });
  const result = await search(store, {
    query: '迁移',
    scopeKeys: [scopes.workspace],
    statuses: ['verified'],
    limit: 10,
  });
  assert.equal(result.total, 1);
  assert.equal(result.hits[0].title, '数据库迁移流程');
  assert.ok(result.hits[0].channels.includes('lexical'));
});

test('a long CJK query matches as a phrase, not as scattered bigrams', async (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    ...base(scopes),
    kind: 'rule',
    trustSource: 'user',
    title: '路径断言',
    body: '删除旧索引目录前，必须先做路径断言。',
  });
  store.write({
    ...base(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '另一件事',
    body: '路径很长，断言的手法完全不同，这里只是碰巧有字。',
  });
  const result = await search(store, {
    query: '路径断言',
    scopeKeys: [scopes.workspace],
    statuses: ['verified'],
    limit: 10,
  });
  assert.equal(result.total, 1);
  assert.equal(result.hits[0].title, '路径断言');
});

test('pagination exposes the full result set through total and cursor', async (t) => {
  const { store, scopes } = openTestStore(t);
  for (let i = 0; i < 7; i += 1) {
    store.write({
      ...base(scopes),
      kind: 'procedural',
      trustSource: 'user',
      title: `部署约定 ${i}`,
      body: `第 ${i} 条部署约定：先备份，再发布。`,
    });
  }
  const first = await search(store, { query: '部署约定', scopeKeys: [scopes.workspace], statuses: ['verified'], limit: 3 });
  assert.equal(first.total, 7);
  assert.equal(first.returned, 3);
  assert.equal(first.hasMore, true);
  const second = await search(store, {
    query: '部署约定',
    scopeKeys: [scopes.workspace],
    statuses: ['verified'],
    limit: 3,
    cursor: first.cursor,
  });
  assert.equal(second.returned, 3);
  const third = await search(store, {
    query: '部署约定',
    scopeKeys: [scopes.workspace],
    statuses: ['verified'],
    limit: 3,
    cursor: second.cursor,
  });
  assert.equal(third.returned, 1);
  assert.equal(third.hasMore, false);
  assert.equal(third.cursor, null);
  const ids = new Set([...first.hits, ...second.hits, ...third.hits].map((hit) => hit.id));
  assert.equal(ids.size, 7);
});

test('a changed query invalidates the cursor instead of returning the wrong page', async (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...base(scopes), kind: 'semantic', trustSource: 'user', title: '甲', body: '部署前先备份。' });
  store.write({ ...base(scopes), kind: 'semantic', trustSource: 'user', title: '乙', body: '部署后再校验。' });
  const first = await search(store, { query: '部署', scopeKeys: [scopes.workspace], statuses: ['verified'], limit: 1 });
  const wrong = await search(store, {
    query: '备份',
    scopeKeys: [scopes.workspace],
    statuses: ['verified'],
    limit: 1,
    cursor: first.cursor,
  });
  assert.equal(wrong.error, 'cursor-mismatch');
});

test('scope isolation keeps another workspace invisible', async (t) => {
  const { store, scopes, home } = openTestStore(t);
  const other = resolveScopes({ sessionId: 'session-other', cwd: join(home, 'other-project') });
  store.write({
    scope: 'workspace',
    scopeKey: other.workspace,
    scopeLabel: other.labels.workspace,
    kind: 'semantic',
    trustSource: 'user',
    title: '另一个项目的秘密',
    body: '这条只属于 other-project。',
  });
  const result = await search(store, {
    query: '另一个项目',
    scopeKeys: [scopes.workspace],
    statuses: ['verified'],
    limit: 10,
  });
  assert.equal(result.total, 0);
  const own = await search(store, {
    query: '另一个项目',
    scopeKeys: [other.workspace],
    statuses: ['verified'],
    limit: 10,
  });
  assert.equal(own.total, 1);
});

test('soft delete hides the entry and restore brings it back as a candidate', (t) => {
  const { store, scopes } = openTestStore(t);
  const created = store.write({
    ...base(scopes),
    kind: 'rule',
    trustSource: 'user',
    title: '禁止 rm -rf',
    body: '临时目录清理必须走受控脚本并先 dry-run。',
  });
  assert.equal(store.indexEntries({ scopeKeys: [scopes.workspace] }).length, 1);
  store.forget(created.entry.id, { mode: 'soft', reason: 'test' });
  assert.equal(store.indexEntries({ scopeKeys: [scopes.workspace] }).length, 0);
  store.forget(created.entry.id, { mode: 'restore' });
  assert.equal(store.indexEntries({ scopeKeys: [scopes.workspace] }).length, 0, 'restored entries need re-verification');
  const restored = store.get(created.entry.id).entry;
  assert.equal(restored.status, 'candidate');
});

test('purge requires both the switch and the confirmation', (t) => {
  const { store, scopes } = openTestStore(t);
  const created = store.write({ ...base(scopes), kind: 'semantic', trustSource: 'user', title: 'x', body: 'yy' });
  assert.throws(() => store.forget(created.entry.id, { mode: 'purge', confirm: created.entry.id }), /hard delete is disabled/);
});

test('reindex repairs an interrupted write', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...base(scopes), kind: 'semantic', trustSource: 'user', title: '索引', body: '这条用来检查 FTS 覆盖。' });
  store.db.exec('DELETE FROM memory_fts');
  assert.equal(store.indexCoverage().missing, 1);
  store.reindex();
  assert.equal(store.indexCoverage().missing, 0);
});

test('audit records writes and injections without content', (t) => {
  const { store, scopes } = openTestStore(t);
  const created = store.write({
    ...base(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '审计',
    body: '这条不应出现在 audit 里。',
  });
  store.recordInjection({ sessionId: 'session-test', scopeKey: scopes.workspace, bytes: 123, listed: 1, hidden: 0 });
  const tail = store.auditTail(10);
  const write = tail.find((event) => event.event === 'write');
  assert.equal(write.id, created.entry.id);
  assert.equal(write.bytes > 0, true);
  const text = JSON.stringify(tail);
  assert.equal(text.includes('这条不应出现在 audit 里'), false);
});

test('global scope is never implied by a workspace write', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    scope: 'global',
    scopeKey: scopes.global,
    scopeLabel: 'global',
    kind: 'semantic',
    trustSource: 'user',
    title: '用户偏好中文',
    body: '所有项目都用中文回答。',
  });
  const workspaceOnly = store.indexEntries({ scopeKeys: [scopes.workspace] });
  assert.equal(workspaceOnly.length, 0);
  const withGlobal = store.indexEntries({ scopeKeys: [scopes.workspace, scopes.global] });
  assert.equal(withGlobal.length, 1);
});
