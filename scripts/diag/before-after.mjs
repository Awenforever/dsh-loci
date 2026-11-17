#!/usr/bin/env node
/**
 * Did the new split actually change what one live session receives?
 *
 * `inject_count` is cumulative, so it cannot answer this. The comparison has to be between renders recorded
 * before and after 5.2.0 went in, using `request_stat` (which is timestamped) plus the audit's ids.
 *
 * Usage: node scripts/diag/before-after.mjs <session-prefix> [--cutoff=ISO]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const prefix = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '';
const cutoffArg = process.argv.find((arg) => arg.startsWith('--cutoff='));
// 5.2.0 was installed at 15:05 +0800.
const cutoff = cutoffArg === undefined ? Date.parse('2026-11-17T15:05:00+08:00') : Date.parse(cutoffArg.slice('--cutoff='.length));

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.2.0' });

const rows = store.db
  .prepare(
    `SELECT ts, session_id, section_bytes, entries_listed, source
       FROM request_stat
      WHERE session_id LIKE ? AND ts >= ?
      ORDER BY ts`,
  )
  .all(`%${prefix}%`, cutoff - 6 * 3_600_000);

const before = rows.filter((row) => Number(row.ts) < cutoff);
const after = rows.filter((row) => Number(row.ts) >= cutoff);

const summarise = (label, list) => {
  if (list.length === 0) {
    console.log(`${label}: no renders`);
    return null;
  }
  const bytes = list.map((row) => Number(row.section_bytes ?? 0));
  const listed = list.map((row) => Number(row.entries_listed ?? 0));
  const mean = (values) => Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  console.log(
    `${label.padEnd(18)} renders ${String(list.length).padStart(4)} · mean ${String(mean(bytes)).padStart(4)} B` +
      ` · mean entries ${(mean(listed) / 100).toFixed(2)} · listed total ${listed.reduce((a, b) => a + b, 0)}`,
  );
  return { renders: list.length, meanBytes: mean(bytes) };
};

const a = summarise('before 5.2.0', before);
const b = summarise('after 5.2.0 ', after);

if (a !== null && b !== null && a.renders > 0 && b.renders > 0) {
  console.log(`\nsection size: ${a.meanBytes} B → ${b.meanBytes} B (${b.meanBytes - a.meanBytes >= 0 ? '+' : ''}${b.meanBytes - a.meanBytes})`);
  console.log('the split is working if the change is small in bytes but different in kind:');
  console.log('  before, six rules every turn whether or not the task touched them;');
  console.log('  after,  four standing rules, and the rest arriving only when the question matches.');
}

// Which entries the renders in each window actually listed.
const lines = readFileSync(join(root, 'audit.jsonl'), 'utf8').split('\n').filter((line) => line.trim().length > 0);
const perWindow = { before: new Map(), after: new Map() };
for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.event !== 'inject') continue;
  if (!String(event.sessionId ?? '').includes(prefix)) continue;
  const ids = Array.isArray(event.ids) ? event.ids : [];
  if (ids.length === 0) continue;
  const window = Number(event.ts) >= cutoff ? 'after' : 'before';
  for (const id of ids) perWindow[window].set(id, (perWindow[window].get(id) ?? 0) + 1);
}

const titleOf = (id) =>
  String(store.db.prepare('SELECT title FROM memory WHERE id = ? ORDER BY revision DESC LIMIT 1').get(id)?.title ?? '(unknown)').slice(0, 58);

for (const window of ['before', 'after']) {
  const bucket = perWindow[window];
  if (bucket.size === 0) continue;
  console.log(`\n${window} — distinct entries injected: ${bucket.size}`);
  for (const [id, count] of [...bucket].sort((x, y) => y[1] - x[1]).slice(0, 6)) {
    console.log(`  ${String(count).padStart(4)}×  ${JSON.stringify(titleOf(id))}`);
  }
}
store.close();
