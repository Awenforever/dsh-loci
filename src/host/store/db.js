/**
 * SQLite access: one connection per process, WAL, a busy timeout, and a
 * bounded retry around `BEGIN IMMEDIATE`.
 *
 * `node:sqlite` is synchronous, so a lock attempt blocks the event loop. The
 * design keeps transactions tiny (single-digit milliseconds) and bounds the
 * wait, so a contended write costs a short pause instead of a lost row or a
 * `database is locked` error escaping to the model.
 * @module dsh-loci/store/db
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Busy timeout handed to SQLite for every connection. */
export const BUSY_TIMEOUT_MS = 3000;

/** How many times one logical write retries a busy database. */
export const WRITE_RETRIES = 6;

/**
 * Block the current thread for a few milliseconds.
 * `node:sqlite` is synchronous, so an async sleep would not actually yield the
 * connection we need to wait on.
 * @param ms - milliseconds to pause.
 */
export function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether an error is SQLite telling us to try again.
 * @param error - thrown value.
 * @returns true for BUSY/LOCKED.
 */
export function isBusyError(error) {
  const message = String(error?.message ?? error ?? '');
  return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

/**
 * Open a Loci database file.
 * @param options - `file`, `readOnly`, `timeoutMs`, `memory`.
 * @returns an open `DatabaseSync`.
 */
export function openDatabase({ file, readOnly = false, timeoutMs = BUSY_TIMEOUT_MS, memory = false }) {
  if (!memory) {
    if (readOnly) {
      if (!existsSync(file)) throw new Error(`database does not exist: ${file}`);
    } else {
      mkdirSync(dirname(file), { recursive: true });
    }
  }
  const db = new DatabaseSync(memory ? ':memory:' : file, {
    // `readOnly` is the documented spelling; a lowercase `readonly` is silently
    // ignored by node:sqlite and would open the file writable.
    readOnly,
    timeout: timeoutMs,
    enableForeignKeyConstraints: true,
  });
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA wal_autocheckpoint = 512');
  }
  db.exec(`PRAGMA busy_timeout = ${Number(timeoutMs) || BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA temp_store = MEMORY');
  return db;
}

/**
 * Close a database, tolerating an already-closed handle.
 * @param db - handle to close.
 */
export function closeDatabase(db) {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
}

/**
 * Run `fn` inside `BEGIN IMMEDIATE ... COMMIT`, retrying a busy database with
 * jittered exponential backoff.
 * @param db - open handle.
 * @param fn - synchronous body; receives no arguments and may throw to roll back.
 * @param options - `retries`, `onRetry(attempt, error)`.
 * @returns whatever `fn` returns.
 */
export function withTransaction(db, fn, options = {}) {
  const retries = options.retries ?? WRITE_RETRIES;
  const onRetry = options.onRetry;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if (isBusyError(error) && attempt <= retries) {
        const delay = Math.min(400, 8 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 8);
        onRetry?.(attempt, error);
        sleepSync(delay);
        continue;
      }
      throw error;
    }
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* a failed ROLLBACK must not mask the original error */
      }
      if (isBusyError(error) && attempt <= retries) {
        const delay = Math.min(400, 8 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 8);
        onRetry?.(attempt, error);
        sleepSync(delay);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Copy a database into a fresh file with `VACUUM INTO`. Runs outside any
 * transaction and produces a consistent snapshot.
 * @param db - open handle.
 * @param targetFile - destination; must not exist.
 */
export function backupTo(db, targetFile) {
  mkdirSync(dirname(targetFile), { recursive: true });
  if (existsSync(targetFile)) rmSync(targetFile, { force: true });
  db.prepare('VACUUM INTO ?').run(targetFile);
  return targetFile;
}

/**
 * `PRAGMA quick_check`, the fast startup probe.
 * @param db - open handle.
 * @returns `'ok'` or the first reported problem.
 */
export function quickCheck(db) {
  const row = db.prepare('PRAGMA quick_check(1)').get();
  return row ? String(Object.values(row)[0]) : 'unknown';
}

/**
 * `PRAGMA integrity_check`, the thorough probe used by doctor and tests.
 * @param db - open handle.
 * @returns `'ok'` or the first reported problem.
 */
export function integrityCheck(db) {
  const rows = db.prepare('PRAGMA integrity_check(20)').all();
  const values = rows.map((row) => String(Object.values(row)[0]));
  return values.length === 1 && values[0] === 'ok' ? 'ok' : values.join('; ');
}

/** Table names whose row counts are reported by doctor and post-migration checks. */
export const COUNTED_TABLES = Object.freeze([
  'memory',
  'memory_head',
  'entity',
  'memory_entity',
  'memory_edge',
  'embedding',
]);

/**
 * Row counts for the tables a migration must preserve.
 * @param db - open handle.
 * @returns a map of table name to count.
 */
export function tableCounts(db) {
  const counts = {};
  for (const table of COUNTED_TABLES) {
    counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
  }
  return counts;
}
