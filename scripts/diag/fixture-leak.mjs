#!/usr/bin/env node
/**
 * Did the answer-eval fixture leak into the real core?
 *
 * The fixture writes to its own scope key (`session:answer-eval`) exactly so it cannot pollute memory. But
 * the core-selection simulation listed "Tessera 的保留期是九个季度" among the candidates, which means
 * either the scope key is not isolating them or the fixture is being selected for a real session.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.4' });

const fixture = store.db
  .prepare(
    `SELECT m.id, m.scope_key, m.kind, m.title, COALESCE(u.inject_count, 0) AS injections,
            COALESCE(u.read_count, 0) AS reads
       FROM memory m JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status <> 'deleted' AND m.valid_to IS NULL
        AND (m.title LIKE '%Zephyr-7%' OR m.title LIKE '%Tessera%' OR m.title LIKE '%Bramble%'
             OR m.title LIKE '%Nimbus%' OR m.title LIKE '%Quartz 流水线%')`,
  )
  .all();

console.log(`fixture-shaped entries still live: ${fixture.length}`);
for (const row of fixture) {
  console.log(`  ${row.id}  scope=${row.scope_key}`);
  console.log(`    kind=${row.kind}  injections=${row.injections}  reads=${row.reads}`);
  console.log(`    ${JSON.stringify(String(row.title).slice(0, 80))}`);
}

// Which scopes exist at all, so a leak is visible rather than inferred.
const scopes = store.db
  .prepare(
    `SELECT m.scope_key, COUNT(*) AS n
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE h.status = 'verified' AND m.valid_to IS NULL
      GROUP BY m.scope_key ORDER BY n DESC`,
  )
  .all();
console.log(`\nscopes holding verified entries:`);
for (const scope of scopes) console.log(`  ${String(scope.n).padStart(4)}  ${scope.scope_key}`);

store.close();
