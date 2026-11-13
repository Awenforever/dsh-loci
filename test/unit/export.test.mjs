import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { ensureMemoryRoot, layout, resolveMemoryRoot } from '../../src/host/paths.js';
import { resolveScopes } from '../../src/host/scope.js';
import { exportMarkdown, importMarkdown } from '../../src/host/store/export.js';
import { Store } from '../../src/host/store/store.js';

/** A store in its own temporary home. */
function freshStore(t) {
  const home = mkdtempSync(join(tmpdir(), 'loci-export-'));
  const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const paths = layout(root);
  const store = new Store({ memoryRoot: root, paths, config: effectiveConfig({}), pluginVersion: '1.3.0' });
  t.after(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { store, paths, home };
}

test('export then import round-trips the entries the user had', (t) => {
  const { store, paths, home } = freshStore(t);
  const scopes = resolveScopes({ sessionId: 'export', cwd: join(home, 'project-a') });
  store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'rule',
    trustSource: 'user',
    title: '删除前必须做路径断言',
    body: '任何删除动作之前先校验绝对路径与白名单根。',
    tags: ['安全'],
    entities: ['删除'],
  });
  store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'semantic',
    trustSource: 'user',
    title: '生产机是 prod-01',
    body: '禁止在生产机直接执行迁移脚本。',
  });

  const exported = exportMarkdown(store, paths);
  assert.equal(exported.files, 2, 'both entries are written as documents');
  assert.ok(existsSync(paths.markdown), 'entries live under markdown/');
  assert.ok(readdirSync(paths.markdown).length > 0);

  // The regression: this used to read exports/ (a one-line summary) and import 0.
  const result = importMarkdown(store, paths);
  assert.equal(result.imported, 2, 'a fresh import must find the exported documents');
  assert.deepEqual(result.errors, []);

  const candidates = store.db
    .prepare("SELECT title, scope_key, trust_source, status FROM memory WHERE status = 'candidate' AND deleted_at IS NULL")
    .all();
  const imported = candidates.filter((row) => row.trust_source === 'import');
  assert.equal(imported.length, 2, 'every imported row lands as a candidate, whatever its source status was');
  assert.ok(imported.every((row) => row.scope_key === scopes.workspace), 'the original scope is restored');
});

test('import honours an explicit directory and skips foreign markdown', (t) => {
  const { store, paths } = freshStore(t);
  // A directory must be inside the data root; that guard is what keeps a typo
  // from reading the user's whole disk.
  const dir = join(paths.root, 'manual-import');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'not-ours.md'), '# just a note\n\nno front matter here\n', 'utf8');

  const result = importMarkdown(store, paths, { dir });
  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 1, 'a file without our front matter is skipped, not imported');
});

test('an import cannot escape the data directory', (t) => {
  const { store, paths, home } = freshStore(t);
  assert.throws(() => importMarkdown(store, paths, { dir: join(home, '..', 'elsewhere') }), /refusing path outside/);
});

test('exported front matter keeps the scope key so a re-import lands in the same place', (t) => {
  const { store, paths, home } = freshStore(t);
  const scopes = resolveScopes({ sessionId: 'x', cwd: join(home, 'project-b') });
  store.write({
    scope: 'project',
    scopeKey: scopes.project,
    scopeLabel: scopes.labels.project,
    kind: 'procedural',
    trustSource: 'user',
    title: '发布顺序',
    body: 'staging → canary → 全量。',
  });
  exportMarkdown(store, paths);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(paths.markdown);
  const text = readFileSync(files[0], 'utf8');
  // Front matter values are JSON-quoted by `scalar()`.
  assert.match(text, /scope: "project"/);
  assert.ok(text.includes(scopes.project), 'the original scope key is written into the front matter');
});
