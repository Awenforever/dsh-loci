#!/usr/bin/env node
/**
 * Find memory entries that are echoes of the injected block, and say what it would cost to remove them.
 *
 * Read-only by default. `--apply` soft-deletes them (revisions are kept, the audit records it), because
 * this removes rows a person may have seen; nothing here physically deletes.
 *
 * Usage: node scripts/diag/index-echo-cleanup.mjs [--apply]
 */
import { effectiveConfig } from '../../src/host/config.js';
import { looksLikeIndexLine } from '../../src/host/inject/fence.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const apply = process.argv.includes('--apply');
const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.3' });

const rows = store.db
  .prepare(
    `SELECT m.id, m.kind, m.trust_source, m.created_at, m.title, m.body, h.status
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE m.valid_to IS NULL AND h.status <> 'deleted'
      ORDER BY m.created_at`,
  )
  .all();

const echoes = rows.filter((row) => looksLikeIndexLine(row.title) || looksLikeIndexLine(row.body));

console.log(`live entries ${rows.length} · index echoes ${echoes.length}`);
for (const row of echoes) {
  const where = looksLikeIndexLine(row.title) ? 'title' : 'body';
  console.log(`\n  ${row.id}  ${row.kind}/${row.trust_source}/${row.status}`);
  console.log(`    created : ${new Date(Number(row.created_at)).toISOString().slice(0, 19)}`);
  console.log(`    in ${where}: ${JSON.stringify(String(row[where]).slice(0, 150))}`);
}

// What the echo is quoting matters: if it points at a real entry, that entry survives and the echo goes.
const cited = new Set();
for (const row of echoes) {
  const match = String(row.title).match(/\b(m_[0-9A-Z]{20,})\b/);
  if (match !== null) cited.add(match[1]);
}
if (cited.size > 0) {
  console.log(`\ncited entry ids: ${[...cited].join(', ')}`);
  for (const id of cited) {
    const exists = store.db.prepare('SELECT id, title FROM memory WHERE id = ? AND valid_to IS NULL').get(id);
    console.log(`  ${id}: ${exists === undefined ? 'not present (the original may also have been an echo)' : JSON.stringify(String(exists.title).slice(0, 90))}`);
  }
}

if (echoes.length === 0) {
  console.log('\nnothing to clean');
} else if (!apply) {
  console.log(`\ndry run: would soft-delete ${echoes.length} entries. Re-run with --apply.`);
} else {
  let removed = 0;
  for (const row of echoes) {
    try {
      store.forget(row.id, { reason: 'index-echo: this entry is a copy of an injected index line, not something the user said' });
      removed += 1;
    } catch (error) {
      console.log(`  could not forget ${row.id}: ${String(error?.message ?? error)}`);
    }
  }
  console.log(`\nsoft-deleted ${removed} of ${echoes.length}`);
}
store.close();
