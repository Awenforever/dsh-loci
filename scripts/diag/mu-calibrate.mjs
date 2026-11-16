#!/usr/bin/env node
/**
 * How many entries actually have an MU history, and what does the distribution look like?
 *
 * Written because the first percentile run was misleading: `mu_touched = 0` is not "touched at MU 0",
 * it is "never touched" — the migration stamped existing rows with the counter's starting value, so
 * they sit at `p = muNow` and dominate every high percentile while telling us nothing about age.
 *
 * Usage: node scripts/diag/mu-calibrate.mjs [--all]
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';
import { deriveBandEdges, quantile } from '../../src/host/store/mu.js';

const includeAll = process.argv.includes('--all');
const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.0.4' });

const rows = store.db
  .prepare(
    `SELECT m.id, COALESCE(u.mu_touched, 0) AS touched, COALESCE(u.inject_count, 0) AS injections
       FROM memory m
       JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status = 'verified' AND m.valid_to IS NULL`,
  )
  .all();

const muNow = store.muNow();
const tracked = rows.filter((row) => Number(row.touched) > 0);
const untracked = rows.filter((row) => Number(row.touched) === 0);

const distances = (list) => list.map((row) => Math.max(0, muNow - Number(row.touched))).sort((a, b) => a - b);
const all = distances(rows);
const known = distances(tracked);

const show = (label, values) => {
  if (values.length === 0) {
    console.log(`${label}: none`);
    return;
  }
  const at = (f) => quantile(values, f);
  console.log(
    `${label}: n=${values.length} min=${at(0).toFixed(1)} p25=${at(0.25).toFixed(1)} p50=${at(0.5).toFixed(1)} ` +
      `p75=${at(0.75).toFixed(1)} p95=${at(0.95).toFixed(1)} max=${at(1).toFixed(1)}`,
  );
};

console.log(`mu now ${muNow.toFixed(1)} · verified entries ${rows.length}`);
console.log(`  with an MU history   ${tracked.length}`);
console.log(`  never touched since migration  ${untracked.length}  ← their p is an artifact, not an age`);
console.log('');
show('all verified     ', all);
show('with history only', known);
console.log('');
const derived = deriveBandEdges(known);
console.log(`auto band edges  ${derived.derived ? `fresh < ${derived.fresh.toFixed(1)} · active < ${derived.active.toFixed(1)} · cool < ${derived.cool.toFixed(1)}` : `fallback to fixed (${known.length} samples, need 20): fresh < 5 · active < 50 · cool < 500`}`);
console.log('fixed band edges  fresh < 5 · active < 50 · cool < 500');
for (const [name, edges] of [
  ['auto ', derived],
  ['fixed', { fresh: 5, active: 50, cool: 500 }],
]) {
  const counts = { fresh: 0, active: 0, cool: 0, cold: 0 };
  for (const p of known) {
    const band = p < edges.fresh ? 'fresh' : p < edges.active ? 'active' : p < edges.cool ? 'cool' : 'cold';
    counts[band] += 1;
  }
  console.log(`  ${name} → ${JSON.stringify(counts)} (over ${known.length} with history)`);
}
const withAll = { fresh: 0, active: 0, cool: 0, cold: 0 };
for (const p of all) {
  const band = p < derived.fresh ? 'fresh' : p < derived.active ? 'active' : p < derived.cool ? 'cool' : 'cold';
  withAll[band] += 1;
}
console.log(`  (counting the ${untracked.length} without history would give ${JSON.stringify(withAll)} — do not do this)`);
console.log('');
console.log('Retirement is NOT derived from these edges on purpose: a threshold read off the current tail');
console.log('retires the tail, which recomputes the tail, which retires more — a ratchet that deletes the');
console.log('store one quantile at a time. muRetireAfter stays 0 until a criterion comes from use, not distance.');
if (includeAll) {
  console.log('\nper entry:');
  for (const row of rows.sort((a, b) => Number(a.touched) - Number(b.touched))) {
    const p = Math.max(0, muNow - Number(row.touched));
    console.log(`  p=${p.toFixed(1).padStart(7)}  inj=${String(row.injections).padStart(4)}  ${Number(row.touched) === 0 ? 'no history' : ''}`);
  }
}
store.close();
