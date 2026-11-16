#!/usr/bin/env node
/** Standing report on whether memory is actually doing its two jobs in real use. */
import { effectiveConfig } from '../../src/host/config.js';
import { existsSync, readFileSync } from 'node:fs';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { PROBE_META_KEY } from '../../src/host/record/probe.js';
import { readMeta } from '../../src/host/store/schema.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const config = effectiveConfig({});
const store = new Store({ memoryRoot: root, paths: layout(root), config, pluginVersion: '4.5.0' });

console.log('=== configuration in force');
console.log(`  recallMode      ${config.recallMode}`);
console.log(`  recallRewrite   ${config.recallRewrite}`);
console.log(`  curatorMode     ${config.curatorMode}`);
console.log(`  defaultScope    ${config.defaultScope}`);

console.log('\n=== 记: who is writing');
const bySource = store.db
  .prepare(
    `SELECT COALESCE(m.trust_source, '(none)') AS source, h.status, COUNT(*) AS n
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      GROUP BY source, h.status ORDER BY n DESC`,
  )
  .all();
for (const row of bySource) console.log(`  ${String(row.source).padEnd(10)} ${String(row.status).padEnd(10)} ${row.n}`);

console.log('\n=== 忆: what the prompt carried');
const last = store.lastInjection();
if (last === undefined) console.log('  (no assembly recorded)');
else console.log(`  ${last.bytes} bytes · ${last.listed} listed · ${last.source} · ${new Date(last.ts).toISOString().slice(0, 19)}`);

console.log('\n=== the model, in the plugin\'s own words');
console.log(`  llm_complete    ${readMeta(store.db, 'llm_complete') ?? '(absent)'}`);
console.log(`  llm_selection   ${readMeta(store.db, 'llm_selection') ?? '(absent)'}`);
const probe = readMeta(store.db, PROBE_META_KEY);
if (probe === undefined) console.log('  curator probe   (absent)');
else {
  const record = JSON.parse(probe);
  console.log(`  curator probe   ok=${record.ok} version=${record.version} caught=${JSON.stringify(record.caught ?? [])}`);
  for (const item of record.kept ?? []) console.log(`     kept: ${item.kind} · ${item.title}`);
}

// The rescue is silent by design unless it fires, so the audit log is where it shows up.
const audit = store.paths.audit;
if (existsSync(audit)) {
  const lines = readFileSync(audit, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  const counts = new Map();
  for (const line of lines) {
    try {
      const event = JSON.parse(line).event;
      counts.set(event, (counts.get(event) ?? 0) + 1);
    } catch {
      /* ignore */
    }
  }
  console.log(`\n=== audit events (${lines.length} lines)`);
  console.log(`  ${JSON.stringify(Object.fromEntries(counts))}`);
  const rewrites = lines.filter((line) => line.includes('recall-rewrite')).slice(-3);
  for (const line of rewrites) console.log(`  ${line.slice(0, 200)}`);
}
store.close();
