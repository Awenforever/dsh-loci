#!/usr/bin/env node
/**
 * Recompute v9 anchors with the corrected rule.
 *
 * The first migration used one rule for every row — `p = R − distance` — which put an entry injected 442
 * times at the entrance, the region the axis reserves for "brand new, not yet digested". The rule now
 * depends on `inject_count`, which the old schema did keep:
 *
 *   never injected  → p = R − distance   (it fell in at the entrance and has been drifting)
 *   injected ≥ once → p = −distance      (its last touch was the moment it sat at the habitat)
 *
 * The schema is already at v9, so this is not a migration: it repairs anchor values using data the
 * migration had and did not consult. Every change is to `memory_usage` only; no memory content is touched.
 *
 * Usage: node scripts/diag/axis-reanchor.mjs [--apply]
 */
import { AXIS_DEFAULTS, axisRegion, anchorFromLegacy, positionOf } from '../../src/host/store/axis.js';
import { readMeta, META_KEYS } from '../../src/host/store/schema.js';
import { closeDatabase, openDatabase } from '../../src/host/store/db.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';

const apply = process.argv.includes('--apply');
const root = resolveMemoryRoot(resolveDshHome());
const db = openDatabase({ file: layout(root).db });

const muNow = Number(readMeta(db, META_KEYS.muNow) ?? 0);
const rows = db
  .prepare(
    `SELECT u.id, u.mu_touched, u.inject_count, u.p_base, u.mu_base, m.title
       FROM memory_usage u JOIN memory m ON m.id = u.id
      WHERE m.valid_to IS NULL`,
  )
  .all();

console.log(`muNow ${muNow.toFixed(2)} · R ${AXIS_DEFAULTS.entranceDepth} · rows ${rows.length}\n`);

const before = { entrance: 0, digesting: 0, habitat: 0, compressing: 0, forgotten: 0, unknown: 0 };
const after = { ...before };
const updates = [];

for (const row of rows) {
  const oldP = positionOf({ pBase: row.p_base, muBase: row.mu_base }, muNow);
  before[oldP === null ? 'unknown' : axisRegion(oldP)] += 1;

  const anchor = anchorFromLegacy(row.mu_touched, muNow, AXIS_DEFAULTS.entranceDepth, {
    injected: Number(row.inject_count ?? 0) > 0,
  });
  const newP = positionOf(anchor, muNow);
  after[newP === null ? 'unknown' : axisRegion(newP)] += 1;
  updates.push({ id: row.id, anchor, newP, oldP, row });
}

const show = (label, counts) =>
  console.log(
    `${label.padEnd(8)} entrance ${String(counts.entrance).padStart(3)} / digesting ${String(counts.digesting).padStart(3)} / ` +
      `habitat ${String(counts.habitat).padStart(3)} / compressing ${String(counts.compressing).padStart(3)} / ` +
      `forgotten ${String(counts.forgotten).padStart(3)}`,
  );
show('before', before);
show('after ', after);

// The entries that move the most, so the change is inspectable rather than a total.
console.log('\nlargest moves (old → new):');
const moved = updates
  .filter((item) => item.oldP !== null && Math.abs(item.newP - item.oldP) > 1)
  .sort((a, b) => Math.abs(b.newP - b.oldP) - Math.abs(a.newP - a.oldP));
for (const item of moved.slice(0, 8)) {
  console.log(
    `  ${String(Math.round(item.oldP)).padStart(6)} → ${String(Math.round(item.newP)).padStart(6)}  ` +
      `inj=${String(item.row.inject_count).padStart(3)}  ${JSON.stringify(String(item.row.title).slice(0, 44))}`,
  );
}
console.log(`\n${moved.length} of ${rows.length} entries move.`);

if (!apply) {
  console.log('\ndry run. Re-run with --apply to write the corrected anchors.');
  closeDatabase(db);
  process.exit(0);
}

const update = db.prepare('UPDATE memory_usage SET p_base = ?, mu_base = ? WHERE id = ?');
let written = 0;
db.exec('BEGIN IMMEDIATE');
try {
  for (const item of updates) {
    update.run(item.anchor.pBase, item.anchor.muBase, item.id);
    written += 1;
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
console.log(`\nrecomputed ${written} anchors.`);
closeDatabase(db);
