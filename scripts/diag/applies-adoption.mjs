#!/usr/bin/env node
/**
 * Is the model actually using the new field, or is everything still landing on the default?
 *
 * The whole value of `applies` depends on someone supplying it. If every post-5.2.0 write still says
 * `topic`, the column is decorative — which is exactly what `importance` was for eleven releases, and the
 * reason this project stopped trusting a field because it exists.
 *
 * Read-only.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.2.1' });

// 5.2.0 shipped at 15:05 +0800 on 2026-11-17.
const cutoff = Date.parse('2026-11-17T15:05:00+08:00');

const rows = store.db
  .prepare(
    `SELECT m.id, m.applies, m.kind, m.trust_source, m.importance, m.when_condition, m.created_at, h.status, m.title
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE m.valid_to IS NULL AND m.created_at >= ?
      ORDER BY m.created_at DESC`,
  )
  .all(cutoff);

console.log(`entries written since 5.2.0 (15:05): ${rows.length}`);
if (rows.length === 0) {
  console.log('\nnone yet. The field is wired but unexercised — a model has to actually call loci_write for this');
  console.log('to mean anything, and a script cannot stand in for that.');
}

for (const row of rows) {
  console.log(`  ${new Date(Number(row.created_at)).toISOString().slice(11, 19)}  ${row.applies.padEnd(6)} ${row.kind.padEnd(10)} ${row.trust_source.padEnd(8)} imp=${row.importance}  ${JSON.stringify(String(row.title).slice(0, 52))}`);
  if (row.when_condition) console.log(`              when: ${JSON.stringify(String(row.when_condition).slice(0, 60))}`);
}

// The honest summary: how many were supplied versus defaulted.
//
// This now comes from the audit's `supplied` flag rather than from the column value, because the column
// cannot tell a deliberate `topic` from a write that never mentioned the field. The flag was added after
// three post-5.2.0 curator writes came back all-topic with no way to tell which case they were.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const auditLines = readFileSync(join(root, 'audit.jsonl'), 'utf8').split('\n').filter((line) => line.trim().length > 0);
let creates = 0;
let suppliedApplies = 0;
let suppliedImportance = 0;
const bySource = new Map();

for (const line of auditLines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.event !== 'write') continue;
  if (Number(event.ts) < cutoff) continue;
  creates += 1;
  if (event.supplied?.applies === true) suppliedApplies += 1;
  if (event.supplied?.importance === true) suppliedImportance += 1;
  const key = `${event.op}/${event.kind}`;
  bySource.set(key, (bySource.get(key) ?? 0) + 1);
}

console.log(`\nwrites since 5.2.0 (from the audit): ${creates}`);
console.log(`  supplied applies     ${suppliedApplies}`);
console.log(`  supplied importance  ${suppliedImportance}`);
console.log(`  by op/kind           ${JSON.stringify(Object.fromEntries(bySource))}`);

if (creates > 0) {
  const rate = suppliedApplies / creates;
  console.log(
    rate === 0
      ? '\n**No write has supplied `applies` yet.** Every entry is topic because that is the default, not because\nanything judged it. The field is wired and unexercised; the next question is whether the curator prompt\nand the tool description actually cause a model to answer it.'
      : `\n${Math.round(rate * 100)}% of writes stated a verdict.`,
  );
}

store.close();
