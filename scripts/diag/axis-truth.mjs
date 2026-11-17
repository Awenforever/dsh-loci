#!/usr/bin/env node
/**
 * What actually moves an entry's position, and does it match the axis in docs/MEMORY-UNITS.md?
 *
 * The document describes a signed axis: new memories land at the right-hand entrance `+R`, time pushes
 * everything left unconditionally, and recall pushes back right. The code computes `p = muNow - mu_touched`
 * and clamps at zero.
 *
 * Those are different models. This prints the evidence so the difference is not a matter of opinion.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.3.1' });

console.log('what the code computes:');
console.log('  p = Math.max(0, muNow - mu_touched)   →  non-negative, 0 = most recently touched');

const rows = store.db
  .prepare(
    `SELECT m.id, m.mu_born, COALESCE(u.mu_touched, 0) AS touched, COALESCE(u.inject_count,0) AS inj,
            COALESCE(u.read_count,0) AS rd, m.created_at, m.title
       FROM memory m JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status = 'verified' AND m.valid_to IS NULL
      ORDER BY m.created_at DESC LIMIT 6`,
  )
  .all();

const muNow = store.muNow();
console.log(`\nmuNow = ${muNow.toFixed(2)}`);
console.log('\nnewest entries (these should be at the entrance +R in the document\'s model):');
for (const row of rows) {
  const p = Math.max(0, muNow - Number(row.touched));
  console.log(`  p=${p.toFixed(2).padStart(8)}  mu_born=${Number(row.mu_born ?? 0).toFixed(2).padStart(8)}  inj=${row.inj} read=${row.rd}  ${JSON.stringify(String(row.title).slice(0, 46))}`);
}

// The question the journal needs answered: can `p` tell "never used" from "used recently"?
const never = store.db
  .prepare(
    `SELECT COUNT(*) AS n, MIN(COALESCE(u.mu_touched,0)) AS lowest, MAX(COALESCE(u.mu_touched,0)) AS highest
       FROM memory m JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status = 'verified' AND m.valid_to IS NULL AND COALESCE(u.inject_count,0) = 0`,
  )
  .get();
const everUsed = store.db
  .prepare(
    `SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord
      LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status = 'verified' AND m.valid_to IS NULL AND COALESCE(u.inject_count,0) > 1`,
  )
  .get();

console.log(`\nentries never injected: ${never.n}`);
console.log(`entries injected more than once: ${everUsed.n}`);

const pNever = store.db
  .prepare(
    `SELECT AVG(? - COALESCE(u.mu_touched,0)) AS mean_p FROM memory m JOIN memory_head h ON h.ord = m.ord
      LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status = 'verified' AND m.valid_to IS NULL AND COALESCE(u.inject_count,0) = 0`,
  )
  .get(muNow);
console.log(`mean p of never-injected entries: ${Number(pNever.mean_p ?? 0).toFixed(2)}`);

console.log('\nthe three things being conflated:');
console.log('  1. being written   — sets mu_born and the initial mu_touched');
console.log('  2. being injected  — resets mu_touched to now (recordInjection)');
console.log('  3. being read      — resets mu_touched to now (recordRead)');
console.log('\nAll three write the same column, so `p` cannot distinguish "just remembered" from "just used",');
console.log('and a write that was never injected already sits at p = 0 — the habitat — on day one.');
store.close();
