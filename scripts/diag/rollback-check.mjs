#!/usr/bin/env node
/**
 * Can this be rolled back?
 *
 * Schema v8 added `memory.applies`. A production deployment that cannot be reverted is not ready, and
 * "revert" here means running the previous plugin version against a database that has the new column.
 *
 * Two questions, and they have different answers:
 *
 *   1. Does 5.1.5 still **read** a v8 database? SQLite ignores unknown columns, so probably yes — but the
 *      schema_version meta key is 8, and a version check might refuse to open it.
 *   2. If it refuses, is the migration reversible? v7→v8 only added a column, so dropping it is enough —
 *      but the rollback path has to be *written down and tested*, not assumed.
 *
 * This runs entirely on a **copy** of the production database. Nothing here touches the live store.
 *
 * Usage: node scripts/diag/rollback-check.mjs
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const LIVE = join(process.env.USERPROFILE ?? '', '.dsh', 'memory', 'loci', 'memory.db');
if (!existsSync(LIVE)) {
  console.error(`live database not found at ${LIVE}`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'loci-rollback-'));
const copy = join(work, 'memory.db');
copyFileSync(LIVE, copy);
console.log(`copied ${(statSync(LIVE).size / 1024).toFixed(0)} KB to ${copy}\n`);

const inspect = (label, db) => {
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const userVersion = db.prepare('PRAGMA user_version').get();
  const columns = db.prepare('PRAGMA table_info(memory)').all().map((column) => column.name);
  const applies = columns.includes('applies');
  console.log(`${label}`);
  console.log(`  meta.schema_version ${version?.value} · PRAGMA user_version ${Object.values(userVersion ?? {})[0]}`);
  console.log(`  memory.applies present ${applies}`);
  return { version: Number(version?.value ?? 0), applies };
};

// --- what the live database looks like now
const db = new DatabaseSync(copy);
const before = inspect('current (v8, after 5.2.x)', db);

// --- question 1: does an older client still read it?
//
// The older client's own check is `schemaVersion` in meta; a mismatch is what would stop it. Rather than
// guessing at the old code, simulate the simplest possible reader: select the columns 5.1.5 knew about.
try {
  const rows = db
    .prepare('SELECT id, kind, title, pinned, importance, mu_born FROM memory WHERE valid_to IS NULL LIMIT 3')
    .all();
  console.log(`\n  an old-style SELECT of v7 columns still works: ${rows.length} rows`);
} catch (error) {
  console.log(`\n  old-style SELECT failed: ${String(error?.message ?? error)}`);
}

// --- question 2: is the migration reversible?
//
// Order matters and the first version of this script got it wrong: dropping a column while an index still
// references it fails, and the failure leaves the column in place — so the "re-apply" afterwards reports
// `duplicate column name` and the database is stuck between two shapes. Index first, then column.
//
// v9 added two columns at once (`p_base`, `mu_base`) plus a position index, so the reversal has to drop all
// three. The anchors are lost, which is stated in `docs/PRODUCTION.md` §6.1: reverting the schema discards
// classification, and it now also discards position.
console.log('\nrolling back the latest migration on the copy:');
try {
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('memory','memory_usage') AND (sql LIKE '%applies%' OR sql LIKE '%p_base%')",
    )
    .all()
    .map((row) => row.name);
  console.log(`  indexes to drop: ${indexes.length === 0 ? '(none)' : indexes.join(', ')}`);
  for (const name of indexes) db.exec(`DROP INDEX IF EXISTS ${name}`);

  const usageColumns = db.prepare('PRAGMA table_info(memory_usage)').all().map((column) => column.name);
  for (const column of ['p_base', 'mu_base']) {
    if (usageColumns.includes(column)) db.exec(`ALTER TABLE memory_usage DROP COLUMN ${column}`);
  }
  if (before.applies) db.exec('ALTER TABLE memory DROP COLUMN applies');

  db.prepare("UPDATE meta SET value = '7' WHERE key = 'schema_version'").run();
  db.exec('PRAGMA user_version = 7');
  const after = inspect('after rollback (v7 shape)', db);
  console.log(`  applies gone: ${before.applies && !after.applies}`);
  console.log(`  anchors gone: ${!db.prepare('PRAGMA table_info(memory_usage)').all().some((column) => column.name === 'p_base')}`);
  console.log(`  version back to 7: ${after.version === 7}`);
} catch (error) {
  console.log(`  rollback failed: ${String(error?.message ?? error)}`);
}

// --- and does re-migrating work? a rollback nobody can come back from is a trap.
console.log('\nre-applying the migration (the rollback must itself be reversible):');
try {
  db.exec("ALTER TABLE memory ADD COLUMN applies TEXT NOT NULL DEFAULT 'topic'");
  db.prepare("UPDATE meta SET value = '8' WHERE key = 'schema_version'").run();
  db.exec('PRAGMA user_version = 8');
  const counts = db.prepare('SELECT applies, COUNT(*) AS n FROM memory GROUP BY applies').all();
  console.log(`  re-added; distribution ${JSON.stringify(counts.map((row) => ({ ...row })))}`);
  console.log('  note: every entry returns as `topic` — the standing verdicts from the migration are NOT restored,');
  console.log('  because rollback dropped the column that held them. Re-applying is lossless for content and');
  console.log('  lossy for classification; the four standing entries have to be re-marked by hand.');
} catch (error) {
  console.log(`  re-apply failed: ${String(error?.message ?? error)}`);
}

db.close();
rmSync(work, { recursive: true, force: true });
console.log(`\ncleaned ${work}`);
