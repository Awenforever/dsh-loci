#!/usr/bin/env node
/** Every stored row, classified, so "clear the test memories" can be decided from facts. */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.11.0' });

const rows = store.db
  .prepare(
    `SELECT m.id, m.kind, m.scope_key, m.title, m.trust_source, m.pinned, m.created_at,
            m.valid_to, m.source_session, h.status,
            COALESCE(u.inject_count, 0) AS inject_count,
            COALESCE(u.read_count, 0)   AS read_count
       FROM memory m
       JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      ORDER BY m.created_at`,
  )
  .all();

console.log(`total rows: ${rows.length}\n`);
const group = (key) => {
  const map = new Map();
  for (const row of rows) map.set(row[key], (map.get(row[key]) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
};
console.log(`by status  : ${JSON.stringify(Object.fromEntries(group('status')))}`);
console.log(`by source  : ${JSON.stringify(Object.fromEntries(group('trust_source')))}`);
console.log(`by scope   : ${JSON.stringify(Object.fromEntries(group('scope_key').map(([k, n]) => [String(k).slice(0, 40), n])))}`);
console.log(`by kind    : ${JSON.stringify(Object.fromEntries(group('kind')))}`);

console.log('\n=== rows (oldest first) ===');
for (const row of rows) {
  const state = row.valid_to === null ? 'live' : 'deleted';
  const stamp = new Date(row.created_at).toISOString().slice(5, 16).replace('T', ' ');
  console.log(
    `  ${stamp}  ${String(row.status).padEnd(10)} ${String(row.trust_source ?? '-').padEnd(8)} ` +
      `${String(row.kind).padEnd(10)} ${state.padEnd(8)} inj=${String(row.inject_count ?? 0).padStart(4)} ` +
      `open=${row.open_count ?? 0}  ${JSON.stringify(String(row.title).slice(0, 46))}`,
  );
  console.log(`             id=${row.id}  scope=${String(row.scope_key).slice(0, 52)}`);
}

const usage = store.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(inject_count), 0) AS s, COALESCE(SUM(read_count), 0) AS r FROM memory_usage').get();
console.log(`\ninject_count total: ${usage.s} · read_count total: ${usage.r} across ${usage.n} tracked ids`);
store.close();
