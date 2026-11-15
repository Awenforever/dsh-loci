import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RELATIONS } from '../../src/host/store/store.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * A correction is rarely a full replacement. "The rollback window is 45 minutes now,
 * but database changes still get 30" contradicts the old entry on one clause and
 * agrees on another. Superseding it destroys the part that is still true, so both
 * facts have to stay readable and the disagreement has to be visible.
 */
function writeRule(store, scopes, title, body, extra = {}) {
  return store.write({ ...workspaceFields(scopes), kind: 'rule', trustSource: 'user', title, body, ...extra });
}

test('only conflicts and extends may be declared by a caller', () => {
  assert.deepEqual([...RELATIONS].sort(), ['conflicts', 'extends']);
});

test('a declared conflict is stored as an edge and survives a read', (t) => {
  const { store, scopes } = openTestStore(t);
  const old = writeRule(store, scopes, '回滚窗口 30 分钟', '超过 30 分钟必须人工决策。');
  const updated = writeRule(store, scopes, '回滚窗口 45 分钟', '回滚 45 分钟，但数据库变更仍是 30 分钟。', {
    relations: [{ id: old.entry.id, relation: 'conflicts' }],
  });

  const fetched = store.get(updated.entry.id);
  const conflicts = fetched.edges.filter((edge) => edge.relation === 'conflicts');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].dst_id, old.entry.id);
  // The old entry is still reachable: a conflict is not a deletion.
  assert.equal(store.get(old.entry.id).entry.status, 'verified');
});

test('an extension leaves both entries verified and injectable', (t) => {
  const { store, scopes } = openTestStore(t);
  const base = writeRule(store, scopes, '删除前做路径断言', '任何删除前校验绝对路径。');
  writeRule(store, scopes, '删除还要求白名单', '除路径断言外，目标必须在白名单根内。', {
    relations: [{ id: base.entry.id, relation: 'extends' }],
  });
  const injected = store.indexEntries({ scopeKeys: [scopes.workspace] });
  assert.equal(injected.length, 2, 'an extension does not demote the entry it extends');
});

test('a relation does not raise trust: a candidate stays a candidate', (t) => {
  const { store, scopes } = openTestStore(t);
  const base = writeRule(store, scopes, '已核实的一条', '正文。');
  const candidate = store.write({
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'tool',
    title: '模型写的',
    body: '没有引文。',
    relations: [{ id: base.entry.id, relation: 'extends' }],
  });
  assert.equal(candidate.entry.status, 'candidate');
  assert.equal(store.indexEntries({ scopeKeys: [scopes.workspace] }).length, 1);
});

test('unknown relations, self references and missing targets are ignored, not fatal', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = writeRule(store, scopes, '带一堆坏关系的一条', '正文。', {
    relations: [
      { id: 'm_does_not_exist', relation: 'conflicts' },
      { id: 'who_knows', relation: 'supersedes' },
      null,
      { id: 'x' },
    ],
  });
  const edges = store.get(written.entry.id).edges.filter(
    (edge) => edge.relation === 'conflicts' || edge.relation === 'extends',
  );
  assert.deepEqual(edges, []);
});

test('a self reference is refused', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = writeRule(store, scopes, '自指', '正文。');
  // Re-write with a relation pointing at itself.
  store.update(written.entry.id, {
    ...workspaceFields(scopes),
    kind: 'rule',
    trustSource: 'user',
    title: '自指',
    body: '正文二。',
    relations: [{ id: written.entry.id, relation: 'conflicts' }],
  });
  const edges = store.get(written.entry.id).edges.filter((edge) => edge.relation === 'conflicts' && edge.src_id === edge.dst_id);
  assert.deepEqual(edges, []);
});
