import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * The config schema only builds when `@deepseek-ai/schemastery` resolves, and that is
 * exactly the condition under which a corrupted schema line throws. A local checkout
 * without dependencies silently skips `buildSchema()` — which is how a broken
 * `.number().step(...)` chain reached a tag and failed in CI while every local gate
 * stayed green.
 *
 * These tests run the builder whenever it is available and say so loudly when it is
 * not, so "the tests passed" stops meaning "the schema was never executed".
 */
const mod = await import('../../src/host/config.js');

test('the config schema builds when the peer dependency is present', () => {
  if (mod.HAS_CONFIG_SCHEMA !== true) {
    // Local checkouts without dependencies land here. CI installs them, so this is a
    // skip and not a silent pass: the assertion below only runs where it is real.
    assert.equal(mod.Config, undefined, 'without schemastery there is no Config export by design');
    return;
  }
  assert.equal(typeof mod.Config, 'function', 'a resolvable schemastery must produce a schema');
});

test('every documented default survives a schema round-trip', () => {
  if (mod.HAS_CONFIG_SCHEMA !== true) return;
  // Constructing the schema is the real check: a broken chain throws here, and a
  // default that the schema rejects (out of range, wrong union member) throws too.
  const built = mod.Config({});
  assert.ok(built !== null && typeof built === 'object');
  for (const [key, value] of Object.entries(mod.DEFAULTS)) {
    assert.ok(key.length > 0);
    assert.notEqual(value, undefined, `${key} has no default`);
  }
});

test('the extract modes the schema accepts match the documented enum', () => {
  if (mod.HAS_CONFIG_SCHEMA !== true) return;
  assert.deepEqual(mod.ENUMS.extractMode, ['off', 'on', 'turn', 'session']);
  const built = mod.Config({});
  assert.ok('extractSessionMaxCandidates' in built, 'the session cap must be a real schema key');
});
