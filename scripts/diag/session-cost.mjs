#!/usr/bin/env node
/**
 * How much of each session's prompt the shared memory occupies, and which unrelated sessions
 * are carrying it. This is the evidence for the scope question.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '3.7.0' });

const rows = store.db
  .prepare(
    `SELECT session_id, COUNT(*) AS calls, SUM(section_bytes) AS bytes,
            SUM(CASE WHEN entries_listed > 0 THEN 1 ELSE 0 END) AS with_entries,
            MIN(ts) AS first, MAX(ts) AS last
       FROM request_stat WHERE source = 'section' AND session_id IS NOT NULL
      GROUP BY session_id ORDER BY calls DESC`,
  )
  .all();

console.log('session            calls   bytes   with-entries   first → last');
for (const row of rows) {
  const minutes = Math.round((row.last - row.first) / 60000);
  console.log(
    `  ${String(row.session_id).slice(8, 20)}  ${String(row.calls).padStart(5)}  ${String(row.bytes).padStart(6)}  ${String(row.with_entries).padStart(12)}   ${minutes} min`,
  );
}

const total = rows.reduce((sum, row) => sum + Number(row.bytes), 0);
console.log(`\ntotal injected across all sessions: ${total} bytes`);
console.log(`sessions sharing one scope: ${rows.length}`);
store.close();
