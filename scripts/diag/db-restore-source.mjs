#!/usr/bin/env node
/**
 * Restore the curator-written rows from a backup, without restoring anything else.
 *
 * Reinserted through `store.write` rather than by copying rows, so the FTS index, entity links and
 * token statistics are rebuilt the way the application builds them; a raw INSERT would leave the full
 * text search blind to the restored entries.
 *
 * Their recorded status is carried across explicitly, because it cannot be recomputed: the quote gate
 * needs the conversation the quote came from, and those transcripts are gone. Re-deriving it would
 * silently demote every restored entry to `candidate`.
 *
 * Usage: node scripts/diag/db-restore-source.mjs <backup.db> <trust_source> [--yes]
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const [file, source] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const confirmed = process.argv.includes('--yes');
if (file === undefined || source === undefined || !existsSync(file)) {
  console.error('usage: node scripts/diag/db-restore-source.mjs <backup.db> <trust_source> [--yes]');
  process.exit(2);
}

const backup = new DatabaseSync(file, { readOnly: true });
const rows = backup
  .prepare(
    `SELECT m.kind, m.scope, m.scope_key, m.scope_label, m.title, m.body, m.tags, m.entities,
            m.pinned, m.evidence, m.source_session, m.verified_at, m.trust_source, h.status
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE m.valid_to IS NULL AND m.trust_source = ?
      ORDER BY m.created_at`,
  )
  .all(source);
backup.close();

console.log(`rows to restore from ${file}: ${rows.length} (trust_source=${source})`);
for (const row of rows) console.log(`  [${row.status}] ${row.kind} · ${row.title.slice(0, 60)}`);
if (!confirmed) {
  console.log('\ndry run: pass --yes to write them into the live store');
  process.exit(0);
}

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.13.0' });

let written = 0;
for (const row of rows) {
  try {
    store.write({
      kind: row.kind,
      scope: row.scope,
      scopeKey: row.scope_key,
      scopeLabel: row.scope_label,
      title: row.title,
      body: row.body,
      tags: JSON.parse(row.tags ?? '[]'),
      entities: JSON.parse(row.entities ?? '[]'),
      pinned: Number(row.pinned) === 1,
      evidence: JSON.parse(row.evidence ?? '{}'),
      sourceSession: row.source_session ?? undefined,
      trustSource: row.trust_source,
      status: row.status,
    });
    written += 1;
  } catch (error) {
    console.log(`  failed "${row.title.slice(0, 40)}": ${String(error?.message ?? error)}`);
  }
}

const live = store.db
  .prepare("SELECT trust_source, h.status, COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE m.valid_to IS NULL GROUP BY 1, 2")
  .all();
console.log(`\nrestored ${written} row(s)`);
console.log(`live store now: ${JSON.stringify(live)}`);
store.close();
