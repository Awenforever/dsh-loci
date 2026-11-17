#!/usr/bin/env node
/**
 * How much room the standing entries actually need, and what the core budget can hold.
 *
 * `CORE_BUDGET_BYTES` is 500. After the verdict migration four entries are standing, and the fourth did
 * not fit. That is the budget doing its job — but the ordering inside the core is still `mu_touched`
 * because every `importance` is 3, so "which three" is decided by recency rather than by importance. This
 * prints the arithmetic so the decision can be made with numbers instead of by raising a constant.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { CORE_BUDGET_BYTES, SLICE_BUDGET_BYTES, selectCore } from '../../src/host/recall/compose.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.6' });

const rows = store.db
  .prepare(
    `SELECT m.id, m.kind, m.title, m.importance, m.when_condition, COALESCE(u.mu_touched,0) AS touched
       FROM memory m JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status = 'verified' AND m.valid_to IS NULL AND m.applies = 'always'
      ORDER BY m.importance DESC, touched DESC`,
  )
  .all();

const muNow = store.muNow();
console.log(`CORE_BUDGET_BYTES ${CORE_BUDGET_BYTES} · SLICE_BUDGET_BYTES ${SLICE_BUDGET_BYTES} · standing entries ${rows.length}\n`);

let running = 0;
for (const row of rows) {
  // Reproduce the line the renderer would produce, to measure what each entry really costs.
  const age = `${Math.max(0, muNow - Number(row.touched)).toFixed(1)} μ ago`;
  const condition = row.when_condition ? ` · when: ${String(row.when_condition).slice(0, 60)}` : '';
  const line = `- ${row.id} · ${row.kind} · ${age} · ${String(row.title).slice(0, 120)}${condition}`;
  const size = Buffer.byteLength(line, 'utf8') + 1;
  const fits = running + size <= CORE_BUDGET_BYTES;
  running += size;
  console.log(`  ${fits ? 'FITS ' : 'OVER '} ${String(size).padStart(4)} B  (running ${String(running).padStart(4)})  imp=${row.importance}  ${JSON.stringify(String(row.title).slice(0, 52))}`);
}

console.log(`\ntotal needed ${running} B for ${rows.length} lines`);

// What the core actually selects right now, for comparison.
const scopeKeys = store.db
  .prepare(
    `SELECT DISTINCT m.scope_key FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE h.status = 'verified' AND m.valid_to IS NULL AND m.applies = 'always'`,
  )
  .all()
  .map((row) => row.scope_key);
const core = selectCore({ store, scopeKeys });
console.log(`\ncore currently selects ${core.lines.length} of ${rows.length} standing entries, ${core.bytes} B`);

// The arithmetic for a budget that would hold them all, with the header text included.
const headerBytes = Buffer.byteLength('Always applies:\n', 'utf8');
console.log(`\nto hold every standing entry, the budget would need about ${running + headerBytes} B`);
console.log('raising it is one option; giving the entries distinct importance so the cut is a real ranking');
console.log('is the other, and it is the only one that stays correct as the store grows.');

const spread = new Set(rows.map((row) => row.importance));
console.log(`\nimportance values among standing entries: ${[...spread].join(', ')} ${spread.size === 1 ? '(all the same — ordering falls through to the clock)' : ''}`);
store.close();
