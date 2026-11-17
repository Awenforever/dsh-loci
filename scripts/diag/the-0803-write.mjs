#!/usr/bin/env node
/**
 * The write at 08:03 — was it a curator entry with a real verdict, or one of my probes?
 *
 * Everything hinges on this one row. The curator's newest live entry and a write event carrying
 * `supplied.applies: true` both sit at 08:03, and my own diagnostic wrote probes around then too. If they
 * are the same row, a model has answered `applies` and the last unknown is closed. If not, it has not.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.2.3' });

const lines = readFileSync(join(root, 'audit.jsonl'), 'utf8').split('\n').filter((line) => line.trim().length > 0);
const writes = [];
for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.event === 'write') writes.push(event);
}

const suppliedOnes = writes.filter((event) => event.supplied !== undefined);
console.log('writes carrying `supplied`:');
for (const event of suppliedOnes) {
  const row = store.db.prepare('SELECT trust_source, scope_key, title, applies FROM memory WHERE id = ? ORDER BY revision DESC LIMIT 1').get(event.id);
  console.log(`\n  ${new Date(Number(event.ts)).toISOString().slice(11, 19)}  ${event.id}`);
  console.log(`    audit: applies supplied=${event.supplied.applies} · scope ${String(event.scopeKey ?? '').slice(0, 44)}`);
  console.log(`    row  : trust_source=${row?.trust_source} · applies=${row?.applies}`);
  console.log(`    title: ${JSON.stringify(String(row?.title ?? '(gone)').slice(0, 70))}`);
  const isProbe = String(event.scopeKey ?? '').includes('probe') || String(row?.title ?? '').startsWith('探针');
  console.log(`    probe of mine: ${isProbe}`);
}

// And every curator write, to see whether any of them ever carried the signal.
const curatorIds = store.db
  .prepare("SELECT id FROM memory WHERE trust_source = 'curator' AND valid_to IS NULL")
  .all()
  .map((row) => row.id);
const curatorWithSignal = writes.filter((event) => curatorIds.includes(event.id) && event.supplied !== undefined);
console.log(`\ncurator entries still live: ${curatorIds.length}`);
console.log(`of those, writes that carried \`supplied\`: ${curatorWithSignal.length}`);

console.log('\nthe question this answers:');
if (curatorWithSignal.length === 0) {
  console.log('  no curator write has passed through the signal. The 08:03 row with a verdict is a probe of mine,');
  console.log('  so a model has still never been observed answering `applies` on the curation path.');
} else {
  console.log(`  ${curatorWithSignal.length} curator write(s) carried a verdict — the curation path is answering the field.`);
}
store.close();
