#!/usr/bin/env node
/**
 * Cross-check the standing-evidence numbers against a second source before believing them.
 *
 * `standing-evidence.mjs` read the `inject` audit event's `ids` array and found a median of zero entries
 * present on 90% of renders. That is a striking result, and the first thing a striking result deserves is
 * suspicion of the instrument: `recordInjection` only writes ids when the array is non-empty, so a code
 * path that renders a section with no entries would leave no ids at all — indistinguishable from "nothing
 * was needed".
 *
 * `request_stat` records `entries_listed` on every render regardless, so the two can be compared.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.6' });

const rows = store.db
  .prepare(
    `SELECT session_id, COUNT(*) AS renders,
            SUM(entries_listed) AS listed_total,
            MAX(entries_listed) AS listed_max,
            SUM(CASE WHEN entries_listed = 0 THEN 1 ELSE 0 END) AS renders_with_zero,
            ROUND(AVG(section_bytes)) AS mean_bytes
       FROM request_stat
      GROUP BY session_id
      ORDER BY renders DESC
      LIMIT 12`,
  )
  .all();

console.log('request_stat says (the independent record):\n');
console.log('renders  listed/max  zero-listed  mean B  session');
for (const row of rows) {
  console.log(
    `${String(row.renders).padStart(7)}  ${String(row.listed_total).padStart(5)}/${String(row.listed_max).padStart(2)}` +
      `  ${String(row.renders_with_zero).padStart(11)}  ${String(row.mean_bytes).padStart(6)}  ${String(row.session_id).slice(0, 26)}`,
  );
}

const overall = store.db
  .prepare(
    `SELECT COUNT(*) AS renders, SUM(entries_listed) AS listed, SUM(CASE WHEN entries_listed = 0 THEN 1 ELSE 0 END) AS zero,
            MIN(ts) AS first, MAX(ts) AS last FROM request_stat`,
  )
  .get();
console.log(`\nall renders ${overall.renders} · entries listed ${overall.listed} · renders that listed nothing ${overall.zero}`);
console.log(
  `window ${new Date(Number(overall.first)).toISOString().slice(0, 16)} → ${new Date(Number(overall.last)).toISOString().slice(0, 16)}`,
);

// The two sources should agree on how many renders happened, if the instrument is sound.
const auditLines = store.db.prepare("SELECT COUNT(*) AS n FROM request_stat WHERE entries_listed > 0").get().n;
console.log(`\nrenders that listed at least one entry: ${auditLines} of ${overall.renders}`);
console.log(
  overall.listed === 0
    ? '\nNothing has ever been listed. That means the store was empty or scoped out for every render in this window —\nso the standing-evidence zero is a statement about an empty store, not about how many entries a task needs.'
    : '',
);
store.close();
