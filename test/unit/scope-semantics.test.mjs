import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { registerApiRoutes } from '../../src/host/api/routes.js';
import { createTools } from '../../src/host/tools/tools.js';
import { fakeExec, openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * Boundary semantics that a scope-resolution mistake could silently invert.
 *
 * Three defects share one root: something that should have failed closed fell back to
 * "everything". The preview route asked `resolveScopes` for fields it does not return, the
 * panel asked for a scope it could not resolve, and `stats` treated an empty key list as a
 * request for the whole database.
 */

// 1. The route read fields that do not exist.

test('the preview route answers when a caller supplies a cwd', async (t) => {
  const { store, home } = openTestStore(t);
  const config = effectiveConfig({});
  const routes = new Map();
  const ctx = {
    get: (name) =>
      name === 'connection'
        ? { fetch: { register: ({ path, fetch }) => (routes.set(path, fetch), () => routes.delete(path)) } }
        : undefined,
  };
  registerApiRoutes(ctx, { store, paths: store.paths, config, log: undefined, updates: undefined, version: '2.10.1' });

  const handler = routes.get('/api/loci/preview');
  assert.ok(handler, 'the preview route must be mounted');

  // Before the fix this threw "Cannot read properties of undefined (reading 'length')":
  // `resolveScopes` returns `{session, workspace, project, global, labels, ...}`, and the
  // route read `resolved.readKeys`, which is undefined.
  const scoped = await handler(new Request(`http://local/api/loci/preview?cwd=${encodeURIComponent(home)}`));
  assert.equal(scoped.status, 200, 'a scoped preview must render');

  const unscoped = await handler(new Request('http://local/api/loci/preview'));
  assert.equal(unscoped.status, 200, 'the whole-store preview must keep working');
});

test('the knowledge route answers when a caller supplies a cwd', async (t) => {
  const { store, home } = openTestStore(t);
  const config = effectiveConfig({});
  const routes = new Map();
  const ctx = {
    get: (name) =>
      name === 'connection'
        ? { fetch: { register: ({ path, fetch }) => (routes.set(path, fetch), () => routes.delete(path)) } }
        : undefined,
  };
  registerApiRoutes(ctx, { store, paths: store.paths, config, log: undefined, updates: undefined, version: '2.10.1' });
  const handler = routes.get('/api/loci/knowledge');
  const scoped = await handler(new Request(`http://local/api/loci/knowledge?cwd=${encodeURIComponent(home)}&limit=4`));
  assert.equal(scoped.status, 200);
});

// 2. An empty key list is not "the whole store".

test('an explicit empty scope set answers nothing, not everything', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: '一条事实', body: '正文。' });

  // Omitted = an admin question about the whole database.
  assert.equal(store.stats().heads, 1);
  assert.equal(store.usageReport().length, 1);
  // `[]` = somebody asked for a scope and resolved no keys. That must be empty; treating
  // it as a wildcard turns a scope bug into a confident cross-project answer.
  assert.equal(store.stats({ scopeKeys: [] }).heads, 0);
  assert.equal(store.usageReport({ scopeKeys: [] }).length, 0);
  // And a real key still works.
  assert.equal(store.stats({ scopeKeys: [scopes.workspace] }).heads, 1);
});

// 3. Every id-addressed write op respects the read set, not just get/forget.

test('a foreign id cannot be revised, pinned, restored or merged through the tools', async (t) => {
  const { store, scopes, home } = openTestStore(t);
  const foreign = store.write({
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '另一个项目的约定',
    body: '不该被本会话改动。',
  });
  const tools = createTools({ store, config: () => effectiveConfig({}), log: undefined, capture: undefined });
  const write = tools.find((tool) => tool.name === 'loci_write');

  const elsewhere = mkdtempSync(join(tmpdir(), 'loci-foreign-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const exec = fakeExec('session-other', elsewhere);
  assert.notEqual(elsewhere, home);

  for (const op of ['update', 'pin', 'unpin', 'restore']) {
    await assert.rejects(
      () => write.execute({ op, id: foreign.entry.id, title: '改写', body: '改写' }, exec),
      /not in this session's scope/,
      `${op} must refuse a foreign id`,
    );
  }
  await assert.rejects(
    () => write.execute({ op: 'merge', id: foreign.entry.id, sourceIds: [foreign.entry.id] }, exec),
    /not in this session's scope/,
  );

  // Nothing changed: still verified, still not pinned by a stranger.
  const after = store.get(foreign.entry.id).entry;
  assert.equal(after.status, 'verified');
  assert.equal(after.pinned, false);
});
// 4. A missing cwd must not borrow the Host process directory.

test('a session with no cwd gets an unresolved scope, not the process directory', async () => {
  const { resolveScopes } = await import('../../src/host/scope.js');
  const anonymous = resolveScopes({ sessionId: 'no-cwd' });
  const fromProcess = resolveScopes({ sessionId: 'no-cwd', cwd: process.cwd() });

  // Before the fix both were identical: the missing cwd fell back to `process.cwd()`, so
  // every cwd-less session and every panel request shared one key — keyed to wherever the
  // Host happened to be installed. That is a silent cross-project bucket.
  assert.equal(anonymous.workspace, 'workspace:unresolved');
  assert.equal(anonymous.project, 'project:unresolved');
  assert.equal(anonymous.cwd, undefined);
  assert.equal(anonymous.labels.workspace, 'unresolved workspace');
  assert.notEqual(anonymous.workspace, fromProcess.workspace, 'an unresolved scope must not collide with the process directory');
  // And an explicit cwd still resolves normally.
  assert.notEqual(fromProcess.workspace, 'workspace:unresolved');
});
