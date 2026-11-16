#!/usr/bin/env node
/** What did the curator actually write, from which conversation, and can it be trusted? */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.10.1' });

const tables = store.db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((row) => row.name);
console.log(`tables: ${tables.join(', ')}\n`);

const rows = store.db
  .prepare(
    `SELECT m.id, m.kind, m.scope_key, m.title, m.body, h.status
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE m.trust_source = 'curator' AND m.valid_to IS NULL
      ORDER BY m.created_at DESC`,
  )
  .all();

console.log(`curator-written entries: ${rows.length}\n`);
const evidenceTable = tables.includes('evidence') ? 'evidence' : tables.includes('memory_evidence') ? 'memory_evidence' : undefined;
for (const row of rows) {
  console.log(`  ${row.status.toUpperCase()}  ${row.kind} · ${row.scope_key}`);
  console.log(`    ${row.title}`);
  console.log(`    body: ${String(row.body).replace(/\s+/g, ' ').slice(0, 120)}`);
  if (evidenceTable !== undefined) {
    const columns = store.db
      .prepare(`PRAGMA table_info(${evidenceTable})`)
      .all()
      .map((column) => column.name);
    const key = columns.includes('memory_id') ? 'memory_id' : columns.includes('mem_id') ? 'mem_id' : undefined;
    if (key !== undefined) {
      const quoteColumn = columns.includes('quote') ? 'quote' : columns.includes('text') ? 'text' : undefined;
      const evidence = store.db
        .prepare(`SELECT * FROM ${evidenceTable} WHERE ${key} = ? LIMIT 1`)
        .get(row.id);
      if (evidence !== undefined && quoteColumn !== undefined) {
        console.log(`    quote: "${String(evidence[quoteColumn]).slice(0, 88)}"`);
      }
    }
  }
  console.log('');
}

const byStatus = store.db
  .prepare(
    `SELECT h.status, COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE m.trust_source = 'curator' GROUP BY h.status`,
  )
  .all();
console.log('curator entries by status:', JSON.stringify(byStatus));
store.close();
