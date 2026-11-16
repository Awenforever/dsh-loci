#!/usr/bin/env node
/** Did the curator write anything from a real, ended conversation? */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.7.0' });

const bySource = store.db
  .prepare(
    `SELECT COALESCE(m.trust_source, '(none)') AS src, h.status, COUNT(*) AS n
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      GROUP BY src, h.status ORDER BY n DESC`,
  )
  .all();
console.log('by source / status:');
for (const row of bySource) {
  console.log(`  ${String(row.src).padEnd(10)} ${String(row.status).padEnd(11)} ${row.n}`);
}

const recent = store.db
  .prepare(
    `SELECT m.id, m.trust_source, m.scope, m.title, m.created_at, h.status
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      ORDER BY m.created_at DESC LIMIT 6`,
  )
  .all();
console.log('\nnewest 6:');
for (const row of recent) {
  console.log(
    `  ${String(row.status).padEnd(10)} ${String(row.trust_source).padEnd(9)} ${String(row.scope).padEnd(10)} ` +
      `${new Date(row.created_at).toISOString().slice(11, 19)}  ${JSON.stringify(String(row.title).slice(0, 44))}`,
  );
}

const curatorRows = store.db
  .prepare("SELECT COUNT(*) AS n FROM memory m WHERE m.trust_source = 'curator'")
  .get().n;
console.log(`\ncurator-sourced entries: ${curatorRows}`);
store.close();
