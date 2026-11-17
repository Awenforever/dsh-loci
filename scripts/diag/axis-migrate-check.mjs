#!/usr/bin/env node
/**
 * Run the v8→v9 migration on a copy of the live database and report what it did.
 *
 * A schema migration that changes the meaning of a column is the one place where "it worked" has to be
 * checked rather than assumed: the data still loads either way, so the only way to know whether the axis is
 * right is to look at where the entries landed.
 *
 * Never touches the live store.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/host/store/db.js';
import { migrate } from '../../src/host/store/migrate.js';
import { AXIS_DEFAULTS, axisRegion, positionOf } from '../../src/host/store/axis.js';
import { META_KEYS, readMeta } from '../../src/host/store/schema.js';

const LIVE = join(process.env.USERPROFILE ?? '', '.dsh', 'memory', 'loci', 'memory.db');
if (!existsSync(LIVE)) {
  console.error(`live database not found at ${LIVE}`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'loci-v9-'));
const copy = join(work, 'memory.db');
copyFileSync(LIVE, copy);
console.log(`copy: ${copy}\n`);

const db = openDatabase({ file: copy });
const result = migrate(db, { backup: false });
console.log(`migrated: ${JSON.stringify(result?.applied ?? result ?? '(see below)').slice(0, 200)}`);

const version = readMeta(db, META_KEYS.schemaVersion);
console.log(`schema version now: ${version}`);
console.log(`legacy rows converted: ${readMeta(db, 'axis_migrated_from_legacy')}`);
console.log(`of which landed near the habitat: ${readMeta(db, 'axis_migrated_near_habitat')}`);

const muNow = Number(readMeta(db, META_KEYS.muNow) ?? 0);
const rows = db
  .prepare(
    `SELECT u.id, u.p_base, u.mu_base, u.mu_touched, COALESCE(u.inject_count,0) AS inj, m.title
       FROM memory_usage u JOIN memory m ON m.id = u.id
      WHERE m.valid_to IS NULL
      ORDER BY u.p_base DESC`,
  )
  .all();

const regions = new Map();
for (const row of rows) {
  const p = positionOf({ pBase: row.p_base, muBase: row.mu_base }, muNow);
  const region = axisRegion(p);
  regions.set(region, (regions.get(region) ?? 0) + 1);
}

console.log(`\nmuNow ${muNow.toFixed(2)} · R ${AXIS_DEFAULTS.entranceDepth}\n`);
console.log('where the migrated entries landed:');
for (const [region, count] of [...regions].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${region.padEnd(12)} ${count}`);
}

console.log('\nnewest 6 (they should sit near the entrance; the migration is expected to leave them low):');
for (const row of rows.slice(0, 6)) {
  const p = positionOf({ pBase: row.p_base, muBase: row.mu_base }, muNow);
  console.log(`  p=${p.toFixed(1).padStart(7)}  ${axisRegion(p).padEnd(12)} inj=${String(row.inj).padStart(3)}  ${JSON.stringify(String(row.title).slice(0, 44))}`);
}

// The migration's known bias: old rows can only map into [0, R], so nothing lands in the compression region.
const negative = rows.filter((row) => positionOf({ pBase: row.p_base, muBase: row.mu_base }, muNow) < 0).length;
console.log(`\nentries in the compression region after migration: ${negative} (expected 0)`);
console.log('the old model had no negative region, so it holds no information about one. Entries will drift');
console.log('left into it as the clock advances; that movement is real, the initial placement is inference.');
console.log(`\nnote: ${readMeta(db, 'axis_migrated_near_habitat')} entries landed within 5% of the habitat — these are`);
console.log('the ones whose old stamp was recent. They are not at the entrance because they were not written just');
console.log('now; leaving them there would claim they are new.');

db.close?.();
rmSync(work, { recursive: true, force: true });
