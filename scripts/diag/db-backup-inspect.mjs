#!/usr/bin/env node
/**
 * Inspect a database backup and report what it holds.
 *
 * Written after a scoped purge overshot: the `--only=<source>` filter was applied to the report but not
 * to the id list the purge loop uses, so it removed everything. The backup taken before that loop is the
 * recovery path, and recovery needs to know what is actually in it.
 *
 * Usage: node scripts/diag/db-backup-inspect.mjs <path-to-backup.db>
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';

const file = process.argv[2];
if (file === undefined || !existsSync(file)) {
  console.error('usage: node scripts/diag/db-backup-inspect.mjs <backup.db>');
  process.exit(2);
}

console.log(`backup ${file} (${statSync(file).size} bytes)`);
const db = new DatabaseSync(file, { readOnly: true });

const rows = db
  .prepare(
    `SELECT m.id, m.kind, m.scope, m.scope_key, m.scope_label, m.title, m.body, m.trust_source,
            m.status, m.evidence, m.verified_at, m.source_session, h.status AS head_status
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE m.valid_to IS NULL
      ORDER BY m.created_at`,
  )
  .all();

const bySource = {};
for (const row of rows) bySource[row.trust_source] = (bySource[row.trust_source] ?? 0) + 1;
console.log(`live rows: ${rows.length}  ${JSON.stringify(bySource)}\n`);

for (const row of rows) {
  console.log(`[${row.trust_source}] ${row.kind} · ${row.head_status}`);
  console.log(`  ${row.title}`);
  console.log(`  id=${row.id} scope=${String(row.scope_key).slice(0, 44)}`);
}
db.close();
