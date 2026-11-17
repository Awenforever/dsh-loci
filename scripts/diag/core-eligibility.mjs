#!/usr/bin/env node
/**
 * Are the entries in the core actually "always applies"?
 *
 * The core takes every `kind = 'rule'` entry and keeps six of them, ordered by pinned, importance, then
 * how recently the entry was touched — and injection touches it. So whichever rules enter first stay,
 * and a preference like "位置切换图标不要用简单的左右箭头" was injected 397 times into a session that was
 * almost never working on icon placement.
 *
 * The question this answers: what does the importance distribution look like, and is there a threshold
 * that separates "always applies" from "applies when the topic comes up"?
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.4' });

const rows = store.db
  .prepare(
    `SELECT m.id, m.kind, m.pinned, m.importance, m.title,
            COALESCE(u.inject_count, 0) AS injections,
            COALESCE(u.read_count, 0) AS reads
       FROM memory m JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status = 'verified' AND m.valid_to IS NULL
      ORDER BY m.importance DESC, u.inject_count DESC`,
  )
  .all();

const coreEligible = rows.filter((row) => row.kind === 'rule' || row.pinned === 1);
console.log(`verified ${rows.length} · core-eligible (kind=rule or pinned) ${coreEligible.length}\n`);

const byImportance = new Map();
for (const row of coreEligible) {
  const key = `${row.importance}${row.pinned === 1 ? ' (pinned)' : ''}`;
  const bucket = byImportance.get(key) ?? { count: 0, injections: 0, entries: [] };
  bucket.count += 1;
  bucket.injections += Number(row.injections);
  bucket.entries.push(row);
  byImportance.set(key, bucket);
}
console.log('core-eligible by importance:');
for (const [key, bucket] of [...byImportance].sort((a, b) => Number(b[0]) - Number(a[0]))) {
  console.log(`  importance ${key.padEnd(12)} ${String(bucket.count).padStart(3)} entries · ${String(bucket.injections).padStart(5)} injections`);
}

// The six that would win the core right now, by the live ordering.
const winners = coreEligible
  .slice()
  .sort((a, b) => b.pinned - a.pinned || b.importance - a.importance || b.injections - a.injections)
  .slice(0, 6);
console.log('\ncurrent core (pinned, importance, then recency):');
for (const row of winners) {
  console.log(`  imp=${row.importance} pinned=${row.pinned} inj=${String(row.injections).padStart(4)}  ${JSON.stringify(String(row.title).slice(0, 62))}`);
}

// Would an importance threshold help? Show what each cutoff would keep and drop.
console.log('\neffect of an importance threshold on the core:');
for (const threshold of [3, 4, 5]) {
  const kept = coreEligible.filter((row) => row.pinned === 1 || row.importance >= threshold);
  const droppedInj = coreEligible
    .filter((row) => row.pinned !== 1 && row.importance < threshold)
    .reduce((total, row) => total + Number(row.injections), 0);
  console.log(`  importance >= ${threshold}: ${String(kept.length).padStart(3)} entries stay core-eligible · ${droppedInj} injections would move to the slice path`);
}

console.log('\nthe entry the user asked about:');
const icon = rows.find((row) => String(row.title).includes('位置切换图标'));
if (icon !== undefined) {
  console.log(`  ${icon.id}  kind=${icon.kind} pinned=${icon.pinned} importance=${icon.importance} injections=${icon.injections}`);
  console.log(`  ${JSON.stringify(icon.title)}`);
}
store.close();
