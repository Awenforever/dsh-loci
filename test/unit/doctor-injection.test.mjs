import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDoctor } from '../../src/host/doctor.js';
import { DEFAULTS } from '../../src/host/config.js';
import { openTestStore } from '../helpers.mjs';

/**
 * `doctor` must answer "is memory actually reaching the model", not only "is data on disk".
 *
 * That question used to need a hand-written diagnostic script, and the answer it produced the
 * first time was uncomfortable: 14 entries stored, one verified, and a review queue that could
 * never be filled because every capture is an episodic session summary.
 */

const config = (key) => DEFAULTS[key];

function run(store, paths) {
  return runDoctor({ store, paths, config, engines: undefined, hostVersion: undefined, pluginVersion: '3.9.0' });
}

const row = (report, name) => report.checks.find((check) => check.name === name);

test('with no assembly yet it says so instead of pretending', (t) => {
  const { store, paths } = openTestStore(t);
  const injection = row(run(store, paths), 'injection');
  assert.ok(injection !== undefined, 'the row must exist');
  assert.equal(injection.status, 'ok');
  assert.match(injection.detail, /nothing verified yet|no prompt assembly recorded/);
});

test('a recorded injection reports bytes, entries and time', (t) => {
  const { store, paths } = openTestStore(t);
  store.recordInjection({
    sessionId: 'session-doctor',
    scopeKey: 'workspace:abc',
    cwd: 'C:/work/project',
    bytes: 323,
    listed: 1,
    hidden: 0,
    ts: Date.now(),
  });
  const injection = row(run(store, paths), 'injection');
  assert.equal(injection.status, 'ok');
  assert.match(injection.detail, /323 bytes/);
  assert.match(injection.detail, /1 entry listed/);
  assert.match(injection.detail, /section/);
});

test('zero bytes with verified entries is a failure, not an empty state', (t) => {
  const { store, paths } = openTestStore(t);
  store.write(
    {
      kind: 'rule',
      scope: 'global',
      scopeKey: 'global:',
      scopeLabel: 'global',
      title: 'Never force-push a shared branch',
      body: 'Force-pushing rewrites history other people already pulled.',
      status: 'verified',
    },
    { actor: 'user' },
  );
  store.recordInjection({
    sessionId: 'session-doctor',
    scopeKey: 'workspace:abc',
    bytes: 0,
    listed: 0,
    hidden: 0,
    ts: Date.now(),
  });
  const injection = row(run(store, paths), 'injection');
  assert.equal(injection.status, 'fail', 'a verified entry that never reaches the prompt is a fault');
});

test('candidates that can never be reviewed are named as a dead end', (t) => {
  const { store, paths } = openTestStore(t);
  store.write(
    {
      kind: 'episodic',
      scope: 'session',
      scopeKey: 'session:x',
      scopeLabel: 'session x',
      title: 'Session summary',
      body: 'We worked on the scope model and shipped 3.8.0.',
      status: 'candidate',
    },
    { actor: 'user' },
  );
  const queue = row(run(store, paths), 'review queue');
  assert.ok(queue !== undefined, 'a stuck candidate must produce a row');
  assert.equal(queue.status, 'warn');
  assert.match(queue.detail, /never be reviewed/);
  assert.match(queue.detail, /episodic/);
});

test('a reviewable candidate does not trigger the dead-end warning', (t) => {
  const { store, paths } = openTestStore(t);
  store.write(
    {
      kind: 'procedural',
      scope: 'session',
      scopeKey: 'session:x',
      scopeLabel: 'session x',
      title: 'Rollback window is thirty minutes',
      body: 'Decide within thirty minutes or escalate.',
      status: 'candidate',
    },
    { actor: 'user' },
  );
  const queue = row(run(store, paths), 'review queue');
  assert.equal(queue, undefined, 'a procedural candidate is reviewable, so there is no dead end');
});
