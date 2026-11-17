#!/usr/bin/env node
/**
 * What did the model actually reply to the curator prompt?
 *
 * The prompt carries `applies` and the parser handles it, so the question is what came back. Without the raw
 * reply this is guesswork — which is exactly why 5.0.4 started recording `rawHead`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.2.1' });
const cutoff = Date.parse('2026-11-17T15:05:00+08:00');

const lines = readFileSync(join(root, 'audit.jsonl'), 'utf8').split('\n').filter((line) => line.trim().length > 0);
const curates = [];
const writes = [];

for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (Number(event.ts) < cutoff) continue;
  if (event.event === 'curate') curates.push(event);
  if (event.event === 'write') writes.push(event);
}

console.log(`curate events since 5.2.0: ${curates.length}`);
for (const event of curates.slice(-5)) {
  console.log(`  ran=${event.ran} reason=${JSON.stringify(String(event.reason ?? '').slice(0, 40))} written=${Array.isArray(event.written) ? event.written.length : 0}`);
  if (event.rawHead !== undefined) console.log(`    rawHead: ${JSON.stringify(String(event.rawHead).slice(0, 200))}`);
}

console.log(`\nwrite events since 5.2.0: ${writes.length}`);
for (const event of writes) {
  console.log(`  ${event.op} ${event.kind} · supplied applies=${event.supplied?.applies}`);
}

// The writes and the curate that produced them should be adjacent in time; if a curate ran and reported
// written entries but no write event carries a supplied verdict, the model omitted the field.
console.log('\nwhat this means:');
const withSignal = writes.filter((event) => event.supplied !== undefined);
const supplied = withSignal.filter((event) => event.supplied.applies === true);
if (writes.length === 0) {
  console.log('  no writes in this window.');
} else if (withSignal.length === 0) {
  console.log('  **The writes predate the `supplied` signal**, so this cannot answer the question. Their');
  console.log('  `supplied` is absent, not false — the audit only started recording it in 5.2.1. Waiting for a');
  console.log('  write to happen after that is the only honest answer; inferring from an absent field would be');
  console.log('  reading a gap as a fact.');
} else if (supplied.length === 0) {
  console.log(`  ${withSignal.length} writes carried the signal and none supplied a verdict. The prompt offers the field`);
  console.log('  and the parser accepts it, so the model chose not to answer — most likely because the JSON');
  console.log('  example shows every key at once, which reads as a menu rather than as a question.');
} else {
  console.log(`  ${supplied.length} of ${withSignal.length} writes supplied a verdict; the mechanism works when the model answers.`);
}
store.close();
