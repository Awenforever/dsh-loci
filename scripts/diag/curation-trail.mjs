#!/usr/bin/env node
/** The full curation trail: every trigger, outcome and reason. */
import { effectiveConfig } from '../../src/host/config.js';
import { readFileSync } from 'node:fs';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.9.0' });

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
  .filter((event) => event && (event.event === 'curate' || event.event === 'curate-start'));

console.log(`curation trail (${events.length} rows)`);
for (const event of events) {
  const { ts, event: kind, ...rest } = event;
  console.log(`  ${new Date(ts).toISOString().slice(11, 19)} ${kind.padEnd(13)} ${JSON.stringify(rest).slice(0, 170)}`);
}

const ran = events.filter((event) => event.event === 'curate' && event.ran === true);
const wrote = events.filter((event) => event.event === 'curate' && (event.written ?? 0) > 0);
console.log(`\nran successfully   ${ran.length}`);
console.log(`wrote entries      ${wrote.length}`);
console.log(`curator-sourced    ${store.db.prepare("SELECT COUNT(*) AS n FROM memory WHERE trust_source = 'curator'").get().n}`);
store.close();
