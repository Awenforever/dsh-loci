#!/usr/bin/env node
/** Confirm the split is live: stable section bytes, and a per-turn slice event with the real question. */
import { effectiveConfig } from '../../src/host/config.js';
import { readFileSync } from 'node:fs';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.14.0' });

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

const count = (name) => events.filter((event) => event.event === name).length;
console.log(`recall-slice        ${count('recall-slice')}   ← per-turn slice, composed from the real question`);
console.log(`recall-rewrite      ${count('recall-rewrite')}`);
console.log(`recall-rewrite-empty ${count('recall-rewrite-empty')}`);
console.log(`recall-rewrite-skip ${count('recall-rewrite-skip')}`);
console.log(`slice-render        ${count('slice-render')}   ← the old section-level event, should stop growing`);

const slices = events.filter((event) => event.event === 'recall-slice').slice(-4);
if (slices.length > 0) {
  console.log('\nmost recent per-turn slices:');
  for (const event of slices) {
    const { ts, ...rest } = event;
    console.log(`  ${new Date(ts).toISOString().slice(11, 19)} ${JSON.stringify(rest).slice(0, 200)}`);
  }
}

const rebuilds = events.filter((event) => event.event === 'slice-render').slice(-3);
if (rebuilds.length > 0) {
  console.log('\nmost recent section renders (stable only, so queryChars should be absent now):');
  for (const event of rebuilds) {
    const { ts, ...rest } = event;
    console.log(`  ${new Date(ts).toISOString().slice(11, 19)} ${JSON.stringify(rest).slice(0, 200)}`);
  }
}
store.close();
