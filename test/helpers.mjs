/**
 * Shared test helpers.
 *
 * Kept outside the `*.test.mjs` files so importing a helper never re-registers
 * another file's tests.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveConfig } from '../src/host/config.js';
import { ensureMemoryRoot, layout } from '../src/host/paths.js';
import { resolveScopes, selectScope } from '../src/host/scope.js';
import { Store } from '../src/host/store/store.js';

/**
 * Open a store in a throwaway Harness home and remove it afterwards.
 * @param t - node:test context.
 * @param config - config overrides for the effective snapshot.
 * @param options - `live` reader override, `quoteVerifier`.
 * @returns `{store, root, paths, home, scopes}`.
 */
export function openTestStore(t, config = {}, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'loci-unit-'));
  const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const paths = layout(root);
  const effective = effectiveConfig(config);
  const store = new Store({
    memoryRoot: root,
    paths,
    config: effective,
    live: options.live ?? ((key) => effective[key]),
    quoteVerifier: options.quoteVerifier,
    pluginVersion: '1.0.0',
  });
  t.after(() => {
    try {
      store.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  const scopes = resolveScopes({ sessionId: 'session-test', cwd: home });
  return { store, root, paths, home, scopes, effective };
}

/** The workspace write fields for a scope identity. */
export function workspaceFields(scopes) {
  const { scope, key, label } = selectScope(scopes, 'workspace');
  return { scope, scopeKey: key, scopeLabel: label };
}

/** A live-config reader over defaults plus overrides. */
export function configReader(overrides = {}) {
  return (key) => (key in overrides ? overrides[key] : undefined);
}

/** A fake tool-execution context for one session. */
export function fakeExec(sessionId, cwd) {
  return {
    agent: { session: { id: sessionId, header: { cwd, version: 4, isSeeded: false, createdAt: Date.now() } } },
    signal: { aborted: false },
  };
}
