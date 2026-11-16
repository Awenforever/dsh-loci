#!/usr/bin/env node
/** Every curation-related audit line, and why it may be absent. */
import { effectiveConfig } from '../../src/host/config.js';
import { readFileSync } from 'node:fs';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.7.1' });

const events = readFileSync(store.paths.audit, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .filter(Boolean);

const kinds = new Map();
for (const event of events) kinds.set(event.event, (kinds.get(event.event) ?? 0) + 1);
console.log('all audit events:', JSON.stringify(Object.fromEntries(kinds)));

const curation = events.filter((event) => event.event === 'curate' || event.event === 'curate-probe');
console.log(`\ncuration events: ${curation.length}`);
for (const event of curation.slice(-6)) {
  const { ts, ...rest } = event;
  console.log(`  ${new Date(ts).toISOString().slice(11, 19)} ${JSON.stringify(rest).slice(0, 200)}`);
}

console.log(`\ncuratorMode in force   ${effectiveConfig({}).curatorMode}`);
console.log(`curator-sourced rows   ${store.db.prepare("SELECT COUNT(*) AS n FROM memory WHERE trust_source = 'curator'").get().n}`);
store.close();
