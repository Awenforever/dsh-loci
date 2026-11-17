#!/usr/bin/env node
/**
 * When did curation last actually write anything?
 *
 * The audit says every "ran" curation in the retained window wrote zero entries — 45 before the applies
 * change and 14 after. Yet the store holds entries whose `trust_source` is `curator`. Either those predate
 * the window, or something is wrong with how the run reports its own output.
 *
 * Both are worth knowing, and they lead to different conclusions about whether curation works at all.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.2.3' });

const bySource = store.db
  .prepare(
    `SELECT m.trust_source, COUNT(*) AS n, MIN(m.created_at) AS first, MAX(m.created_at) AS last
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE m.valid_to IS NULL AND h.status <> 'deleted'
      GROUP BY m.trust_source ORDER BY n DESC`,
  )
  .all();
console.log('live entries by trust source:');
for (const row of bySource) {
  const first = new Date(Number(row.first)).toISOString().slice(0, 16);
  const last = new Date(Number(row.last)).toISOString().slice(0, 16);
  console.log(`  ${String(row.trust_source ?? '?').padEnd(10)} ${String(row.n).padStart(3)}  ${first} → ${last}`);
}

const curators = store.db
  .prepare(
    `SELECT m.id, m.created_at, m.title FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE m.valid_to IS NULL AND h.status <> 'deleted' AND m.trust_source = 'curator'
      ORDER BY m.created_at DESC`,
  )
  .all();
console.log(`\ncurator-written entries still live: ${curators.length}`);
for (const row of curators.slice(0, 10)) {
  console.log(`  ${new Date(Number(row.created_at)).toISOString().slice(0, 16)}  ${JSON.stringify(String(row.title).slice(0, 56))}`);
}

// What the audit recorded when those entries were written.
const { readFileSync } = await import('node:fs');
const { join } = await import('node:path');
const lines = readFileSync(join(root, 'audit.jsonl'), 'utf8').split('\n').filter((line) => line.trim().length > 0);
const curateEvents = [];
const writeEvents = [];
for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.event === 'curate') curateEvents.push(event);
  if (event.event === 'write') writeEvents.push(event);
}

// A curate that wrote N entries should be followed by a write event carrying trustSource 'curator'.
const curatorWrites = writeEvents.filter((event) => event.trust_source === 'curator');
console.log(`\nwrite events with trust_source curator: ${curatorWrites.length}`);
const eventShapes = new Map();
for (const event of curateEvents) {
  const key = `written=${JSON.stringify(event.written)} reason=${JSON.stringify(event.reason)}`;
  eventShapes.set(key, (eventShapes.get(key) ?? 0) + 1);
}
console.log('\ncurate event shapes (the summary line may be misreading its own field):');
for (const [key, count] of [...eventShapes].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  ${String(count).padStart(4)}  ${key}`);
}
console.log('\nthe audit `write` event has these keys:', Object.keys(writeEvents[writeEvents.length - 1] ?? {}).join(', '));
store.close();
