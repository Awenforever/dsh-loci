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
];

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
