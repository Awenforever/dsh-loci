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
 * A person approving a candidate, from a terminal.
 *
 * The tool surface has no verify operation on purpose — the model must never grant
 * trust — which left terminal-only users able to create candidates forever and never
 * promote one. `/loci review` used to point at `loci_write op:"verify"`, an operation
 * that has never existed. These tests cover the door that does exist.
 */
const root = join(import.meta.dirname, '..', '..');
const cli = join(root, 'scripts', 'cli.mjs');

function seed(home) {
  const memoryRoot = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const store = new Store({ memoryRoot, paths: layout(memoryRoot), config: effectiveConfig({ home }), pluginVersion: '2.5.0' });
  const scopes = resolveScopes({ sessionId: 'verify-test', cwd: home });
  const written = store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'rule',
    trustSource: 'tool',
    title: '一条等待人批准的事实',
    body: '它必须是候选，直到有人点头。',
  });
  const injected = store.indexEntries({ scopeKeys: [scopes.workspace] }).length;
  store.close();
  return { id: written.entry.id, scopeKey: scopes.workspace, injected };
}

function runCli(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { encoding: 'utf8', timeout: 60_000 }) };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

function readStatus(home, id) {
  const memoryRoot = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const store = new Store({ memoryRoot, paths: layout(memoryRoot), config: effectiveConfig({ home }), pluginVersion: '2.5.0' });
  const entry = store.get(id).entry;
  store.close();
  return entry.status;
}

test('a candidate starts out unverified and uninjected', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-verify-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { id, injected } = seed(home);
  assert.equal(readStatus(home, id), 'candidate');
  assert.equal(injected, 0);
});

test('verify --id promotes a candidate, and only then does it inject', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-verify-ok-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { id, scopeKey } = seed(home);

  const result = runCli(['verify', '--home', home, '--id', id]);
  assert.equal(result.code, 0, `verify should succeed; stdout=${result.stdout}`);
  assert.equal(readStatus(home, id), 'verified');

  const memoryRoot = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const store = new Store({ memoryRoot, paths: layout(memoryRoot), config: effectiveConfig({ home }), pluginVersion: '2.5.0' });
  assert.equal(store.indexEntries({ scopeKeys: [scopeKey] }).length, 1, 'approval is what makes it injectable');
  store.close();
});

test('verify --status disputed records a rejection instead of deleting', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-verify-dispute-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { id } = seed(home);

  const result = runCli(['verify', '--home', home, '--id', id, '--status', 'disputed']);
  assert.equal(result.code, 0);
  assert.equal(readStatus(home, id), 'disputed', 'a rejection keeps the row: history is not erased by disagreement');
});

test('an unknown status is refused before anything is written', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-verify-bad-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { id } = seed(home);

  const result = runCli(['verify', '--home', home, '--id', id, '--status', 'blessed']);
  assert.notEqual(result.code, 0);
  assert.equal(readStatus(home, id), 'candidate', 'a typo must not change trust');
});

test('verify without an id is a usage error', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-verify-noid-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = runCli(['verify', '--home', home]);
  assert.notEqual(result.code, 0);
});
