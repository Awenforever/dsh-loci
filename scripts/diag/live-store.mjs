#!/usr/bin/env node
/**
 * Snapshot the live store so the injection chain can be observed rather than assumed.
 *
 * R14's remaining half is the full chain: a model writes → a person verifies → the next turn
 * injects non-zero bytes. This prints the state needed to tell which step has happened.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const label = process.argv[2] ?? 'snapshot';
const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '3.4.0' });

const stats = store.stats({ scopeKeys: store.allScopeKeys() });
const last = stats.lastInjection;
const rows = store.db
  .prepare(
    `SELECT m.id, m.kind, m.status, m.title, m.source_session, u.inject_count, u.read_count
       FROM memory m
       JOIN (SELECT ord, status FROM memory_head) h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      ORDER BY m.created_at DESC`,
  )
  .all();

console.log(`=== ${label} ===`);
console.log(`byStatus            ${JSON.stringify(stats.byStatus)}`);
console.log(`byKind              ${JSON.stringify(stats.byKind)}`);
console.log(`pendingCandidates   ${stats.pendingCandidates}`);
console.log(`lastInjection       bytes=${last?.bytes ?? 'none'} listed=${last?.listed ?? '-'} source=${last?.source ?? '-'}`);
console.log(`lastInjection at    ${last?.ts ? new Date(last.ts).toISOString() : '-'}`);
console.log(`request_stat rows   ${store.db.prepare('SELECT COUNT(*) AS n FROM request_stat').get().n}`);
console.log(`entries             ${rows.length}`);
for (const r of rows) {
  console.log(`  ${r.status.padEnd(10)} ${r.kind.padEnd(10)} inj=${r.inject_count ?? 0} read=${r.read_count ?? 0}  ${JSON.stringify(String(r.title).slice(0, 52))}`);
}
store.close();
