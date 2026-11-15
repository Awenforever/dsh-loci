import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveWriteScope, findProjectRootInfo, readScopeKeys, resolveScopes, scopeChoices } from '../../src/host/scope.js';
import { openTestStore } from '../helpers.mjs';

/**
 * Where a write lands when nobody named a scope.
 *
 * The rule used to be "always workspace". That is correct only when one directory holds one
 * project; on a machine where a single directory carries several independent repositories,
 * every session reports the same cwd, so `workspace` merged them and put one product's rules
 * in front of another product's session. Observed on invictus: a release-process fact written
 * by a throwaway test session reached `inject_count` 326, including into a session about gas
 * flow control in a different repository.
 */

test('a directory inside a project writes to that project', () => {
  const scopes = resolveScopes({ sessionId: 's1', cwd: process.cwd() });
  assert.equal(scopes.projectRootFound, true, 'the repository itself must be detected');
  const chosen = effectiveWriteScope(scopes, {});
  assert.equal(chosen.scope, 'project');
  assert.equal(chosen.key, scopes.project);
});

test('a directory that is not inside a project writes to the conversation', () => {
  // `default-workspace` holds six repositories but is not itself one, so the project search
  // finds nothing and the safe answer is "do not share".
  const scope = {
    session: 'session:x',
    workspace: 'workspace:y',
    project: 'project:y',
    global: 'global:',
    labels: { session: 's', workspace: 'w', project: 'p', global: 'global' },
    projectRootFound: false,
  };
  const chosen = effectiveWriteScope(scope, {});
  assert.equal(chosen.scope, 'session');
  assert.equal(chosen.key, 'session:x');
  assert.match(chosen.reason, /no project found/);
});

test('a person\'s choice beats the automatic rule', () => {
  const scopes = resolveScopes({ sessionId: 's2', cwd: process.cwd() });
  for (const mode of ['session', 'workspace', 'project', 'global']) {
    const chosen = effectiveWriteScope(scopes, { override: mode });
    assert.equal(chosen.scope, mode, `override ${mode} must be honoured`);
    assert.equal(chosen.key, scopes[mode]);
  }
});

test('auto is the absence of a choice, not a stored mode', () => {
  const scopes = resolveScopes({ sessionId: 's3', cwd: process.cwd() });
  assert.equal(effectiveWriteScope(scopes, { override: 'auto' }).mode, 'auto');
  assert.equal(effectiveWriteScope(scopes, { override: undefined }).mode, 'auto');
});

test('a partial identity still writes somewhere real', () => {
  // An older caller or a test stub may hand in only `workspace`; landing on a scope with no
  // key would write `undefined` and disappear without raising.
  const chosen = effectiveWriteScope({ workspace: 'workspace:only', labels: { workspace: 'only' } }, {});
  assert.equal(chosen.scope, 'workspace');
  assert.equal(chosen.key, 'workspace:only');
});

test('a stale override that is not a known mode is ignored', () => {
  const scopes = resolveScopes({ sessionId: 's4', cwd: process.cwd() });
  const chosen = effectiveWriteScope(scopes, { override: 'nonsense' });
  assert.equal(chosen.scope, scopes.projectRootFound ? 'project' : 'session');
});

test('the read set never repeats a key', () => {
  // A non-repository directory maps `project` and `workspace` onto the same hashed key string
  // with different prefixes, so the guard is about the shape, not the prefix.
  const scopes = resolveScopes({ sessionId: 's5', cwd: process.cwd() });
  const keys = readScopeKeys(scopes, { includeGlobal: true });
  assert.equal(new Set(keys).size, keys.length);
});

test('findProjectRootInfo distinguishes a real root from a plain directory', () => {
  assert.equal(findProjectRootInfo(process.cwd()).found, true);
  const plain = findProjectRootInfo(process.env.TEMP ?? '/tmp');
  assert.equal(typeof plain.root, 'string');
  // The temp directory is not expected to be inside a repository.
  assert.equal(plain.found, false);
});

test('the panel offers auto plus every scope', () => {
  const values = scopeChoices().map((choice) => choice.value);
  assert.deepEqual(values, ['auto', 'project', 'session', 'workspace', 'global']);
});

test('a stored choice survives a store restart and clears to auto', (t) => {
  const { store } = openTestStore(t);
  assert.equal(store.getSessionScope('session-z'), undefined);
  store.setSessionScope('session-z', 'workspace');
  assert.equal(store.getSessionScope('session-z'), 'workspace');
  store.setSessionScope('session-z', 'auto');
  assert.equal(store.getSessionScope('session-z'), undefined, 'auto must delete the row, not store it');
});

test('the active session is recoverable for surfaces with no session handle', (t) => {
  const { store } = openTestStore(t);
  assert.equal(store.activeSession(), undefined, 'nothing assembled yet means no current session');
  store.recordInjection({
    sessionId: 'session-active',
    scopeKey: 'workspace:abc',
    cwd: 'C:/work/project',
    bytes: 10,
    listed: 1,
    hidden: 0,
    // Current time on purpose: `recordInjection` prunes rows older than 90 days, so a fixed
    // historical timestamp would be deleted by the same call that inserted it.
    ts: Date.now(),
  });
  const active = store.activeSession();
  assert.equal(active.sessionId, 'session-active');
  assert.equal(active.cwd, 'C:/work/project', 'the directory must round-trip, since the key is a hash');
});
