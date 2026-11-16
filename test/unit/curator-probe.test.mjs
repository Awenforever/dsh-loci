import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROBE_META_KEY, PROBE_TRANSCRIPT, runCuratorProbe } from '../../src/host/record/probe.js';
import { readMeta } from '../../src/host/store/schema.js';
import { openTestStore } from '../helpers.mjs';

/**
 * The decision layer's one unmeasured property was whether the model judges well. A fixture would
 * only measure the fixture, so the probe runs one real pass at activation and stores the outcome.
 *
 * These tests pin the probe's own contract — that it never writes memory, that it records, that it
 * does not repeat, and that it reports a *wrong* judgement as wrong. The last one matters most: a
 * self-test that can only pass is not a test.
 */

const GOOD_REPLY = JSON.stringify({
  keep: [
    {
      kind: 'procedural',
      title: '部署先走灰度',
      body: '以后部署先走灰度，别再直接全量。',
      evidenceQuote: '以后部署先走灰度，别再直接全量了。',
    },
    {
      kind: 'rule',
      title: '永远不要在周五发版',
      body: '永远不要在周五发版，周末没人盯着。',
      evidenceQuote: '永远不要在周五发版，周末没人盯着。',
    },
  ],
  drop: [],
});

test('the probe transcript is the case the rules lose', () => {
  // If a future edit replaces these sentences with ones the extractor matches, the probe stops
  // measuring the thing it was built to measure and would pass while proving nothing.
  const joined = PROBE_TRANSCRIPT.map((message) => message.text).join('\n');
  assert.match(joined, /以后部署先走灰度/);
  assert.match(joined, /永远不要在周五发版/);
  assert.ok(PROBE_TRANSCRIPT.some((message) => /按钮颜色/.test(message.text)), 'noise must be present too');
});

test('a correct judgement is recorded and writes no memory', async (t) => {
  const { store } = openTestStore(t);
  const result = await runCuratorProbe({
    store,
    complete: async () => GOOD_REPLY,
    pluginVersion: '4.4.0',
  });
  assert.equal(result.ran, true);
  assert.equal(result.result.ok, true, JSON.stringify(result.result));
  assert.deepEqual(result.result.missed, []);
  assert.deepEqual(result.result.keptNoise, []);
  assert.equal(store.list({ scopeKeys: ['session:probe'] }).total, 0, 'a probe must not leave memory behind');

  const recorded = JSON.parse(readMeta(store.db, PROBE_META_KEY));
  assert.equal(recorded.version, '4.4.0');
  assert.equal(recorded.ok, true);
});

test('a judgement that misses the point is reported as a failure', async (t) => {
  const { store } = openTestStore(t);
  // The model answers in the right shape but keeps the noise and misses the rule.
  const reply = JSON.stringify({
    keep: [
      {
        kind: 'semantic',
        title: '登录页按钮颜色',
        body: '把登录页的按钮颜色调一下。',
        evidenceQuote: '今天先把登录页的按钮颜色调一下。',
      },
    ],
    drop: [],
  });
  const result = await runCuratorProbe({ store, complete: async () => reply, pluginVersion: '4.4.0' });
  assert.equal(result.result.ok, false);
  assert.deepEqual(result.result.missed, ['deploy-first-canary', 'never-friday-release']);
  assert.equal(result.result.keptNoise.length, 1);
});

test('a model that answers in prose fails without being guessed at', async (t) => {
  const { store } = openTestStore(t);
  const result = await runCuratorProbe({
    store,
    complete: async () => 'I have remembered that you prefer canary deploys.',
    pluginVersion: '4.4.0',
  });
  assert.equal(result.result.ok, false);
  assert.match(result.result.error, /not JSON/);
});

test('the probe runs once per version, and can be forced', async (t) => {
  const { store } = openTestStore(t);
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return GOOD_REPLY;
  };
  await runCuratorProbe({ store, complete, pluginVersion: '4.4.0' });
  const second = await runCuratorProbe({ store, complete, pluginVersion: '4.4.0' });
  assert.equal(second.ran, false);
  assert.equal(calls, 1, 'a model call per activation would be a cost nobody agreed to');

  const forced = await runCuratorProbe({ store, complete, pluginVersion: '4.4.0', force: true });
  assert.equal(forced.ran, true);
  assert.equal(calls, 2);

  const nextVersion = await runCuratorProbe({ store, complete, pluginVersion: '4.4.1' });
  assert.equal(nextVersion.ran, true, 'a new version gets a new measurement');
});

test('no model route means the probe stays silent', async (t) => {
  const { store } = openTestStore(t);
  const result = await runCuratorProbe({ store, complete: undefined, pluginVersion: '4.4.0' });
  assert.equal(result.ran, false);
  assert.match(result.reason, /no model route/);
  assert.equal(readMeta(store.db, PROBE_META_KEY), undefined);
});
