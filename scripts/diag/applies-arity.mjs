#!/usr/bin/env node
/**
 * Is `always` / `topic` enough, or is there a missing middle value?
 *
 * The candidate third value is `project` — "every task in this project, but not every task everywhere". The
 * question this script answers is whether that middle is actually unrepresented, or whether `scope`
 * already covers it.
 *
 * If the entries that "apply to every task in this work" are already confined to a session or workspace
 * scope, then scope **is** the middle dimension: `scope=session` + `applies=always` says exactly "every
 * task in this one place". Adding a third `applies` value would then be two fields describing one thing,
 * which is how they drift apart.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { looksLikeIndexLine } from '../../src/host/inject/fence.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.2.0' });

const rows = store.db
  .prepare(
    `SELECT m.id, m.applies, m.scope, m.scope_key, m.kind, m.title
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE h.status = 'verified' AND m.valid_to IS NULL AND m.scope_key NOT LIKE 'session:answer-eval'
      ORDER BY m.scope_key, m.applies DESC, m.title`,
  )
  .all()
  .filter((row) => !looksLikeIndexLine(row.title));

const byScope = new Map();
for (const row of rows) {
  const bucket = byScope.get(row.scope_key) ?? { scope: row.scope, always: 0, topic: 0, entries: [] };
  if (row.applies === 'always') bucket.always += 1;
  else bucket.topic += 1;
  bucket.entries.push(row);
  byScope.set(row.scope_key, bucket);
}

console.log(`verified entries ${rows.length} across ${byScope.size} scopes\n`);
for (const [scopeKey, bucket] of [...byScope].sort((a, b) => b[1].entries.length - a[1].entries.length)) {
  const label = scopeKey.length > 34 ? `${scopeKey.slice(0, 34)}…` : scopeKey;
  console.log(`${label}`);
  console.log(`  scope=${bucket.scope}  always ${bucket.always} · topic ${bucket.topic}`);
  for (const entry of bucket.entries.slice(0, 4)) {
    console.log(`    [${entry.applies === 'always' ? 'A' : 't'}] ${JSON.stringify(String(entry.title).slice(0, 62))}`);
  }
  if (bucket.entries.length > 4) console.log(`    …${bucket.entries.length - 4} more`);
}

// The test for a missing middle: does any scope depend on entries it needs on every turn but which are
// marked topic? If every topical entry sits in a narrow scope whose tasks all share one subject, then that
// scope's subject IS the middle value, expressed by scope rather than by a third applies setting.
const topicalInNarrowScope = rows.filter((row) => row.applies === 'topic' && row.scope !== 'global');
console.log(`\ntopical entries already confined to a narrow scope: ${topicalInNarrowScope.length} of ${rows.filter((r) => r.applies === 'topic').length}`);
console.log(`topical entries in a global scope (where a middle value would matter most): ${rows.filter((row) => row.applies === 'topic' && row.scope === 'global').length}`);

console.log('\nreading:');
console.log('  a middle value is needed only if entries must be "every task in this project but not elsewhere"');
console.log('  AND scope cannot express "this project". Since scope already ranges over session / workspace /');
console.log('  global, `scope=workspace` + `applies=always` is already that middle. A third applies value would');
console.log('  be the same statement written in a second field.');
store.close();
