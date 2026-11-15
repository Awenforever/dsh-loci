#!/usr/bin/env node
/**
 * Why nothing ever gets verified. Read-only.
 *
 * The card's `Latest` line reads `/knowledge`, which filters `status = 'verified'`. If only one
 * entry has ever been verified, the line cannot move no matter how much is recorded. This probe
 * checks whether the review queue is empty and, if so, why.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { REVIEWABLE_KINDS } from '../../src/host/store/store.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '3.8.0' });
const keys = store.allScopeKeys();

console.log('REVIEWABLE_KINDS =', REVIEWABLE_KINDS.join(', '));

const byStatusKind = store.db
  .prepare(
    `SELECT h.status, m.kind, COUNT(*) AS n,
            SUM(CASE WHEN COALESCE(u.inject_count, 0) > 0 THEN 1 ELSE 0 END) AS injected
       FROM memory m
       JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      GROUP BY h.status, m.kind
      ORDER BY n DESC`,
  )
  .all();
console.log('\nstatus / kind / count / how many ever injected');
for (const row of byStatusKind) {
  const reviewable = REVIEWABLE_KINDS.includes(row.kind) ? 'reviewable' : 'NOT reviewable';
  console.log(`  ${String(row.status).padEnd(10)} ${String(row.kind).padEnd(10)} ${String(row.n).padStart(3)}  ${String(row.injected).padStart(3)}   ${reviewable}`);
}

const pending = store.countPending(keys, {});
console.log(`\ncountPending (what the Review tab and the card badge show): ${pending}`);

const reviewable = store.db
  .prepare(
    `SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE h.status = 'candidate' AND m.valid_to IS NULL
        AND m.kind IN (${REVIEWABLE_KINDS.map(() => '?').join(',')})`,
  )
  .get(...REVIEWABLE_KINDS).n;
console.log(`candidates of a reviewable kind: ${reviewable}`);

const verified = store.db.prepare("SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE h.status = 'verified'").get().n;
console.log(`verified entries in total: ${verified}`);

const totalInjected = store.db.prepare('SELECT COALESCE(SUM(inject_count), 0) AS n FROM memory_usage').get().n;
console.log(`total injection events across all entries: ${totalInjected}`);

console.log('\nconclusion:');
if (pending === 0 && reviewable === 0) {
  console.log('  the review queue is empty because every captured entry is an episodic session');
  console.log('  summary, and episodic is deliberately excluded from review. So nothing is ever');
  console.log('  promoted, only the one manually verified entry can reach the prompt, and the');
  console.log(`  card's Latest line is frozen on it (${totalInjected} injections).`);
}
store.close();
