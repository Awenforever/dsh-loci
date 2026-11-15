#!/usr/bin/env node
/**
 * Answer "is dsh-loci memory per-conversation or shared?" with the live database.
 *
 * Looks at which sessions wrote entries and which sessions received them. The decisive fact is
 * a cross-session one: an entry written by session A appearing in session B's prompt.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '3.6.0' });

console.log('=== entries and the session that wrote each ===');
const entries = store.db
  .prepare(
    `SELECT m.id, m.kind, m.scope, m.scope_label, m.source_session, h.status, m.title
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      ORDER BY m.created_at`,
  )
  .all();
for (const e of entries) {
  console.log(`  ${String(e.scope_label).padEnd(18)} ${e.kind.padEnd(10)} ${e.status.padEnd(10)} wrote:${String(e.source_session).slice(8, 16)}  ${JSON.stringify(String(e.title).slice(0, 40))}`);
}

console.log('\n=== injections: which session received bytes, and how many entries ===');
const injections = store.db
  .prepare(
    `SELECT session_id, COUNT(*) AS calls, SUM(section_bytes) AS bytes,
            SUM(entries_listed) AS listed, MIN(ts) AS first, MAX(ts) AS last
       FROM request_stat WHERE source = 'section'
      GROUP BY session_id ORDER BY calls DESC`,
  )
  .all();
for (const row of injections) {
  console.log(`  ${String(row.session_id).slice(8, 20)}  calls ${String(row.calls).padStart(4)}  bytes ${String(row.bytes).padStart(6)}  listed ${String(row.listed).padStart(4)}`);
}

console.log('\n=== the decisive cross-session check ===');
const writes = new Map();
for (const e of entries) if (e.source_session !== null) writes.set(e.id, e.source_session);
const crossRows = store.db
  .prepare(
    `SELECT id, session_id, entries_listed FROM request_stat
      WHERE source = 'section' AND entries_listed > 0 ORDER BY ts`,
  )
  .all();
let found = false;
for (const row of crossRows) {
  for (const [id, writer] of writes) {
    if (writer === row.session_id) continue;
    found = true;
    console.log(`  entry ${id} was WRITTEN by ${String(writer).slice(8, 20)} and INJECTED into ${String(row.session_id).slice(8, 20)} (listed ${row.entries_listed})`);
  }
}
if (!found) console.log('  no cross-session injection recorded yet');

console.log('\n=== scope keys in use ===');
for (const key of store.allScopeKeys()) {
  const n = store.db.prepare('SELECT COUNT(*) AS n FROM memory WHERE scope_key = ?').get(key).n;
  console.log(`  ${key}  entries ${n}`);
}
store.close();
