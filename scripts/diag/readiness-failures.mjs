#!/usr/bin/env node
/** What the readiness check flagged: one echo and three entries carrying the old "MU" marker. Read-only. */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.2.3' });

const echo = store.db
  .prepare(
    `SELECT m.id, m.title, m.trust_source, m.applies, m.created_at, h.status
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE h.status = 'verified' AND m.valid_to IS NULL
        AND (m.title LIKE '- m\\_%' ESCAPE '\\' OR m.title LIKE 'm\\_%' ESCAPE '\\')`,
  )
  .all();
console.log(`echoes: ${echo.length}`);
for (const row of echo) {
  console.log(`  ${row.id}  ${row.trust_source}/${row.applies}  created ${new Date(Number(row.created_at)).toISOString().slice(0, 19)}`);
  console.log(`    ${JSON.stringify(String(row.title).slice(0, 100))}`);
}

const mu = store.db
  .prepare("SELECT m.id, m.title, m.trust_source, h.status FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE m.valid_to IS NULL AND m.title LIKE '%MU ago%'")
  .all();
console.log(`\ntitles carrying "MU ago": ${mu.length}`);
for (const row of mu) {
  console.log(`  ${row.id}  ${row.trust_source}/${row.status}`);
  console.log(`    ${JSON.stringify(String(row.title).slice(0, 100))}`);
}

// Are these the same rows the cleanup script targets, or a different shape it does not match?
const { looksLikeIndexLine } = await import('../../src/host/inject/fence.js');
console.log('\nwould looksLikeIndexLine catch them?');
for (const row of [...echo, ...mu]) {
  console.log(`  ${row.id}: ${looksLikeIndexLine(row.title)}`);
}
store.close();
