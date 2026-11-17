import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPACT_LEVELS, compactFlag, levelFor, planCompaction, shortenBody } from '../../src/host/store/compact.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * Compaction: a memory loses detail as it travels left.
 *
 * The property that matters most is **losslessness**: the shortened text must be a new revision, with the
 * original still readable. A compression that destroys the source is not compression, it is deletion with
 * extra steps.
 */

const R = 400;
const LONG =
  '验收必须亲自截图确认实际效果通过后才允许结束。截图要包含完整界面，不能只截局部。如果界面有滚动，需要滚到底部再截一张。所有新增按钮都要在截图里可见。';

test('level follows position, and only ever rises as the entry travels left', () => {
  const positions = [400, 300, 200, 140, 100, 50, 20, 0, -100, -200, -240, -300, -2000];
  const levels = positions.map((p) => levelFor(p, R));
  for (let i = 1; i < levels.length; i += 1) {
    assert.ok(levels[i] >= levels[i - 1], `level must not fall: p=${positions[i]} gave ${levels[i]} after ${levels[i - 1]}`);
  }
  assert.equal(levelFor(400, R), 0, 'still arriving: untouched');
  assert.equal(levelFor(-300, R), 3, 'past the compression region: a mote');
});

test('shortening is monotone: a harder level is never longer', () => {
  // The first version shared one character floor across levels, so level 3 could keep a whole short sentence and
  // come out longer than level 2 had cut it — a memory apparently growing as it aged.
  const bodies = [LONG, '只有一句话。', '这是一个很长的单句没有任何标点符号所以只能硬截断而且它确实非常非常长需要被截掉一部分才符合压缩的要求因为我们希望它变短'];
  for (const body of bodies) {
    const lengths = [0, 1, 2, 3].map((level) => shortenBody(body, level).length);
    for (let i = 1; i < lengths.length; i += 1) {
      assert.ok(lengths[i] <= lengths[i - 1], `L${i} (${lengths[i]}) must not exceed L${i - 1} (${lengths[i - 1]})`);
    }
  }
});

test('level 0 returns the body untouched', () => {
  assert.equal(shortenBody(LONG, 0), LONG);
  assert.deepEqual(Object.keys(COMPACT_LEVELS[0]).includes('mark'), true);
});

test('a body that cannot be shortened is not reported as compacted', () => {
  // Recording a level that changed nothing would make the axis claim work that never happened.
  const plan = planCompaction({ body: '短。', position: -300, compactLevel: 0 }, R);
  assert.equal(plan.changed, false);
  assert.equal(plan.level, 0);
});

test('a plan never lowers the level it found', () => {
  const plan = planCompaction({ body: LONG, position: 400, compactLevel: 2 }, R);
  assert.equal(plan.changed, false, 'an entry at the entrance is not compacted further');
  assert.equal(plan.level, 2, 'and it does not regain the detail it already lost');
});

test('the flag names the level so degradation is visible, not inferred', () => {
  assert.equal(compactFlag(0), null);
  assert.equal(compactFlag(1), 'compacted-digested');
  assert.equal(compactFlag(3), 'compacted-mote');
  assert.equal(compactFlag(99), null);
});

// ---------------------------------------------------------------- through the store

test('maintenance compacts a sunken entry and keeps the original as an older revision', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = store.write({
    ...workspaceFields(scopes),
    status: 'verified',
    trustSource: 'user',
    kind: 'rule',
    title: '验收规则',
    body: LONG,
  });
  // Put it far into the compression region, where level 3 applies.
  const now = store.muNow();
  store.db.prepare('UPDATE memory_usage SET p_base = ?, mu_base = ? WHERE id = ?').run(-300, now, written.entry.id);

  const summary = store.maintenance({});
  assert.ok(summary.compacted >= 1, `expected at least one compaction, got ${JSON.stringify(summary)}`);

  const head = store.db
    .prepare('SELECT revision, body, compact_level, flags FROM memory WHERE id = ? ORDER BY revision DESC LIMIT 1')
    .get(written.entry.id);
  assert.ok(head.body.length < LONG.length, 'the stored body is shorter');
  assert.ok(head.compact_level >= 2, `expected a deep level, got ${head.compact_level}`);
  assert.match(head.flags, /compacted-/, 'and it says so in its flags');

  const original = store.db
    .prepare('SELECT body FROM memory WHERE id = ? ORDER BY revision ASC LIMIT 1')
    .get(written.entry.id);
  assert.equal(original.body, LONG, 'the original text is still there as an older revision');
});

test('a second maintenance pass does not compact the same entry again', (t) => {
  // Deterministic shortening means a re-run must be a no-op; otherwise maintenance would slowly erode every
  // entry on a timer, which is exactly the "silently deleting on a schedule" failure the project already fixed.
  const { store, scopes } = openTestStore(t);
  const written = store.write({
    ...workspaceFields(scopes),
    status: 'verified',
    trustSource: 'user',
    kind: 'rule',
    title: '重复压缩检查',
    body: LONG,
  });
  const now = store.muNow();
  store.db.prepare('UPDATE memory_usage SET p_base = ?, mu_base = ? WHERE id = ?').run(-300, now, written.entry.id);

  store.maintenance({});
  const afterFirst = store.db
    .prepare('SELECT revision, body FROM memory WHERE id = ? ORDER BY revision DESC LIMIT 1')
    .get(written.entry.id);
  store.maintenance({});
  const afterSecond = store.db
    .prepare('SELECT revision, body FROM memory WHERE id = ? ORDER BY revision DESC LIMIT 1')
    .get(written.entry.id);

  assert.equal(afterSecond.revision, afterFirst.revision, 'the revision did not advance');
  assert.equal(afterSecond.body, afterFirst.body, 'and the text is identical');
});

test('a freshly written entry is left alone', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = store.write({
    ...workspaceFields(scopes),
    status: 'verified',
    trustSource: 'user',
    kind: 'rule',
    title: '新条目',
    body: LONG,
  });
  store.maintenance({});
  const row = store.db
    .prepare('SELECT revision, body, compact_level FROM memory WHERE id = ? ORDER BY revision DESC LIMIT 1')
    .get(written.entry.id);
  assert.equal(row.revision, 1, 'no new revision');
  assert.equal(row.body, LONG, 'text intact');
  assert.equal(row.compact_level, 0);
});
