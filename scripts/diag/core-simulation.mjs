#!/usr/bin/env node
/**
 * What would the core look like if injection stopped refreshing the clock?
 *
 * The live core is the same six rules every turn. The mechanism: `selectCore` orders by pinned, then
 * importance, then `mu_touched`; all 29 candidates share importance 3 and pinned 0, so `mu_touched`
 * decides — and `recordInjection` stamps it on every render. Whichever six enter first stay forever.
 *
 * This is a simulation over the real store, not a change: it recomputes the core under three orderings and
 * prints what each would have chosen. The point is to see the alternative before arguing about it.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.4' });

// Scoped exactly as the real `selectCore` is. Leaving this out once made the fixture entries from
// `session:answer-eval` look like they were competing for a real core — they were not; the simulation was
// simply reading the whole table. A simulation that omits the query's WHERE clause is not a simulation.
const scopeArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const scopeKeys =
  scopeArg === undefined
    ? store.db
        .prepare(
          `SELECT DISTINCT m.scope_key FROM memory m JOIN memory_head h ON h.ord = m.ord
            WHERE h.status = 'verified' AND m.valid_to IS NULL AND m.scope_key NOT LIKE 'session:answer-eval'`,
        )
        .all()
        .map((row) => row.scope_key)
    : [scopeArg];
console.log(`scopes: ${scopeKeys.length} (fixture scope excluded)\n`);

const marks = scopeKeys.map(() => '?').join(', ');
const rows = store.db
  .prepare(
    `SELECT m.id, m.kind, m.pinned, m.importance, m.title, m.created_at, m.updated_at,
            COALESCE(u.inject_count, 0) AS injections,
            COALESCE(u.read_count, 0)    AS reads,
            COALESCE(u.mu_touched, 0)    AS mu_touched,
            m.mu_born
       FROM memory m JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status = 'verified' AND m.valid_to IS NULL
        AND m.scope_key IN (${marks})
        AND (m.kind = 'rule' OR m.pinned = 1)`,
  )
  .all(...scopeKeys);

const muNow = store.muNow();
const show = (label, sorted) => {
  console.log(`\n${label}`);
  for (const row of sorted.slice(0, 6)) {
    const age = row.mu_touched > 0 ? `${Math.max(0, muNow - row.mu_touched).toFixed(0)} μ` : 'no history';
    console.log(`  ${String(row.injections).padStart(4)}× inj · ${age.padStart(9)} · ${JSON.stringify(String(row.title).slice(0, 54))}`);
  }
};

// Today: pinned, importance, then the clock that injection keeps resetting.
show(
  'A. current ordering (pinned, importance, mu_touched)',
  rows.slice().sort((a, b) => b.pinned - a.pinned || b.importance - a.importance || b.mu_touched - a.mu_touched),
);

// If injection did not stamp mu_touched, the clock would reflect the last real use — and with zero reads
// that is the write, so the core becomes the most recently written rules.
show(
  'B. if injection never refreshed the clock (falls back to write time)',
  rows.slice().sort((a, b) => b.pinned - a.pinned || b.importance - a.importance || b.created_at - a.created_at),
);

// Rotation: punish the entries that have had the most chances, which is the opposite of rewarding them.
show(
  'C. least-recently-injected first (explicit rotation)',
  rows.slice().sort((a, b) => b.pinned - a.pinned || b.importance - a.importance || a.injections - b.injections),
);

// How much of the traffic the current six absorb, versus a rotating six.
const current = rows.slice().sort((a, b) => b.pinned - a.pinned || b.importance - a.importance || b.mu_touched - a.mu_touched).slice(0, 6);
const total = rows.reduce((sum, row) => sum + Number(row.injections), 0);
const currentSum = current.reduce((sum, row) => sum + Number(row.injections), 0);
console.log(`\ncurrent six carry ${((currentSum / total) * 100).toFixed(1)}% of ${total} injections`);
console.log(`candidates never reaching the core: ${rows.length - 6} of ${rows.length}`);
console.log(`all candidates share importance ${[...new Set(rows.map((row) => row.importance))].join(', ')} and pinned ${[...new Set(rows.map((row) => row.pinned))].join(', ')}`);
store.close();
