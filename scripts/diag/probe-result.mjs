#!/usr/bin/env node
/**
 * Read the curator probe's recorded result from the live store.
 *
 * The probe is how model judgement became observable: it runs one real curation pass at activation
 * and stores the outcome. This reads that row instead of guessing whether the model is working.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { PROBE_META_KEY } from '../../src/host/record/probe.js';
import { readMeta } from '../../src/host/store/schema.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.4.0' });

const raw = readMeta(store.db, PROBE_META_KEY);
console.log(`probe row present  ${raw !== undefined}`);
if (raw === undefined) {
  console.log('The probe has not run yet: it fires at activation when the model route exists.');
  console.log('A plugin install reloads the Host, so a fresh boot should have produced it.');
} else {
  const record = JSON.parse(raw);
  console.log(`version            ${record.version}`);
  console.log(`at                 ${new Date(record.at).toISOString()}`);
  console.log(`ok                 ${record.ok}`);
  if (record.error !== undefined) console.log(`error              ${record.error}`);
  if (record.caught !== undefined) console.log(`caught             ${JSON.stringify(record.caught)}`);
  if (record.missed !== undefined) console.log(`missed             ${JSON.stringify(record.missed)}`);
  if (record.keptNoise !== undefined) console.log(`kept noise         ${JSON.stringify(record.keptNoise)}`);
  console.log(`parsed             ${record.parsed}`);
  console.log('kept:');
  for (const item of record.kept ?? []) console.log(`  ${item.kind.padEnd(11)} ${item.title}`);
  if ((record.dropped ?? []).length > 0) {
    console.log('dropped by validation:');
    for (const item of record.dropped) console.log(`  ${item.title ?? '(no title)'} — ${item.reason}`);
  }
}

console.log(`\ncuratorMode        ${effectiveConfig({}).curatorMode}`);
console.log(`entries            ${store.db.prepare('SELECT COUNT(*) AS n FROM memory').get().n}`);
store.close();
