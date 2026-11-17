#!/usr/bin/env node
/** Find the entries a diagnostic probe left behind, so they can be removed. Read-only unless --apply. */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const apply = process.argv.includes('--apply');
const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.2.2' });

const rows = store.db
  .prepare(
    `SELECT m.id, m.scope_key, m.title, h.status
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE m.valid_to IS NULL AND h.status <> 'deleted'
        AND (m.scope_key LIKE '%probe%' OR m.title LIKE '探针%')`,
  )
  .all();

console.log(`probe entries: ${rows.length}`);
for (const row of rows) {
  console.log(`  ${row.id}  ${row.scope_key}  ${JSON.stringify(String(row.title).slice(0, 50))}`);
  if (apply) {
    store.forget(row.id, { reason: 'diagnostic probe — verified the supplied-audit signal end to end, no content' });
  }
}
if (!apply) console.log('\ndry run. Re-run with --apply to soft-delete.');
else console.log(`\nsoft-deleted ${rows.length}`);
store.close();
