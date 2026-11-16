#!/usr/bin/env node
/** Print the curator-written facts in full, so a reset can be judged rather than assumed. */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.11.0' });

const rows = store.db
  .prepare(
    `SELECT m.kind, m.title, m.body, m.scope_key, h.status
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE m.valid_to IS NULL AND m.trust_source = 'curator'
      ORDER BY m.created_at`,
  )
  .all();

console.log(`curator facts: ${rows.length}\n`);
for (const row of rows) {
  console.log(`[${row.kind}] ${row.title}`);
  console.log(`    ${String(row.body).replace(/\s+/g, ' ').slice(0, 150)}`);
  console.log(`    scope ${String(row.scope_key).slice(0, 46)}\n`);
}
store.close();
