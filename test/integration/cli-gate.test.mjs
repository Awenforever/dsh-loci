import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { ensureMemoryRoot, layout } from '../../src/host/paths.js';
import { resolveScopes } from '../../src/host/scope.js';
import { Store } from '../../src/host/store/store.js';

/**
 * The hard-delete gate has to survive the CLI, not just the store.
 *
 * It did not: `scripts/cli.mjs` passed `live: () => true`, so every gate that reads a
 * live value evaluated to open and `--allow-hard-delete` was decorative. No test
 * covered the CLI purge path, so nothing failed — the store-level test passed while
 * the command a user actually types destroyed data.
 *
 * These tests run the real command line, because that is the surface that broke.
 */
const root = join(import.meta.dirname, '..', '..');
const cli = join(root, 'scripts', 'cli.mjs');

function seed(home) {
  const memoryRoot = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const paths = layout(memoryRoot);
  const store = new Store({ memoryRoot, paths, config: effectiveConfig({ home }), pluginVersion: '2.5.0' });
  const scopes = resolveScopes({ sessionId: 'cli-test', cwd: home });
  const written = store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'rule',
    trustSource: 'user',
    title: '一条不该被意外硬删除的事实',
    body: '硬删除需要显式开启。',
  });
  store.close();
  return written.entry.id;
}

/** Run the CLI and return `{code, stdout, stderr}` without throwing on failure. */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

test('purge is refused when the config forbids hard delete', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-cli-gate-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const id = seed(home);

  const result = runCli(['purge', '--home', home, '--id', id, '--confirm', id]);
  assert.notEqual(result.code, 0, 'the command must fail, not silently delete');
  assert.match(result.stderr, /hard delete is disabled/i);

  // The entry must still be there: a refused purge that deleted anyway would be worse
  // than no gate at all.
  const memoryRoot = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const store = new Store({ memoryRoot, paths: layout(memoryRoot), config: effectiveConfig({ home }), pluginVersion: '2.5.0' });
  const survived = store.get(id);
  assert.equal(survived.entry.status, 'verified');
  assert.ok(survived.history.length >= 1, 'every revision is still present');
  store.close();
});

test('purge works when the invocation opts in explicitly', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-cli-gate-ok-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const id = seed(home);

  const result = runCli(['purge', '--home', home, '--id', id, '--confirm', id, '--allow-hard-delete']);
  assert.equal(result.code, 0, `purge should succeed with the flag; stderr=${result.stderr}`);
  assert.match(result.stdout, /purged/);
});

test('the confirmation phrase still has to match the id', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-cli-confirm-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const id = seed(home);

  // Opted in, but confirmed the wrong id: the gate must still refuse.
  const result = runCli(['purge', '--home', home, '--id', id, '--confirm', 'm_something_else', '--allow-hard-delete']);
  assert.notEqual(result.code, 0, 'a mismatched confirmation must not delete');
});
