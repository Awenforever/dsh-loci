import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/** Two near-duplicate entries in one scope. */
function twoDuplicates(store, scopes) {
  const first = store.write({
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '回滚窗口 30 分钟',
    body: '超过 30 分钟必须人工决策。',
    tags: ['发布'],
    entities: ['发布流程'],
  });
  const second = store.write({
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '回滚时间三十分钟',
    body: '回滚超过 30 分钟要走人工评审。',
    tags: ['运维'],
    entities: ['回滚'],
  });
  return { first: first.entry, second: second.entry };
}

test('merge supersedes the sources instead of deleting them', (t) => {
  const { store, scopes } = openTestStore(t);
  const { first, second } = twoDuplicates(store, scopes);

  const result = store.merge({ targetId: first.id, sourceIds: [second.id], actor: 'panel' });

  assert.equal(result.entry.id, first.id);
  assert.deepEqual(result.merged, [second.id]);

  const target = store.get(first.id).entry;
  assert.deepEqual(target.tags.sort(), ['发布', '运维'].sort(), 'tags are unioned');
  // Entities are mapped objects, not bare strings.
  assert.deepEqual(
    target.entities.map((entity) => entity.name).sort(),
    ['发布流程', '回滚'].sort(),
    'entities are unioned',
  );

  // The source keeps its history and remains fetchable, but is out of the index.
  const source = store.get(second.id);
  assert.equal(source.entry.status, 'superseded');
  assert.equal(source.entry.supersededBy, `${first.id}@${result.entry.revision}`);

  const injected = store.indexEntries({ scopeKeys: [scopes.workspace] }).map((entry) => entry.id);
  assert.deepEqual(injected, [first.id], 'only the target is still injected');
});

test('merge is one atomic step: a bad id changes nothing', (t) => {
  const { store, scopes } = openTestStore(t);
  const { first, second } = twoDuplicates(store, scopes);
  const before = store.stats().heads;

  assert.throws(() => store.merge({ targetId: first.id, sourceIds: [second.id, 'm_missing'] }), /not found|missing/i);
  assert.equal(store.stats().heads, before);
  assert.equal(store.get(second.id).entry.status, 'verified', 'the valid source was not touched');
});

test('merge refuses to list the target as its own source', (t) => {
  const { store, scopes } = openTestStore(t);
  const { first } = twoDuplicates(store, scopes);
  assert.throws(() => store.merge({ targetId: first.id, sourceIds: [first.id] }), /own source/);
});

test('a stale expected revision aborts the merge before any write', (t) => {
  const { store, scopes } = openTestStore(t);
  const { first, second } = twoDuplicates(store, scopes);

  assert.throws(
    () => store.merge({ targetId: first.id, sourceIds: [second.id], expectedRevisions: [99, 1] }),
    /revision/i,
  );
  assert.equal(store.get(second.id).entry.status, 'verified');
});

test('merging with new text re-opens verification', (t) => {
  const { store, scopes } = openTestStore(t);
  const { first, second } = twoDuplicates(store, scopes);

  const merged = store.merge({
    targetId: first.id,
    sourceIds: [second.id],
    title: '回滚窗口 30 分钟',
    body: '回滚窗口是 30 分钟；超过必须人工评审。',
  });
  assert.equal(merged.entry.status, 'candidate', 'a rewritten entry must earn trust again');
  assert.equal(store.indexEntries({ scopeKeys: [scopes.workspace] }).length, 0);
});

test('merge writes one audit line naming both sides', (t) => {
  const { store, scopes } = openTestStore(t);
  const { first, second } = twoDuplicates(store, scopes);
  store.merge({ targetId: first.id, sourceIds: [second.id], actor: 'panel' });

  const line = store.auditTail(50).filter((event) => event.event === 'merge').at(-1);
  assert.ok(line, 'a merge must be auditable');
  assert.equal(line.targetId, first.id);
  assert.deepEqual(line.sources, [second.id]);
});
