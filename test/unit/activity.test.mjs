import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, UpdateChecker } from '../../src/host/update.js';
import { buildActivity } from '../../src/host/store/activity.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

test('version comparison orders prereleases below their release', () => {
  assert.ok(compareVersions('1.0.0', '1.0.1') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') > 0, 'a release is newer than its prerelease');
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.2') < 0, 'a prerelease is older than the release');
  assert.ok(compareVersions('1.9.9', '2.0.0') > 0);
  assert.ok(compareVersions('2.0.0', '2.0.0') === 0);
});

test('the update checker caches, never throws, and reports unknown offline', async () => {
  let calls = 0;
  const checker = new UpdateChecker({
    currentVersion: '1.0.0',
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ version: '1.2.0' }) };
    },
  });
  assert.equal(checker.installed().updateAvailable, false);
  const first = await checker.check();
  assert.equal(first.latestVersion, '1.2.0');
  assert.equal(first.updateAvailable, true);
  assert.equal(first.status, 'ok');
  await checker.check();
  assert.equal(calls, 1, 'the second call inside the cache window must not touch the network');

  // A thrown fetch is "unknown"; a 404 for our own package is "not published".
  const offline = new UpdateChecker({
    currentVersion: '1.0.0',
    fetchImpl: async () => {
      throw new Error('ENOTFOUND');
    },
  });
  const answer = await offline.check();
  assert.equal(answer.latestVersion, null);
  assert.equal(answer.updateAvailable, false);
  assert.equal(answer.status, 'unavailable', 'offline is "unknown", not an error the UI must surface');

  const unpublished = new UpdateChecker({
    currentVersion: '1.0.0',
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  const missing = await unpublished.check();
  assert.equal(missing.status, 'unpublished', 'a 404 for our own package is a fact, not a broken network');

  const noFetch = new UpdateChecker({ currentVersion: '1.0.0', fetchImpl: null });
  const idle = await noFetch.check();
  assert.equal(idle.status, 'unavailable');
});

test('the activity feed names what changed without exposing bodies', (t) => {
  const { store, scopes } = openTestStore(t);
  const created = store.write({
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '发布顺序',
    body: 'staging → canary → 全量。这段正文不应该出现在动态里。',
  });
  store.update(created.entry.id, {
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '发布顺序',
    body: 'staging → canary 10% → 全量，任一步失败立即停止。',
  });
  store.setTrust(created.entry.id, 'verified', { actor: 'panel' });
  store.forget(created.entry.id, { mode: 'soft', reason: '过期' });

  const activity = buildActivity(store, { limit: 20 });
  const actions = activity.items.map((item) => item.action);
  assert.ok(actions.includes('added'), `actions: ${actions.join(',')}`);
  assert.ok(actions.includes('revised'), 'the second write must read as a revision');
  assert.ok(actions.includes('verified'));
  assert.ok(actions.includes('deleted'));

  const added = activity.items.find((item) => item.action === 'added');
  assert.equal(added.title, '发布顺序');
  assert.equal(added.id, created.entry.id);
  assert.ok(Number.isFinite(added.ts));

  const serialized = JSON.stringify(activity);
  assert.equal(serialized.includes('这段正文不应该出现在动态里'), false, 'feed items must not carry bodies');

  assert.ok(activity.digest.today >= 1);
  assert.ok(activity.digest.lastAt !== null);
});

test('the activity feed honours since and limit', (t) => {
  const { store, scopes } = openTestStore(t);
  for (let i = 0; i < 5; i += 1) {
    store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: `事实 ${i}`, body: `第 ${i} 条。` });
  }
  const all = buildActivity(store, { limit: 50 });
  assert.ok(all.items.length >= 5);
  const capped = buildActivity(store, { limit: 2 });
  assert.equal(capped.items.length, 2);
  const future = buildActivity(store, { limit: 50, since: Date.now() + 60_000 });
  assert.equal(future.items.length, 0, 'a since in the future yields nothing');
});
