#!/usr/bin/env node
/** What did the curator actually record? Read-only. */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.4.0' });

const rows = store.db
  .prepare(
    `SELECT m.id, m.kind, m.scope, m.title, m.trust_source, m.created_at, h.status
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      ORDER BY m.created_at DESC LIMIT 8`,
  )
  .all();

console.log('status     kind        scope      source     created              title');
for (const row of rows) {
  console.log(
    `${String(row.status).padEnd(10)} ${String(row.kind).padEnd(11)} ${String(row.scope).padEnd(10)} ` +
      `${String(row.trust_source).padEnd(10)} ${new Date(row.created_at).toISOString().slice(0, 19)}  ${JSON.stringify(String(row.title).slice(0, 56))}`,
  );
}

const bySource = store.db
  .prepare(
    `SELECT m.trust_source AS source, h.status, COUNT(*) AS n
       FROM memory m JOIN memory_head h ON h.ord = m.ord GROUP BY m.trust_source, h.status`,
  )
  .all();
console.log('\nby source / status:');
for (const row of bySource) console.log(`  ${String(row.source).padEnd(10)} ${String(row.status).padEnd(10)} ${row.n}`);
store.close();
