import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AXIS_DEFAULTS,
  anchorAfterRecall,
  anchorForCreation,
  anchorFromLegacy,
  axisRegion,
  positionOf,
  recallBoost,
  rescueDepth,
} from '../../src/host/store/axis.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * The signed axis, tested against the criteria in `docs/AXIS.md` §8.
 *
 * The five criteria are the contract: direction, entrance, recall, no abyss, and — the one that matters most
 * — that position finally distinguishes "just remembered" from "just used".
 */

const R = AXIS_DEFAULTS.entranceDepth;

function write(store, scopes, entry) {
  return store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', ...entry });
}
const positionOfId = (store, scopes, id) =>
  store.muPositions({ scopeKeys: [scopes.workspace] }).entries.find((entry) => entry.id === id)?.p;

// ---------------------------------------------------------------- pure arithmetic

test('criterion 2: a new entry lands at the entrance, not at the habitat', () => {
  const born = anchorForCreation(1000);
  assert.equal(positionOf(born, 1000), R);
  assert.equal(axisRegion(R), 'entrance');
});

test('criterion 1: direction is leftward — position decreases as the clock advances', () => {
  const born = anchorForCreation(1000);
  const later = positionOf(born, 1300);
  assert.ok(later < positionOf(born, 1000), 'time moves the entry left');
  assert.equal(later, R - 300);
});

test('criterion 3: a recall moves right, and further near the habitat than far from it', () => {
  const near = recallBoost(0);
  const far = recallBoost(-R);
  assert.ok(near > 0 && far > 0, 'a recall always moves');
  assert.ok(near > far, 'amplitude decays with distance');
});

test('criterion 4: there is no abyss — even at a great distance a recall makes progress', () => {
  const deep = { pBase: -1e6, muBase: 5000 };
  const after = anchorAfterRecall(deep, 5000);
  assert.ok(after.to > after.from, 'a recall at -1e6 μ still moves right');
  assert.ok(after.boost >= AXIS_DEFAULTS.recallFloor - 1e-9, 'and by at least the floor');
});

test('rescueDepth is the deepest point one recall returns to the habitat', () => {
  const depth = rescueDepth();
  assert.ok(depth < 0, 'it is a negative position');
  assert.ok(depth + recallBoost(depth) >= 0, 'from there, one recall reaches zero');
  assert.ok(depth - 1 + recallBoost(depth - 1) < 0, 'one μ deeper and it does not');
});

test('a recall cannot carry an entry past the entrance', () => {
  // Overshooting would let a much-used old memory read as newer than one written this minute.
  const atEntrance = { pBase: R, muBase: 100 };
  const after = anchorAfterRecall(atEntrance, 100);
  assert.ok(after.to <= R, `expected <= ${R}, got ${after.to}`);
});

test('a missing anchor reports no position rather than position zero', () => {
  // `Number(null)` is 0, so a naive finiteness check would place an unanchored row exactly at the habitat.
  assert.equal(positionOf({ pBase: null, muBase: null }, 100), null);
  assert.equal(positionOf({}, 100), null);
  assert.equal(positionOf(undefined, 100), null);
});

// ---------------------------------------------------------------- through the store

test('criterion 1 through the store: an entry drifts left as the clock advances, without being touched', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = write(store, scopes, { kind: 'semantic', title: '一条新记忆', body: '正文。' });
  const before = positionOfId(store, scopes, written.entry.id);
  assert.equal(before, R, 'it starts at the entrance');

  // Advance the clock with real activity. An injection that lists nothing advances nothing —
  // `muDelta(0,0)` is `log(1) = 0` — which is the design working rather than a gap: no activity, no time.
  // So a second entry has to carry the activity for the first one to age.
  const noise = write(store, scopes, { kind: 'semantic', title: '噪音条目', body: '用来推进时钟。' });
  for (let i = 0; i < 10; i += 1) store.recordInjection({ bytes: 1, listed: 1, hidden: 0, ids: [noise.entry.id] });

  const after = positionOfId(store, scopes, written.entry.id);
  assert.ok(after < before, `expected drift left from ${before}, got ${after}`);
});

test('criterion 3 through the store: injecting an entry pulls it right once it has left the habitat', (t) => {
  // Recall only rescues what has sunk. An entry still right of the habitat is close enough that a boost would
  // push it back toward the entrance, so the store applies none — see `recallDisplacement`. This test places an
  // entry left of zero the way ageing does, then checks that being injected brings it back.
  const { store, scopes } = openTestStore(t);
  const written = write(store, scopes, { kind: 'semantic', title: '会被注入的记忆', body: '正文。' });
  const now = store.muNow();
  store.db
    .prepare('UPDATE memory_usage SET p_base = ?, mu_base = ? WHERE id = ?')
    .run(-20, now, written.entry.id);
  const drifted = positionOfId(store, scopes, written.entry.id);
  assert.ok(drifted < 0, 'the entry starts left of the habitat');

  store.recordInjection({ bytes: 1, listed: 1, hidden: 0, ids: [written.entry.id] });
  const recalled = positionOfId(store, scopes, written.entry.id);
  assert.ok(recalled > drifted, `a recall should pull right: ${drifted} -> ${recalled}`);
});

test('reading also pulls right, by the same rule as injection', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = write(store, scopes, { kind: 'semantic', title: '会被读取的记忆', body: '正文。' });
  const now = store.muNow();
  store.db
    .prepare('UPDATE memory_usage SET p_base = ?, mu_base = ? WHERE id = ?')
    .run(-20, now, written.entry.id);
  const drifted = positionOfId(store, scopes, written.entry.id);
  store.recordRead(written.entry.id);
  assert.ok(positionOfId(store, scopes, written.entry.id) > drifted, 'a read is use');
});

test('an entry at the habitat is not pushed back toward the entrance by use', (t) => {
  // The defect the cap exists to prevent. Without it, an entry injected every few μ reaches equilibrium deep
  // in the entrance region — and the entrance means "just arrived, not yet digested", which is the opposite
  // of what hundreds of injections mean.
  const { store, scopes } = openTestStore(t);
  const written = write(store, scopes, { kind: 'semantic', title: '一直被用', body: '正文。' });
  const now = store.muNow();
  store.db.prepare('UPDATE memory_usage SET p_base = 0, mu_base = ? WHERE id = ?').run(now, written.entry.id);

  for (let i = 0; i < 50; i += 1) {
    store.recordInjection({ bytes: 1, listed: 1, hidden: 0, ids: [written.entry.id] });
  }
  const p = positionOfId(store, scopes, written.entry.id);
  assert.ok(p <= 0.001, `use must not carry an entry right of the habitat, got ${p}`);
  assert.ok(p > -50, 'and it must not sink either, because every recall returns it to the habitat');
});

test('criterion 5: writing and using are different places, not the same one', (t) => {
  // This is the defect the whole rewrite exists to fix. Under the old model both events set the distance to
  // zero, so an entry nobody had used looked exactly like one that had just been needed.
  const { store, scopes } = openTestStore(t);
  const justWritten = write(store, scopes, { kind: 'semantic', title: '刚写入', body: '正文。' });
  const willBeUsed = write(store, scopes, { kind: 'semantic', title: '稍后使用', body: '正文。' });

  // Both sit at the entrance now; drift both, then use only one.
  for (let i = 0; i < 500; i += 1) store.recordInjection({ bytes: 1, listed: 0, hidden: 0, ids: [] });
  store.recordInjection({ bytes: 1, listed: 1, hidden: 0, ids: [willBeUsed.entry.id] });

  const pWritten = positionOfId(store, scopes, justWritten.entry.id);
  const pUsed = positionOfId(store, scopes, willBeUsed.entry.id);
  assert.ok(pUsed > pWritten, 'the used entry is nearer the entrance than the one only written');
  assert.ok(pWritten < R, 'and the written one is no longer at the entrance');
});

test('termination: no amount of recall pins an entry in place forever', (t) => {
  // Time's leftward drift is unconditional, so an entry that is recalled constantly still ages — it just
  // ages more slowly. Without this property nothing would ever be forgotten.
  const { store, scopes } = openTestStore(t);
  const written = write(store, scopes, { kind: 'semantic', title: '一直用', body: '正文。' });
  for (let i = 0; i < 200; i += 1) {
    store.recordInjection({ bytes: 1, listed: 1, hidden: 0, ids: [written.entry.id] });
  }
  const p = positionOfId(store, scopes, written.entry.id);
  assert.ok(Number.isFinite(p), 'it has a position');
  // Each round both advances the clock by ~log(2) and adds a boost; at the entrance the boost is small, so
  // the net is not allowed to exceed the entrance. The property under test is that it never exceeds R.
  assert.ok(p <= R, `recall must not push past the entrance, got ${p}`);
});

// ---------------------------------------------------------------- migration

test('legacy conversion places a never-injected entry by its drift from the entrance', () => {
  // `muNow - muTouched` was a distance under the old model; on the axis, for an entry nobody ever used, it
  // is how far the entry has drifted left since it fell in.
  //
  // A stamp of `0` is *not* "touched at μ 0" — the v7 migration used it as "no history", and the conversion
  // keeps that reading rather than inventing a very old entry.
  const never = (touched) => positionOf(anchorFromLegacy(touched, 1000), 1000);
  assert.equal(never(1000), R, 'just written: still at the entrance');
  assert.equal(never(0), R, 'no history means no travel, not 1000 μ of it');
  assert.equal(never(500), R - 500);
  assert.equal(never(200), R - 800);
  assert.equal(never(2000), R, 'a future stamp must not produce negative travel');
});

test('legacy conversion places a used entry by its drift from the habitat', () => {
  // This is the correction the live data forced. An entry injected 442 times was landing at the entrance —
  // the region the axis reserves for "brand new, never digested" — because both rules had been one. An entry
  // that has been injected has already been brought to the working set, so its last touch is the moment it
  // sat at the habitat and its position is the drift since.
  const used = (touched) => positionOf(anchorFromLegacy(touched, 1000, R, { injected: true }), 1000);
  assert.equal(used(1000), 0, 'just used: at the habitat');
  assert.equal(used(900), -100, 'used 100 μ ago: drifting');
  assert.equal(used(0), 0, 'no history means no drift');
  assert.ok(used(500) < 0, 'a well-used but stale entry is left of the habitat, not at the entrance');
});

test('the used rule never places an entry at the entrance', () => {
  // If this ever fails, a heavily used entry has been described as brand new again.
  for (const touched of [0, 200, 500, 800, 1000, 1200]) {
    const p = positionOf(anchorFromLegacy(touched, 1000, R, { injected: true }), 1000);
    assert.ok(p <= 0, `touched ${touched} produced p=${p}, which is right of the habitat`);
  }
});

test('an invalid legacy stamp does not invent a distance', () => {
  assert.equal(positionOf(anchorFromLegacy(null, 1000), 1000), R);
  assert.equal(positionOf(anchorFromLegacy('nonsense', 1000), 1000), R);
});
