import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeSliceMessage, composeStable } from '../../src/host/recall/compose.js';
import { DEFAULTS } from '../../src/host/config.js';
import { deriveBandEdges, muBand, muDelta, quantile } from '../../src/host/store/mu.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * The memory unit, and the three constraints it imposes.
 *
 * There is no independent notion of time in this store: MU *is* time, and "older" may only mean
 * "further from the working set in MU". These tests are the ones that would have caught the system
 * this replaced, where memory expired because the calendar advanced and ordering preferred the newest
 * row over the most useful one.
 */

test('the counter does not move when nothing happens', (t) => {
  const { store } = openTestStore(t);
  const before = store.muNow();
  assert.equal(before, 0, 'a fresh store starts at zero');
  // Nothing is written, nothing is injected, nothing is read: this is the night the user slept.
  assert.equal(store.muNow(), 0);
  assert.deepEqual(store.muTrail(), [], 'and the trail is empty, so there is no story to tell');
});

test('a write advances the clock by exactly the growth component', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', kind: 'semantic', title: 'a', body: 'b' });
  const after = store.muNow();
  assert.ok(Math.abs(after - muDelta(1, 0)) < 1e-9, `expected log(2), got ${after}`);
  const trail = store.muTrail(5);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].reason, 'write');
  assert.equal(trail[0].add, 1);
  assert.equal(trail[0].use, 0);
});

test('use advances it too, and the two weights are honoured', (t) => {
  const { store, scopes } = openTestStore(t, { muAddWeight: 2, muUseWeight: 3 });
  store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', kind: 'semantic', title: 'a', body: 'b' });
  const afterWrite = store.muNow();
  assert.ok(Math.abs(afterWrite - muDelta(1, 0, 2, 3)) < 1e-9, 'w_add applies');
  store.recordInjection({ bytes: 10, listed: 1, hidden: 0, ids: [] });
  assert.ok(Math.abs(store.muNow() - afterWrite) < 1e-9, 'an injection with no ids is not activity');
});

test('the functions are monotone and the log never produces free time', () => {
  assert.equal(muDelta(0, 0), 0);
  assert.ok(muDelta(1, 0) > 0);
  assert.ok(muDelta(10, 0) > muDelta(1, 0));
  // The hundredth event costs less than the first: this is what keeps a large intake from accelerating
  // the ageing of everything already stored.
  assert.ok(muDelta(100, 0) - muDelta(99, 0) < muDelta(1, 0) - muDelta(0, 0));
});

test('bands are ordered and cover every distance', () => {
  assert.equal(muBand(0), 'fresh');
  assert.equal(muBand(5), 'active');
  assert.equal(muBand(50), 'cool');
  assert.equal(muBand(500), 'cold');
});

test('C1: nothing expires because the calendar advanced', (t) => {
  const { store, scopes } = openTestStore(t);
  // Both a working entry and a candidate, dated ten years back in wall clock.
  const tenYearsAgo = Date.now() - 10 * 365 * 86_400_000;
  store.write({ ...workspaceFields(scopes), status: 'candidate', trustSource: 'tool', kind: 'working', title: 'old working', body: 'x', validFrom: tenYearsAgo });
  store.write({ ...workspaceFields(scopes), status: 'candidate', trustSource: 'tool', kind: 'semantic', title: 'old candidate', body: 'y', validFrom: tenYearsAgo });
  store.db.prepare('UPDATE memory SET created_at = ?').run(tenYearsAgo);

  const summary = store.maintenance();
  assert.equal(summary.expiredWorking, 0, 'retirement is off by default, so nothing is retired');
  assert.equal(summary.closedCandidates, 0);
  const live = store.db.prepare('SELECT COUNT(*) AS n FROM memory WHERE valid_to IS NULL').get().n;
  assert.equal(live, 2, 'both entries survive a decade of wall clock, because no wall clock was consulted');
});

test('C2: ordering prefers the used entry over the newer one', (t) => {
  const { store, scopes } = openTestStore(t);
  const used = store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', kind: 'semantic', title: 'deploy 灰度窗口', body: '同一个问题。' });
  const fresh = store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', kind: 'semantic', title: 'deploy 灰度窗口', body: '同一个问题。' });
  // Push the clock forward, then record a read of the older one: use must win over write order.
  store.recordInjection({ bytes: 1, listed: 2, hidden: 0, ids: [used.entry.id, fresh.entry.id] });
  store.recordRead(used.entry.id);
  const p = store.muPositions({ scopeKeys: [scopes.workspace] });
  const of = (id) => p.entries.find((entry) => entry.id === id).p;
  assert.ok(of(used.entry.id) <= of(fresh.entry.id), 'the read entry is no further away than the untouched one');
  assert.deepEqual(Object.keys(p.bands).sort(), ['active', 'cold', 'cool', 'fresh']);
});

test('C3: the prompt states MU distances and never a calendar date', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', kind: 'rule', title: '删除前做断言', body: '先校验路径。' });
  store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', kind: 'semantic', title: 'atlas 的回滚窗口是三十分钟', body: '超过就升级。' });

  const stable = composeStable({ store, scopeKeys: [scopes.workspace], scopeLabel: scopes.labels.workspace });
  const slice = composeSliceMessage({ store, scopeKeys: [scopes.workspace], scopeLabel: scopes.labels.workspace, query: 'atlas 的回滚窗口多久？' });
  for (const [name, text] of [['stable', stable.text], ['slice', slice.text]]) {
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/, `${name} must carry no calendar date`);
    assert.match(text, /MU/, `${name} must state that ages are in memory units`);
  }
  assert.match(slice.text, /MU ago|now/, 'a line carries a distance');
  assert.match(stable.text, /units of work, not dates/, 'and the unit is explained once');
});

test('the defaults keep retirement off and both weights neutral', () => {
  assert.equal(DEFAULTS.muRetireAfter, 0, 'a threshold must come from a measured distribution, not a guess');
  assert.equal(DEFAULTS.muAddWeight, 1);
  assert.equal(DEFAULTS.muUseWeight, 1);
  assert.equal(DEFAULTS.workingTtlDays, 0, 'wall-clock expiry is gone');
  assert.equal(DEFAULTS.candidateTtlDays, 0);
});

test('the same entry reports the same age in the core and in the slice', (t) => {
  // Shipped once with two different answers: the core joined `memory_usage` and found the real stamp,
  // while the slice's candidate query selected `updated_at` and left `mu_touched` undefined, so every
  // sliced entry read as "as far away as the clock has ever got". One entry, two ages, in one prompt.
  const { store, scopes } = openTestStore(t);
  store.write({
    ...workspaceFields(scopes),
    status: 'verified',
    trustSource: 'user',
    kind: 'rule',
    title: '删除前做断言',
    body: '先校验路径。',
  });
  // Age the clock so a real distance exists rather than a zero that hides the bug.
  for (let i = 0; i < 5; i += 1) {
    store.recordInjection({ bytes: 1, listed: 1, hidden: 0, ids: [] });
  }
  const stable = composeStable({ store, scopeKeys: [scopes.workspace], scopeLabel: 'x' });
  const slice = composeSliceMessage({
    store,
    scopeKeys: [scopes.workspace],
    scopeLabel: 'x',
    query: '删除前做断言',
  });
  const ageIn = (text) => (text.match(/·\s(now|\d+(?:\.\d+)? MU ago)\s·/) ?? [])[0];
  const coreAge = ageIn(stable.text);
  const sliceAge = ageIn(slice.text);
  assert.ok(coreAge !== undefined, 'the core states an age');
  assert.ok(sliceAge !== undefined, 'the slice states an age');
  // Both entries are the same row and neither has been injected, so both must read the same distance.
  assert.equal(coreAge.trim(), sliceAge.trim(), 'one entry must not carry two ages');
});

// ---------------------------------------------------------------- band calibration, from real data
//
// The live store forced two corrections. First, `mu_touched = 0` means "no MU history" rather than
// "touched at MU zero": the v7 migration stamped existing rows with the counter's starting value, so
// they sit at p = muNow and dominate every high percentile while saying nothing about age — counting
// them turned 7 cool entries into 12. Second, edges derived from the distribution are only meaningful
// on entries that were actually observed.

test('quantile interpolates instead of snapping to an element', () => {
  const sorted = [0, 10, 20, 30];
  assert.equal(quantile(sorted, 0), 0);
  assert.equal(quantile(sorted, 1), 30);
  assert.equal(quantile(sorted, 0.5), 15);
  assert.equal(quantile(sorted, 0.25), 7.5);
  assert.equal(quantile([], 0.5), 0);
});

test('band edges are derived from the observed distribution once there are enough samples', () => {
  const distances = Array.from({ length: 40 }, (_, index) => index * 5);
  const edges = deriveBandEdges(distances);
  assert.equal(edges.derived, true);
  assert.ok(edges.fresh > 40 && edges.fresh < 60, `fresh was ${edges.fresh}`);
  assert.ok(edges.active > edges.fresh * 1.4, 'active stays above fresh');
  assert.ok(edges.cool > edges.active * 1.4, 'cool stays above active');
});

test('too few samples fall back to the fixed edges rather than describing the sample', () => {
  const edges = deriveBandEdges(Array.from({ length: 16 }, (_, index) => index * 5));
  assert.equal(edges.derived, false);
  assert.deepEqual([edges.fresh, edges.active, edges.cool], [5, 50, 500]);
});

test('entries with no MU history are counted apart and kept out of the bands', (t) => {
  const { store, scopes } = openTestStore(t);
  const touched = store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', kind: 'semantic', title: 'a', body: 'b' });
  const untouched = store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', kind: 'semantic', title: 'c', body: 'd' });
  for (let i = 0; i < 5; i += 1) store.recordInjection({ bytes: 1, listed: 0, hidden: 0, ids: [] });
  store.recordInjection({ bytes: 1, listed: 1, hidden: 0, ids: [touched.entry.id] });
  store.db.prepare('UPDATE memory_usage SET mu_touched = 0 WHERE id = ?').run(untouched.entry.id);

  const positions = store.muPositions({ scopeKeys: [scopes.workspace] });
  assert.equal(positions.untracked, 1, 'the untouched entry is reported apart');
  const counted = positions.bands.fresh + positions.bands.active + positions.bands.cool + positions.bands.cold;
  assert.equal(counted, 1, 'bands describe only entries that were observed');
});

test('retirement is not derived from the band edges', () => {
  assert.equal(DEFAULTS.muRetireAfter, 0);
  assert.equal(DEFAULTS.muBandEdges, 'auto');
  const edges = deriveBandEdges(Array.from({ length: 40 }, (_, index) => index * 5));
  assert.equal(Object.keys(edges).includes('retire'), false, 'the derivation has no opinion on retirement');
});
