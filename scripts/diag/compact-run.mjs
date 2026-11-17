#!/usr/bin/env node
/**
 * Run one compaction pass on the live store and report what it did.
 *
 * The axis has always claimed a travelling memory is digested and then compressed. Until v11 that was only
 * true of its coordinate. This is the first pass that changes the text, so it deserves to be looked at rather
 * than assumed: every entry it touches should show a shorter body, a higher level, and an intact original.
 *
 * Usage: node scripts/diag/compact-run.mjs [--apply]
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';
import { positionOf } from '../../src/host/store/axis.js';
import { levelFor } from '../../src/host/store/compact.js';

const apply = process.argv.includes('--apply');
const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '7.1.0' });

const muNow = store.muNow();
const R = store.muPositions({}).parameters.entranceDepth;
const rows = store.db
  .prepare(
    `SELECT m.ord, m.id, m.revision, m.body, m.compact_level, m.title, u.p_base, u.mu_base
       FROM memory m JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status = 'verified' AND m.valid_to IS NULL`,
  )
  .all();

const pending = [];
for (const row of rows) {
  const p = positionOf({ pBase: row.p_base, muBase: row.mu_base }, muNow);
  const target = levelFor(p, R);
  if (p !== null && target > Number(row.compact_level ?? 0)) pending.push({ ...row, position: p, target });
}

console.log(`muNow ${muNow.toFixed(2)} · R ${R} · ${rows.length} entries · ${pending.length} would compact`);
console.log('');
for (const row of pending.slice(0, 10)) {
  console.log(
    `  p=${String(Math.round(row.position)).padStart(6)}  L${row.compact_level ?? 0}→L${row.target}  ` +
      `${String(row.body.length).padStart(4)} chars  ${JSON.stringify(String(row.title).slice(0, 40))}`,
  );
}
if (pending.length === 0) {
  console.log('  (nothing to do — either everything is at its level, or no entry has travelled far enough)');
}

if (!apply) {
  console.log('\ndry run. Re-run with --apply to run the pass.');
  store.close();
  process.exit(0);
}

const summary = store.maintenance({});
console.log(`\nmaintenance: compacted ${summary.compacted ?? 0}${summary.compactError ? ` (error: ${summary.compactError})` : ''}`);

// Verify losslessness on every entry that was touched: the newest revision must be shorter than the oldest.
const touched = store.db
  .prepare(
    `SELECT id, COUNT(*) AS revisions, MIN(LENGTH(body)) AS shortest, MAX(LENGTH(body)) AS longest,
            MAX(compact_level) AS level
       FROM memory WHERE id IN (SELECT id FROM memory WHERE compact_level > 0)
      GROUP BY id`,
  )
  .all();
console.log(`\nentries at level > 0: ${touched.length}`);
let lossless = 0;
for (const row of touched) {
  if (Number(row.revisions) > 1 && Number(row.longest) > Number(row.shortest)) lossless += 1;
}
console.log(`with a longer original preserved: ${lossless} / ${touched.length}`);
console.log(lossless === touched.length ? 'PASS — nothing was destroyed' : 'CHECK — some entries lost their original');
store.close();
