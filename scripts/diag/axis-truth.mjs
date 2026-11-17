#!/usr/bin/env node
/**
 * What the axis says about the live store, and whether it matches the model.
 *
 * This script once documented the *old* formula (`p = max(0, muNow − mu_touched)`) as evidence of what was
 * wrong. That formula is gone; a diagnostic that keeps printing it now reads as if the store still worked
 * that way. So it verifies the current model instead:
 *
 *   1. direction — has anything actually moved left?
 *   2. entrance — are new writes really landing at `+R`?
 *   3. separation — do "just written" and "just used" occupy different places?
 *
 * Read-only.
 */
import { AXIS_DEFAULTS, axisRegion, positionOf } from '../../src/host/store/axis.js';
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '6.0.1' });

const muNow = store.muNow();
const R = AXIS_DEFAULTS.entranceDepth;
console.log(`model    p = p_base − (muNow − mu_base), signed, entrance at +${R}`);
console.log(`muNow    ${muNow.toFixed(2)}\n`);

const rows = store.db
  .prepare(
    `SELECT m.id, m.mu_born, u.p_base, u.mu_base,
            COALESCE(u.inject_count, 0) AS injections,
            COALESCE(u.read_count, 0)    AS reads,
            m.created_at, m.title
       FROM memory m JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status = 'verified' AND m.valid_to IS NULL
      ORDER BY m.created_at DESC`,
  )
  .all()
  .map((row) => ({ ...row, p: positionOf({ pBase: row.p_base, muBase: row.mu_base }, muNow) }));

// 1. direction — a written entry should be left of the entrance, and further left the older it is.
const written = rows.filter((row) => row.p !== null).sort((a, b) => Number(a.created_at) - Number(b.created_at));
console.log('1. direction — oldest three and newest three, by position');
const show = (label, list) => {
  for (const row of list) {
    console.log(
      `   ${label} p=${String(Math.round(row.p)).padStart(6)}  ${axisRegion(row.p).padEnd(12)} ` +
        `inj=${String(row.injections).padStart(3)}  ${JSON.stringify(String(row.title).slice(0, 40))}`,
    );
  }
};
show('old', written.slice(0, 3));
show('new', written.slice(-3));
const oldestAvg = written.slice(0, 5).reduce((sum, row) => sum + row.p, 0) / Math.min(5, written.length);
const newestAvg = written.slice(-5).reduce((sum, row) => sum + row.p, 0) / Math.min(5, written.length);
console.log(
  `   ${oldestAvg < newestAvg ? 'PASS' : 'FAIL'} — older entries sit further left ` +
    `(oldest mean ${oldestAvg.toFixed(0)}, newest mean ${newestAvg.toFixed(0)})`,
);

// 2. entrance — no entry can be above R, and fresh writes should be close to it.
const above = rows.filter((row) => row.p !== null && row.p > R + 0.001).length;
console.log(`\n2. entrance — entries above +R: ${above} ${above === 0 ? '(PASS: none)' : '(FAIL: recall overshot)'}`);

// 3. separation — the two situations the rewrite exists to distinguish.
const neverUsed = rows.filter((row) => row.p !== null && Number(row.injections) === 0);
const used = rows.filter((row) => row.p !== null && Number(row.injections) > 0);
const mean = (list) => (list.length === 0 ? 0 : list.reduce((sum, row) => sum + row.p, 0) / list.length);
console.log(`\n3. separation — never used vs used`);
console.log(`   never used  ${neverUsed.length} entries, mean p ${mean(neverUsed).toFixed(0)}`);
console.log(`   used        ${used.length} entries, mean p ${mean(used).toFixed(0)}`);
console.log(
  '   note: a used entry is pulled back toward the habitat on each recall, so its mean should not be far',
);
console.log('   below the never-used one simply by being older — that is the distinction the axis carries.');

// 4. regions
const regions = { entrance: 0, digesting: 0, habitat: 0, compressing: 0, forgotten: 0, unknown: 0 };
for (const row of rows) regions[row.p === null ? 'unknown' : axisRegion(row.p)] += 1;
console.log(`\n4. regions — ${JSON.stringify(regions)}`);
console.log(
  `   the store has advanced ${muNow.toFixed(0)} μ; the forgotten end begins at ${(-0.6 * R).toFixed(0)} μ, ` +
    `so ${regions.forgotten === 0 ? 'nothing can have reached it yet' : `${regions.forgotten} entries have`}.`,
);
store.close();
