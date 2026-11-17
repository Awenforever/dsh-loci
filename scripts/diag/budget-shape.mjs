#!/usr/bin/env node
/**
 * How is the prompt budget actually spent, per session?
 *
 * R27 — "how much should the recall block be?" — cannot be answered by tuning a constant in the dark. The
 * first thing to know is where the bytes went: a fixed core that every turn repeats, or a
 * question-dependent slice. If the core saturates the budget, the slice has nowhere to put anything new
 * and the question of the slice's own size never arises.
 *
 * Usage: node scripts/diag/budget-shape.mjs [session-prefix] [--hours=N]
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

// argv[0] is the node binary and argv[1] is this script; only argv[2] onward is the caller's.
const positional = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const prefix = positional ?? '';
const hoursArg = process.argv.find((arg) => arg.startsWith('--hours='));
const hours = hoursArg === undefined ? 48 : Number(hoursArg.slice('--hours='.length));
const since = Date.now() - hours * 3_600_000;

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.4' });
const config = store.live('recallMode') === undefined ? {} : {};

const rows = store.db
  .prepare(
    `SELECT ts, session_id, scope_key, section_bytes, entries_listed, entries_hidden, source
       FROM request_stat
      WHERE ts >= ? ${prefix.length > 0 ? 'AND session_id LIKE ?' : ''}
      ORDER BY ts`,
  )
  .all(...(prefix.length > 0 ? [since, `%${prefix}%`] : [since]));

console.log(`request_stat rows since ${hours}h ago${prefix.length > 0 ? ` for ${prefix}` : ''}: ${rows.length}`);
if (rows.length === 0) {
  console.log('nothing recorded in the window');
  store.close();
  process.exit(0);
}

const bySource = new Map();
for (const row of rows) {
  const key = row.source ?? '(none)';
  const bucket = bySource.get(key) ?? { count: 0, bytes: 0, listed: 0, hidden: 0 };
  bucket.count += 1;
  bucket.bytes += Number(row.section_bytes ?? 0);
  bucket.listed += Number(row.entries_listed ?? 0);
  bucket.hidden += Number(row.entries_hidden ?? 0);
  bySource.set(key, bucket);
}

console.log('\nby source:');
for (const [source, bucket] of [...bySource].sort((a, b) => b[1].bytes - a[1].bytes)) {
  const mean = bucket.count === 0 ? 0 : Math.round(bucket.bytes / bucket.count);
  console.log(
    `  ${source.padEnd(12)} renders ${String(bucket.count).padStart(4)} · mean ${String(mean).padStart(5)} B · ` +
      `listed ${bucket.listed} · hidden ${bucket.hidden}`,
  );
}

// The distribution matters more than the mean: a budget that is usually fine and sometimes over is a
// different problem from one that is always exactly at the ceiling.
const bytes = rows.map((row) => Number(row.section_bytes ?? 0)).sort((a, b) => a - b);
const at = (fraction) => bytes[Math.min(bytes.length - 1, Math.floor(bytes.length * fraction))];
console.log(`\nsection size distribution: p50 ${at(0.5)} B · p90 ${at(0.9)} B · p99 ${at(0.99)} B · max ${bytes[bytes.length - 1]} B`);

// How many distinct entries ever appear, versus how many injections that took.
const injected = store.db.prepare('SELECT COUNT(*) AS n FROM memory_usage WHERE inject_count > 0').get().n;
const totalInjections = store.db.prepare('SELECT SUM(inject_count) AS n FROM memory_usage').get().n ?? 0;
const neverRead = store.db.prepare('SELECT COUNT(*) AS n FROM memory_usage WHERE inject_count > 0 AND read_count = 0').get().n;
const everRead = store.db.prepare('SELECT COUNT(*) AS n FROM memory_usage WHERE read_count > 0').get().n;
console.log(`\ndistinct entries ever injected ${injected} · total injections ${totalInjections}`);
console.log(`  of those, opened at least once ${everRead} · never opened ${neverRead}`);
if (injected > 0) {
  console.log(`  mean injections per entry: ${(totalInjections / injected).toFixed(1)}`);
}

// Concentration: are a few entries carrying almost all of the injection traffic?
const top = store.db
  .prepare(
    `SELECT u.id, u.inject_count, u.read_count, m.title, m.kind
       FROM memory_usage u JOIN memory m ON m.id = u.id
      ORDER BY u.inject_count DESC LIMIT 8`,
  )
  .all();
if (top.length > 0) {
  console.log('\nmost-injected entries:');
  let topSum = 0;
  for (const row of top) {
    topSum += Number(row.inject_count);
    console.log(`  ${String(row.inject_count).padStart(5)}×  read=${row.read_count}  ${row.kind}  ${JSON.stringify(String(row.title).slice(0, 60))}`);
  }
  if (totalInjections > 0) console.log(`  top 8 carry ${((topSum / totalInjections) * 100).toFixed(1)}% of all injection traffic`);
}

console.log(`\nrecall mode in config: ${config?.recallMode ?? '(not read)'}`);
store.close();
