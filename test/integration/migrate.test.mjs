import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { ensureMemoryRoot, layout } from '../../src/host/paths.js';
import { closeDatabase, openDatabase, tableCounts } from '../../src/host/store/db.js';
import { migrate, restoreDatabaseFile } from '../../src/host/store/migrate.js';
import { SCHEMA_VERSION, databaseVersion } from '../../src/host/store/schema.js';
import { Store } from '../../src/host/store/store.js';

/** One rehearsal step: a real, additive column, applied from the previous version. */
const REHEARSAL_TO = SCHEMA_VERSION;
const REHEARSAL = [
  {
    from: SCHEMA_VERSION - 1,
    to: REHEARSAL_TO,
    up(db) {
      db.exec('ALTER TABLE memory ADD COLUMN note TEXT');
      db.exec('UPDATE memory SET note = title WHERE note IS NULL');
    },
    verify(db) {
      const nulls = Number(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE note IS NULL').get()?.n ?? 0);
      if (nulls !== 0) throw new Error(`rehearsal migration left ${nulls} rows without a note`);
    },
  },
];

/**
 * Rewind an open database to an earlier schema version, so a test starts from the
 * same place a user on an older release would be. This is a fixture, not a supported
 * operation: it drops what the newer versions added and flips the version stamp.
 */
function rewind(db, target) {
  const columns = () => db.prepare('PRAGMA table_info(memory)').all().map((row) => row.name);
  if (target < 3) {
    // v3 added the lesson shape.
    for (const column of ['pattern', 'fix', 'prevents', 'when_condition']) {
      if (columns().includes(column)) db.exec(`ALTER TABLE memory DROP COLUMN ${column}`);
    }
  }
  if (target < 2) db.exec('DROP TABLE IF EXISTS memory_usage');
  if (target < 4) {
    // v4 added the injection surface. Dropping it here is the whole point of `rewind`:
    // the "old" database must not already contain what the migration is supposed to add,
    // or the migration fails with "duplicate column name" and the test proves nothing.
    db.exec('DROP INDEX IF EXISTS ix_request_stat_source');
    const requestColumns = () => db.prepare('PRAGMA table_info(request_stat)').all().map((row) => row.name);
    if (requestColumns().includes('source')) db.exec('ALTER TABLE request_stat DROP COLUMN source');
  }
  if (target < 5) {
    // v5 added the per-conversation memory boundary and the recorded directory.
    db.exec('DROP TABLE IF EXISTS session_scope');
    const columns5 = () => db.prepare('PRAGMA table_info(request_stat)').all().map((row) => row.name);
    if (columns5().includes('cwd')) db.exec('ALTER TABLE request_stat DROP COLUMN cwd');
  }
  if (target < 6) {
    // v6 added the injection exemption. Without this the table would survive the rewind and the
    // v5->v6 step would be a no-op, so the test would report a passing chain that never created
    // it — the exact shape of a test that proves nothing.
    db.exec('DROP TABLE IF EXISTS injection_exempt');
  }
  db.exec(`PRAGMA user_version = ${target}`);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(target));
}

test('a rehearsal upgrade keeps every row and the snapshot rolls back exactly', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-migrate-'));
  const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const paths = layout(root);
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const store = new Store({ memoryRoot: root, paths, config: effectiveConfig({}), pluginVersion: '1.0.0' });
  const scopes = { scopeKey: 'workspace:test', scopeLabel: 'test' };
  for (let i = 0; i < 5; i += 1) {
    store.write({
      scope: 'workspace',
      ...scopes,
      kind: 'semantic',
      trustSource: 'user',
      title: `迁移前的事实 ${i}`,
      body: `第 ${i} 条，用来验证升级不丢数据。`,
    });
  }
  const before = store.health().counts;
  const auditBefore = store.auditTail(100).length;
  store.close();

  const previous = SCHEMA_VERSION - 1;
  /** Set inside the try block; the restore must run after the handle closes. */
  let backupPath;
  const db = openDatabase({ file: paths.db });
  try {
    rewind(db, previous);
    const result = migrate(db, {
      migrations: REHEARSAL,
      target: REHEARSAL_TO,
      backupDir: paths.backups,
      now: 1_700_000_000_000,
    });
    assert.deepEqual(result.steps, [`v${previous}->v${REHEARSAL_TO}`]);
    assert.equal(databaseVersion(db), REHEARSAL_TO);
    assert.ok(existsSync(result.backup), 'a snapshot must exist before the migration');
    const after = tableCounts(db);
    // `memory_usage` is created by the shipped v1->v2 step, not by the rehearsal, so
    // it is absent from the rewind point and appears after the rehearsal's own table
    // set is unchanged. Compare only the tables that existed before.
    for (const [table, count] of Object.entries(before)) {
      if (table === 'memory_usage') continue;
      assert.equal(after[table] ?? 0, count, `${table} keeps its row count`);
    }
    const noted = Number(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE note IS NOT NULL').get()?.n ?? 0);
    assert.equal(noted, before.memory);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    // The restore has to happen after the handle closes; on Windows an open handle
    // holds a lock and the file replace fails with EPERM.
    backupPath = result.backup;
  } finally {
    closeDatabase(db);
  }

  restoreDatabaseFile(paths.db, backupPath);

  // The audit log is append-only and must survive both directions.
  assert.equal(store.auditTail(100).length, auditBefore);

  const restored = openDatabase({ file: paths.db });
  try {
    assert.equal(databaseVersion(restored), previous, 'rollback restores the previous schema version');
    const columns = restored.prepare('PRAGMA table_info(memory)').all().map((row) => row.name);
    assert.equal(columns.includes('note'), false, 'the rehearsal column is gone after rollback');
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    closeDatabase(restored);
  }
});

test('the shipped migration chain keeps every row and adds every shape', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-migrate-shipped-'));
  const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const paths = layout(root);
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const store = new Store({ memoryRoot: root, paths, config: effectiveConfig({}), pluginVersion: '2.1.0' });
  store.write({
    scope: 'workspace',
    scopeKey: 'workspace:test',
    scopeLabel: 'test',
    kind: 'semantic',
    trustSource: 'user',
    title: '迁移前的一条',
    body: '它必须在升级后还在。',
  });
  const before = tableCounts(store.db);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'memory_usage'").get().n, 1);
  store.close();

  // Start from v1: this test is about the whole shipped chain, not a single step.
  const previous = 1;
  const db = openDatabase({ file: paths.db });
  try {
    rewind(db, previous);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'memory_usage'").get().n, 0);

    // Ship migrations only: this is the path a real upgrade takes.
    const result = migrate(db, { target: SCHEMA_VERSION, backupDir: paths.backups });
    // Derived from SCHEMA_VERSION so adding a migration does not mean editing this list:
    // the assertion is "every step ran in order, none was skipped".
    const expectedSteps = Array.from({ length: SCHEMA_VERSION - 1 }, (_, index) => `v${index + 1}->v${index + 2}`);
    assert.deepEqual(result.steps, expectedSteps);
    assert.equal(databaseVersion(db), SCHEMA_VERSION);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'memory_usage'").get().n,
      1,
      'the usage table must exist after the migration',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM memory').get().n,
      before.memory,
      'no memory row was lost',
    );
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    closeDatabase(db);
  }
});

test('opening a newer database refuses instead of guessing', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-migrate-newer-'));
  const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const paths = layout(root);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store({ memoryRoot: root, paths, config: effectiveConfig({}), pluginVersion: '1.0.0' });
  store.close();
  const db = openDatabase({ file: paths.db });
  try {
    db.exec('PRAGMA user_version = 9');
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '9') ON CONFLICT(key) DO UPDATE SET value = '9'").run();
    assert.throws(() => migrate(db, { target: 1 }), /newer than this build/);
  } finally {
    closeDatabase(db);
  }
});
