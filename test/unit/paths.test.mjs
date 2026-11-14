import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertInside } from '../../src/host/paths.js';

/**
 * `assertInside` is the guard every export, import and backup path goes through.
 * A lexical prefix check is not enough on its own: a symlink inside the data
 * directory passes it and then writes wherever the link points.
 */
test('assertInside accepts paths under the root', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'loci-inside-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(assertInside(root, join(root, 'a', 'b.md')), join(root, 'a', 'b.md'));
  mkdirSync(join(root, 'exports'), { recursive: true });
  assert.equal(assertInside(root, join(root, 'exports', 'x.md')), join(root, 'exports', 'x.md'));
});

test('assertInside rejects a sibling that merely shares a prefix', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'loci-sibling-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'memory');
  mkdirSync(root, { recursive: true });
  assert.throws(() => assertInside(root, join(parent, 'memory-evil', 'x.md')), /refusing path outside/);
  assert.throws(() => assertInside(root, join(parent, 'elsewhere')), /refusing path outside/);
});

test('assertInside rejects a symlink inside the root that points outside', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'loci-symlink-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'memory');
  const outside = join(parent, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.md'), 'not ours', 'utf8');
  try {
    symlinkSync(outside, join(root, 'link'), 'dir');
  } catch {
    // Windows without developer mode cannot create symlinks; the lexical checks
    // above still run.
    t.skip('symlink creation not permitted on this host');
    return;
  }
  assert.throws(() => assertInside(root, join(root, 'link', 'secret.md')), /resolves to|refusing path outside/);
});
