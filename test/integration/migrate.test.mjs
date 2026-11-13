import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { ensureMemoryRoot } from '../../src/host/paths.js';
import { closeDatabase, openDatabase, tableCounts } from '../../src/host/store/db.js';
import { migrate, restoreDatabaseFile } from '../../src/host/store/migrate.js';
import { databaseVersion } from '../../src/host/store/schema.js';
import { ensureMemoryRoot as ensureRoot, layout } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

/** One rehearsal step: a real, additive column that the next minor may need. */
const REHEARSAL = [
  {
    from: 1,
    to: 2,
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

test('a rehearsal upgrade keeps every row and the snapshot rolls back exactly', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-migrate-'));
  const root = ensureRoot(join(home, 'memory', 'loci'));
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

  const db = openDatabase({ file: paths.db });
  const result = migrate(db, { migrations: REHEARSAL, target: 2, backupDir: paths.backups, now: 1_700_000_000_000 });
  try {
    assert.deepEqual(result.steps, ['v1->v2']);
    assert.equal(databaseVersion(db), 2);
    assert.ok(existsSync(result.backup), 'a snapshot must exist before the migration');
    const after = tableCounts(db);
    assert.deepEqual(after, before, 'every table keeps its row count');
    const noted = Number(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE note IS NOT NULL').get()?.n ?? 0);
    assert.equal(noted, before.memory);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    closeDatabase(db);
  }

  // The audit log is append-only and must survive both directions.
  assert.equal(store.auditTail(100).length, auditBefore);

  restoreDatabaseFile(paths.db, result.backup);
  const restored = openDatabase({ file: paths.db });
  try {
    assert.equal(databaseVersion(restored), 1, 'rollback restores the previous schema version');
    assert.deepEqual(tableCounts(restored), before, 'rollback restores exactly the rows from before');
    const columns = restored.prepare('PRAGMA table_info(memory)').all().map((row) => row.name);
    assert.equal(columns.includes('note'), false, 'the rehearsal column is gone after rollback');
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    closeDatabase(restored);
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
