#!/usr/bin/env node
/**
 * Is the stray "MU" coming from the renderer or from stored text?
 *
 * The renderer's every `ago` site is μ (U+03BC) and the slice proves the bytes are right, yet the stable
 * section still contains ASCII "MU". Either something is cached, or a memory's own text contains it.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.3' });

// Every column a rendered line could be built from.
const hits = store.db
  .prepare(
    `SELECT m.id, m.title, m.body, m.prevents
       FROM memory m
      WHERE m.valid_to IS NULL
        AND (m.title LIKE '%MU%' OR m.body LIKE '%MU%' OR COALESCE(m.prevents,'') LIKE '%MU%')`,
  )
  .all();

console.log(`memory rows whose own text contains "MU": ${hits.length}`);
for (const row of hits) {
  const where = row.title.includes('MU') ? 'title' : row.body.includes('MU') ? 'body' : 'prevents';
  console.log(`  ${row.id}  in ${where}`);
  console.log(`    ${JSON.stringify(String(row[where]).slice(0, 160))}`);
}

// The section and report caches, if any, would also carry it.
for (const table of ['memory_head', 'memory_revision']) {
  try {
    const columns = store.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    console.log(`\n${table} columns: ${columns.join(', ')}`);
  } catch {
    console.log(`\n${table}: not present`);
  }
}
store.close();
