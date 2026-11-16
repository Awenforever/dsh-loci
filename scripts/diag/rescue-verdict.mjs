#!/usr/bin/env node
/**
 * Did the rewrite rescue finally receive a real question?
 *
 * The whole point of 4.7.0 was one bit: whether the rescue is handed the current question. The
 * audit distinguishes the three outcomes, so this reads it instead of guessing.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { readFileSync } from 'node:fs';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { readMeta } from '../../src/host/store/schema.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.7.0' });

const lines = readFileSync(store.paths.audit, 'utf8').split('\n').filter((line) => line.trim().length > 0);
const events = [];
for (const line of lines) {
  try {
    events.push(JSON.parse(line));
  } catch {
    /* ignore */
  }
}

const rewrites = events.filter((event) => event.event?.startsWith('recall-rewrite'));
const renders = events.filter((event) => event.event === 'slice-render');

console.log(`versions in use       4.7.0`);
console.log(`slice-render events   ${renders.length}`);
console.log(`rewrite events        ${rewrites.length}`);

const byKind = new Map();
for (const event of rewrites) byKind.set(event.event, (byKind.get(event.event) ?? 0) + 1);
console.log(`  ${JSON.stringify(Object.fromEntries(byKind))}`);

if (rewrites.length > 0) {
  console.log('\nmost recent:');
  for (const event of rewrites.slice(-4)) {
    const { ts, event: kind, ...rest } = event;
    console.log(`  ${new Date(ts).toISOString().slice(11, 19)} ${kind} ${JSON.stringify(rest).slice(0, 220)}`);
  }
}

const renderQueries = renders.map((event) => event.queryChars ?? 0);
if (renderQueries.length > 0) {
  console.log(`\nslice queries seen   ${JSON.stringify(renderQueries.slice(-8))} (chars)`);
}

console.log(`\nuser_tracker         ${readMeta(store.db, 'user_tracker') ?? '(absent — expected: the question is not event-driven)'}`);
console.log(`llm_complete         ${readMeta(store.db, 'llm_complete') ?? '(absent)'}`);

const rescued = events.filter((event) => event.event === 'recall-rewrite');
const empty = events.filter((event) => event.event === 'recall-rewrite-empty');
const skipped = events.filter((event) => event.event === 'recall-rewrite-skip');
console.log('\nverdict:');
if (rescued.length > 0) console.log('  the rescue found memory — the loop is closed.');
else if (empty.length > 0) console.log('  the rescue ran with a real question and the rewrites matched nothing — tuning, not wiring.');
else if (skipped.some((event) => (event.queryChars ?? 0) > 0)) console.log('  the rescue had a question but the model route or reply was unusable.');
else if (skipped.length > 0) console.log('  still an empty question — the fix did not land.');
else console.log('  no rescue has run yet since 4.7.0 was installed.');
store.close();
