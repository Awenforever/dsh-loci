import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { ensureMemoryRoot, layout } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const CHILD = fileURLToPath(new URL('./writer-child.mjs', import.meta.url));

/**
 * Run one writer child and collect its JSON line.
 * @param root - memory root.
 * @param worker - worker index.
 * @param count - writes per worker.
 */
function runChild(root, worker, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, root, String(worker), String(count)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).at(-1);
      if (line === undefined) return reject(new Error(`worker ${worker} produced no result (code ${code}): ${err.slice(0, 500)}`));
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`worker ${worker} produced invalid JSON: ${line.slice(0, 200)}`));
      }
    });
  });
}

test('four processes write 50 facts each with no lost row and no lock error', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-concurrency-'));
  const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const store = new Store({
    memoryRoot: root,
    paths: layout(root),
    config: effectiveConfig({}),
    pluginVersion: '1.0.0',
  });
  t.after(() => {
    try {
      store.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  const results = await Promise.all([0, 1, 2, 3].map((worker) => runChild(root, worker, 50)));
  const errors = results.flatMap((result) => result.errors);
  assert.deepEqual(errors, [], `no write may fail: ${errors.join('; ')}`);
  assert.equal(results.reduce((total, result) => total + result.written, 0), 200);

  const stats = store.stats();
  assert.equal(stats.heads, 200, 'every write must be visible after the fact');
  assert.equal(store.health().integrity, 'ok');
  assert.equal(store.indexCoverage().missing, 0, 'every revision must be indexed');
});

test('a process killed mid-write leaves a recoverable database', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-crash-'));
  const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [CHILD, root, '99', '0', '--loop'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Let it commit a few transactions, then terminate without cleanup.
  await new Promise((resolve) => setTimeout(resolve, 900));
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('close', resolve));

  assert.ok(existsSync(join(root, 'memory.db')), 'the database must survive a hard kill');
  const store = new Store({
    memoryRoot: root,
    paths: layout(root),
    config: effectiveConfig({}),
    pluginVersion: '1.0.0',
  });
  try {
    const health = store.health();
    assert.equal(health.integrity, 'ok', `integrity after kill: ${health.integrity}`);
    assert.ok(health.counts.memory_head > 0, 'committed rows must still be there');
    assert.equal(store.indexCoverage().missing, 0, 'no half-written index rows may remain');
    const first = store.list({ scopeKeys: store.allScopeKeys(), statuses: ['verified'], limit: 5, offset: 0 });
    assert.ok(first.items.length > 0);
  } finally {
    store.close();
  }
});
