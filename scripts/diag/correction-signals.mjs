#!/usr/bin/env node
/**
 * What evidence the store already holds about whether an entry was any good.
 *
 * The plan is to revise `importance` from what happens to an entry rather than from what a model guessed at
 * write time. Before designing that, look at which signals exist and how populated they are — a revision
 * counter that is always 1 carries no information no matter how principled the formula on top of it.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.6' });

const revisions = store.db
  .prepare(
    `SELECT id, MAX(revision) AS rev, MAX(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS ever_deleted
       FROM memory GROUP BY id HAVING rev > 1 OR ever_deleted = 1 ORDER BY rev DESC LIMIT 12`,
  )
  .all();
console.log(`entries revised or withdrawn: ${revisions.length}`);
for (const row of revisions) {
  console.log(`  ${row.id}  revisions=${row.rev}${row.ever_deleted === 1 ? '  (was deleted)' : ''}`);
}

const totals = store.db
  .prepare(
    `SELECT COUNT(*) AS entries, SUM(CASE WHEN rev > 1 THEN 1 ELSE 0 END) AS revised, MAX(rev) AS deepest
       FROM (SELECT id, MAX(revision) AS rev FROM memory GROUP BY id)`,
  )
  .get();
console.log(`\ntotal entries ${totals.entries} · revised at least once ${totals.revised} · deepest revision ${totals.deepest}`);

// The signals the feedback loop would actually use.
const usage = store.db
  .prepare(
    `SELECT COUNT(*) AS tracked,
            SUM(CASE WHEN read_count > 0 THEN 1 ELSE 0 END) AS ever_opened,
            SUM(CASE WHEN inject_count > 0 THEN 1 ELSE 0 END) AS ever_shown
       FROM memory_usage`,
  )
  .get();
console.log(`\nusage rows ${usage.tracked} · ever shown ${usage.ever_shown} · ever opened ${usage.ever_opened}`);

const auditWrites = store.db.prepare("SELECT COUNT(*) AS n FROM memory WHERE id LIKE 'm_%'").get().n;
console.log(`\nwhat this says about the plan:`);
console.log(`  "revised more than once" is available and populated: ${totals.revised} of ${totals.entries} entries.`);
console.log(`  "ever opened" is not usable: ${usage.ever_opened} of ${usage.tracked} — titles are self-contained,`);
console.log('  so read_count stays at zero and cannot signal quality. Any correction formula that leans on it');
console.log('  would divide by zero and call every entry perfect.');
store.close();
