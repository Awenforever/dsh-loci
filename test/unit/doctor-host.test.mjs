import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDoctor } from '../../src/host/doctor.js';
import { effectiveConfig } from '../../src/host/config.js';
import { openTestStore } from '../helpers.mjs';

/**
 * `loci doctor`'s host row printed `[ok]` for any version at all, so it could never
 * warn about the one thing it exists to say. These tests pin both directions: inside
 * the declared range is fine, outside it is a warning.
 */
const RANGE = '>=0.2.2-rc.1 <0.3.0-0';

function doctorWith(store, paths, hostVersion) {
  store.hostVersion = hostVersion;
  return runDoctor({
    store,
    paths,
    config: effectiveConfig({}),
    engines: { dsh: RANGE },
  });
}

function hostRow(report) {
  const row = report.checks.find((entry) => entry.name === 'host');
  assert.ok(row, 'the report must carry a host row');
  return row;
}

test('a host inside the declared range is ok', (t) => {
  const { store, paths } = openTestStore(t);
  const row = hostRow(doctorWith(store, paths, '0.2.2-rc.3'));
  assert.equal(row.status, 'ok');
  assert.match(row.detail, /inside/);
});

test('a host above the range is a warning, not a silent ok', (t) => {
  const { store, paths } = openTestStore(t);
  const row = hostRow(doctorWith(store, paths, '0.3.0'));
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /outside/);
});

test('a host below the range is a warning too', (t) => {
  const { store, paths } = openTestStore(t);
  const row = hostRow(doctorWith(store, paths, '0.2.1'));
  assert.equal(row.status, 'warn');
});

test('a prerelease at the lower bound counts as inside', (t) => {
  const { store, paths } = openTestStore(t);
  const row = hostRow(doctorWith(store, paths, '0.2.2-rc.1'));
  assert.equal(row.status, 'ok');
});

test('an unparsable range degrades to ok instead of failing the report', (t) => {
  const { store, paths } = openTestStore(t);
  store.hostVersion = '0.2.2-rc.3';
  const report = runDoctor({ store, paths, config: effectiveConfig({}), engines: { dsh: 'workspace:*' } });
  const row = hostRow(report);
  assert.equal(row.status, 'ok', 'a range we cannot read must not turn into a failure');
  assert.match(row.detail, /not parsed/);
});

test('an unrecorded host is still a warning', (t) => {
  const { store, paths } = openTestStore(t);
  const row = hostRow(doctorWith(store, paths, null));
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /not recorded yet/);
});
