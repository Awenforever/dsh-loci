#!/usr/bin/env node
/**
 * Did the plugin's own injected block end up stored as memory?
 *
 * Four entries carry titles beginning `- m_01... · rule · 71 MU ago · ...`, which is exactly the shape of
 * a rendered index line. That would be a feedback loop: injected text gets re-extracted as if the user had
 * said it, and then injected again next turn.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.3' });

const suspicious = store.db
  .prepare(
    `SELECT m.id, m.kind, m.scope, m.scope_key, m.trust_source, m.importance, m.created_at,
            m.title, substr(m.body, 1, 300) AS body_head, h.status
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE m.valid_to IS NULL AND (m.title LIKE '%- m_%' OR m.body LIKE '%m_01M%')
      ORDER BY m.created_at`,
  )
  .all();

console.log(`entries whose text looks like a rendered index line: ${suspicious.length}\n`);
for (const row of suspicious) {
  console.log(`${row.id}  ${row.kind} · ${row.trust_source} · ${row.status}`);
  console.log(`  scope_key : ${row.scope_key}`);
  console.log(`  created   : ${new Date(Number(row.created_at)).toISOString()}`);
  console.log(`  title     : ${JSON.stringify(row.title.slice(0, 120))}`);
  console.log(`  body head : ${JSON.stringify(row.body_head.slice(0, 120))}`);
  console.log('');
}

// Who wrote them, and in what batch — the audit knows.
const ids = suspicious.map((row) => row.id);
if (ids.length > 0) {
  console.log('audit writes for these ids:');
  const lines = store.db
    .prepare(`SELECT 1`) // the audit log is a file, not a table; fall through to the caller
    .all();
  void lines;
}
console.log('How many verified entries in total:');
console.log(
  store.db.prepare("SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord=m.ord WHERE h.status='verified' AND m.valid_to IS NULL").get().n,
);
store.close();
