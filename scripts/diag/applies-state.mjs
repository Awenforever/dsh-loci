#!/usr/bin/env node
/** What the store looks like right after the verdict migration. Read-only. */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.6' });

const dist = store.db
  .prepare(
    "SELECT applies, COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE h.status = 'verified' AND m.valid_to IS NULL GROUP BY applies",
  )
  .all();
console.log('applies distribution:', JSON.stringify(dist));

const always = store.db
  .prepare(
    "SELECT m.id, m.title, m.when_condition FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE h.status = 'verified' AND m.valid_to IS NULL AND m.applies = 'always'",
  )
  .all();
console.log(`\nalways entries: ${always.length}`);
for (const row of always) {
  console.log(`  ${row.id}  ${JSON.stringify(String(row.title).slice(0, 62))}`);
}

const conditional = store.db
  .prepare(
    "SELECT m.id, m.title, m.when_condition FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE h.status = 'verified' AND m.valid_to IS NULL AND m.when_condition IS NOT NULL",
  )
  .all();
console.log(`\nentries carrying a condition: ${conditional.length}`);
for (const row of conditional) {
  console.log(`  ${row.id}  when: ${JSON.stringify(String(row.when_condition).slice(0, 50))}`);
  console.log(`    ${JSON.stringify(String(row.title).slice(0, 62))}`);
}

const merged = store.db
  .prepare("SELECT id, title FROM memory WHERE id IN ('m_01M7KSYMNBQS5H45W0NV','m_01M7KSXM30MPXSNAP4YG') AND valid_to IS NULL")
  .all();
console.log(`\nmerge sources still live: ${merged.length} (expect 0)`);
store.close();
