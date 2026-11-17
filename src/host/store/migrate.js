/**
 * Schema migration and rollback.
 *
 * A migration is a small list of steps; each step runs in one immediate
 * transaction after a `VACUUM INTO` snapshot of the database, so a failed
 * upgrade leaves both the old database and a usable backup behind. Rollback is
 * deliberately "restore the snapshot", not a down-migration: a down-migration
 * that has to guess what data to drop is a data-loss tool, and the snapshot is
 * exact.
 * @module dsh-loci/store/migrate
 */
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backupTo, tableCounts, withTransaction } from './db.js';
import { MEMORY_LESSON_DDL, MEMORY_USAGE_DDL } from './schema.js';
import {
  META_KEYS,
  SCHEMA_VERSION,
  applySchema,
  databaseVersion,
  readMeta,
  writeMeta,
} from './schema.js';

/**
 * Migrations shipped by this build. Empty at 1.0.0: the first real step lands
 * with the first backward-compatible schema change. The runner below is the
 * same code a future release uses, and `test/integration/migrate.test.mjs`
 * drives it with a rehearsal step so the path is never untested.
 * @type {Array<{from:number,to:number,up:(db:import('node:sqlite').DatabaseSync)=>void,verify?:(db:import('node:sqlite').DatabaseSync)=>void}>}
 */
export const SHIPPED_MIGRATIONS = [
  {
    from: 1,
    to: 2,
    // v2 adds per-entry usage counters. The table is new and empty, so the
    // migration cannot lose a row; the row-count guard in \`migrate()\` still runs
    // over every existing table and would catch a mistake here.
    up(db) {
      db.exec(MEMORY_USAGE_DDL);
    },
  },
  {
    from: 2,
    to: 3,
    // Four nullable columns: no row can be lost, and every existing entry simply has
    // no lesson shape yet.
    up(db) {
      db.exec(MEMORY_LESSON_DDL);
    },
  },
  {
    from: 3,
    to: 4,
    // One nullable column recording which surface injected a row. Existing rows get
    // NULL and are read as `section`, which is what they were: nothing but the index
    // wrote to this table before the assist started recording itself.
    up(db) {
      db.exec('ALTER TABLE request_stat ADD COLUMN source TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS ix_request_stat_source ON request_stat (source)');
      db.exec("UPDATE request_stat SET source = 'section' WHERE source IS NULL");
    },
  },
  {
    from: 4,
    to: 5,
    // A table and a nullable column, no backfill.
    //
    // `session_scope` remembers the memory boundary a person chose for one conversation.
    // `request_stat.cwd` lets a surface outside the session (the panel) answer "where does
    // this conversation's memory go?" — a scope key is a hash, so it cannot be turned back
    // into a directory, and the panel has no session handle. Existing rows keep NULL and
    // simply have no recorded directory, which the resolver treats as "cannot infer".
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS session_scope (
  session_id TEXT PRIMARY KEY,
  mode       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`);
      db.exec('ALTER TABLE request_stat ADD COLUMN cwd TEXT');
    },
  },
  {
    from: 5,
    to: 6,
    // One table, no backfill and no column changes: a session with no exemption row keeps its
    // current behaviour, so the upgrade changes nobody's answer.
    //
    // `injection_exempt` makes "the memory manager is never given its own memory" a stored fact
    // rather than a side effect of delegation depth. Existing managers, if any were created
    // before this version, simply were not recorded — the table starts empty on purpose rather
    // than guessing which sessions were which.
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS injection_exempt (
  session_id TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);
    },
  },
  {
    from: 6,
    to: 7,
    // The memory unit becomes the store's only clock.
    //
    // Two nullable columns and one table. Nullable because there are two populations: rows written
    // after this version carry a real MU stamp, and rows written before it have no MU history at all —
    // those are backfilled to the current counter value, which says "their clock starts now" rather
    // than inventing a past for them. A fabricated age would be worse than an honest zero: it would
    // make curated entries from months ago look freshly used.
    //
    // The `at` column in mu_event is wall clock, kept only so a person reading the log can line it up
    // with their own day. Nothing reads it as a criterion.
    up(db) {
      addColumnIfMissing(db, 'memory_usage', 'mu_touched', 'REAL');
      addColumnIfMissing(db, 'memory', 'mu_born', 'REAL');
      db.exec(`CREATE TABLE IF NOT EXISTS mu_event (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  mu     REAL NOT NULL,
  add_n  INTEGER NOT NULL,
  use_n  INTEGER NOT NULL,
  reason TEXT NOT NULL
)`);
      const current = Number(readMeta(db, META_KEYS.muNow) ?? 0);
      db.prepare('UPDATE memory_usage SET mu_touched = ? WHERE mu_touched IS NULL').run(current);
      db.prepare('UPDATE memory SET mu_born = ? WHERE mu_born IS NULL').run(current);
      writeMeta(db, META_KEYS.muNow, String(current));
    },
  },
  {
    from: 7,
    to: 8,
    why:
      'A rule about icon placement was injected 397 times into a session about something else. The core ' +
      'took every kind=rule because there was no way to say "this one only applies when the subject ' +
      'comes up" — importance had a column and a sort key but no caller ever passed it, so all 29 rules ' +
      'sat at the default 3 and ordering fell through to a clock that every injection reset. This adds ' +
      'the missing field.',
    // The default is `topic`, applied to every existing row.
    //
    // That is deliberately the conservative reading: we never asked whether a stored rule is standing,
    // so the honest answer is "not proven", and unproven means it goes through retrieval like everything
    // else. Backfilling `always` would preserve the exact behaviour this migration exists to end.
    //
    // A person can reclassify afterwards; `scripts/diag/applies-classify.mjs` produces the list and the
    // evidence for each verdict, and every change is a normal revision the audit keeps.
    up(db) {
      addColumnIfMissing(db, 'memory', 'applies', "TEXT NOT NULL DEFAULT 'topic'");
      db.exec("CREATE INDEX IF NOT EXISTS ix_memory_applies ON memory (scope_key, applies, status)");
      // Rows added by the ALTER carry the default; make it explicit so a later default change cannot
      // silently reinterpret existing data.
      db.prepare("UPDATE memory SET applies = 'topic' WHERE applies IS NULL OR applies = ''").run();
    },
  },
];

/**
 * Add a column only when the table does not already have it.
 *
 * A migration should move a database from one *logical* version to the next, not assume the exact
 * physical shape it starts from: a test that rebuilds a table from the current DDL constant, or a
 * hand-repaired file, can already carry the column. Guarding makes the step re-runnable, where a bare
 * `ALTER` fails with a duplicate-column error on an upgrade path that is hard to reach and harder to
 * debug.
 *
 * @param db - open handle.
 * @param table - table name.
 * @param column - column name.
 * @param type - column type.
 */
function addColumnIfMissing(db, table, column, type) {
  const present = db
    .prepare('PRAGMA table_info(' + table + ')')
    .all()
    .map((row) => row.name);
  if (present.includes(column)) return;
  db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type);
}

/**
 * Whether the file already holds the Loci core table.
 * A version-0 file with a `memory` table is a pre-release database that must
 * be migrated; a version-0 file without one is a brand-new database.
 * @param db - open handle.
 * @returns true when legacy tables exist.
 */
function hasCoreTable(db) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory'")
    .get();
  return row !== undefined;
}

/**
 * Bring a database up to the requested schema version.
 * @param db - open handle.
 * @param options - `migrations`, `target`, `backupDir`, `pluginVersion`, `now`,
 *   `log`, `backup:false` to skip the snapshot (tests that own their own copy).
 * @returns `{from, to, steps, backup}`.
 */
export function migrate(db, options = {}) {
  const now = options.now ?? Date.now();
  const log = options.log;
  const target = options.target ?? SCHEMA_VERSION;
  const migrations = options.migrations ?? SHIPPED_MIGRATIONS;
  const from = databaseVersion(db);

  if (from === 0 && !hasCoreTable(db)) {
    applySchema(db, { pluginVersion: options.pluginVersion, now });
    return { from: 0, to: target, steps: ['create'], backup: undefined };
  }

  if (from > target) {
    throw new Error(
      `database schema v${from} is newer than this build (v${target}); upgrade dsh-loci instead of downgrading`,
    );
  }
  if (from === target) return { from, to: target, steps: [], backup: undefined };

  let backup;
  if (options.backup !== false && options.backupDir) {
    backup = join(options.backupDir, `pre-v${target}-${now}.db`);
    backupTo(db, backup);
    pruneBackups(options.backupDir, 5);
    log?.info?.(`loci: schema v${from} -> v${target}, snapshot at ${backup}`);
  }

  const steps = [];
  let version = from;
  while (version < target) {
    const step = migrations.find((entry) => entry.from === version);
    if (step === undefined) {
      throw new Error(`no migration from schema v${version} to v${version + 1}`);
    }
    const before = tableCounts(db);
    withTransaction(db, () => {
      step.up(db);
      writeMeta(db, META_KEYS.schemaVersion, String(step.to));
      db.exec(`PRAGMA user_version = ${Number(step.to)}`);
      step.verify?.(db);
    });
    const after = tableCounts(db);
    for (const [table, count] of Object.entries(before)) {
      if ((after[table] ?? 0) < count) {
        throw new Error(`migration v${step.from}->v${step.to} lost rows in ${table}: ${count} -> ${after[table]}`);
      }
    }
    steps.push(`v${step.from}->v${step.to}`);
    version = step.to;
  }

  return { from, to: version, steps, backup };
}

/**
 * Keep the newest `keep` snapshots in a backup directory.
 * @param dir - backup directory.
 * @param keep - how many files to retain.
 */
export function pruneBackups(dir, keep = 5) {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((name) => /^pre-v\d+-\d+\.db$/.test(name))
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const file of files.slice(keep)) rmSync(join(dir, file.name), { force: true });
}

/**
 * Replace the live database with a snapshot. Caller must have closed every
 * handle; the WAL and SHM sidecars are removed so the restored file is the
 * whole story.
 * @param dbFile - live database path.
 * @param backupFile - snapshot to restore.
 * @returns the restored path.
 */
export function restoreDatabaseFile(dbFile, backupFile) {
  if (!existsSync(backupFile)) throw new Error(`backup not found: ${backupFile}`);
  const target = `${dbFile}.restore-${Date.now()}`;
  copyFileSync(backupFile, target);
  rmSync(dbFile, { force: true });
  rmSync(`${dbFile}-wal`, { force: true });
  rmSync(`${dbFile}-shm`, { force: true });
  copyFileSync(target, dbFile);
  rmSync(target, { force: true });
  return dbFile;
}

/**
 * The newest snapshot in a directory, for `doctor` and the CLI.
 * @param dir - backup directory.
 * @returns the path, or undefined.
 */
export function newestBackup(dir) {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((name) => /^pre-v\d+-\d+\.db$/.test(name))
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return files.length === 0 ? undefined : join(dir, files[0].name);
}

export { databaseVersion, readMeta };
