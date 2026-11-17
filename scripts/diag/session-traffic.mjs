#!/usr/bin/env node
/**
 * What does one real session actually do to the memory system?
 *
 * `report-production` aggregates the whole store; this narrows to a single session so the numbers can be
 * tied to a task somebody was really doing. Answers the questions the aggregate cannot: how much of the
 * block that session received was used, how many entries it created, and whether curation did anything.
 *
 * Usage: node scripts/diag/session-traffic.mjs <session-id-or-prefix> [--hours=N]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const needle = process.argv[2];
if (needle === undefined) {
  console.error('usage: node scripts/diag/session-traffic.mjs <session-id-or-prefix>');
  process.exit(2);
}
const hoursArg = process.argv.find((arg) => arg.startsWith('--hours='));
const hours = hoursArg === undefined ? 24 : Number(hoursArg.slice('--hours='.length));
const since = Date.now() - hours * 3_600_000;

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.4' });

const scopeKey = `session:${needle}`;
const scopeLike = `%${needle}%`;

console.log(`session ${needle} · window ${hours}h\n`);

// Memory this session produced.
const written = store.db
  .prepare(
    `SELECT m.id, m.kind, m.trust_source, h.status, m.created_at, m.title,
            COALESCE(u.mu_touched, 0) AS touched, COALESCE(u.inject_count, 0) AS injections,
            COALESCE(u.read_count, 0) AS reads
       FROM memory m JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      WHERE m.scope_key LIKE ? AND m.valid_to IS NULL
      ORDER BY m.created_at DESC`,
  )
  .all(scopeLike);

console.log(`entries attributed to this session: ${written.length}`);
const byStatus = {};
for (const row of written) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
console.log(`  by status ${JSON.stringify(byStatus)}`);

const muNow = store.muNow();
console.log('\n  newest first (μ = distance from the working set now):');
for (const row of written.slice(0, 12)) {
  const distance = row.touched > 0 ? Math.max(0, muNow - row.touched) : null;
  const age = distance === null ? 'no μ history' : `${distance.toFixed(1)} μ ago`;
  console.log(`    ${row.id}  ${row.kind}/${row.trust_source}/${row.status}  ${age}  inj=${row.injections} read=${row.reads}`);
  console.log(`      ${JSON.stringify(String(row.title).slice(0, 110))}`);
}

// The audit is the only place that records injections and curation for a session.
const auditPath = join(root, 'audit.jsonl');
let lines = [];
try {
  lines = readFileSync(auditPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
} catch (error) {
  console.log(`\naudit unreadable: ${String(error?.message ?? error)}`);
}

const marks = {
  inject: 0,
  slice: 0,
  curateStart: 0,
  curateRan: 0,
  curateWrote: 0,
  entriesFromCuration: 0,
  rewrite: 0,
  rewriteFound: 0,
  failures: 0,
};
const curateReasons = {};
const injectedIds = new Set();

for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (Number(event.ts) < since) continue;
  const text = JSON.stringify(event);
  if (!text.includes(needle)) continue;

  if (event.event === 'inject') {
    marks.inject += 1;
    for (const id of event.ids ?? []) injectedIds.add(id);
  } else if (event.event === 'recall-slice') {
    marks.slice += 1;
    for (const id of event.ids ?? []) injectedIds.add(id);
  } else if (event.event === 'recall-rewrite') {
    marks.rewrite += 1;
    if (event.found === true || (event.ids ?? []).length > 0) marks.rewriteFound += 1;
  } else if (event.event === 'curate-start') {
    marks.curateStart += 1;
  } else if (event.event === 'curate') {
    if (event.ran === true) {
      marks.curateRan += 1;
      marks.entriesFromCuration += Array.isArray(event.written) ? event.written.length : 0;
      if ((event.written ?? []).length > 0) marks.curateWrote += 1;
    }
    const reason = String(event.reason ?? '(none)');
    curateReasons[reason] = (curateReasons[reason] ?? 0) + 1;
  } else if (typeof event.event === 'string' && /fail|error/.test(event.event)) {
    marks.failures += 1;
  }
}

console.log(`\naudit lines for this session in the window:`);
console.log(`  inject ${marks.inject} · slice ${marks.slice} · distinct ids injected ${injectedIds.size}`);
console.log(`  rewrite fired ${marks.rewrite} · found ${marks.rewriteFound}`);
console.log(`  curate started ${marks.curateStart} · ran ${marks.curateRan} · wrote ${marks.curateWrote} (${marks.entriesFromCuration} entries)`);
console.log(`  failures ${marks.failures}`);
if (Object.keys(curateReasons).length > 0) {
  console.log('  curate reasons:');
  for (const [reason, count] of Object.entries(curateReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${reason}`);
  }
}

// Did the session use what it was given? An injected entry that was later opened is the signal.
if (injectedIds.size > 0) {
  const ids = [...injectedIds];
  const placeholders = ids.map(() => '?').join(',');
  const used = store.db
    .prepare(`SELECT COUNT(*) AS n FROM memory_usage WHERE id IN (${placeholders}) AND read_count > 0`)
    .get(...ids).n;
  console.log(`\n  entries injected into this session that were later opened: ${used} of ${injectedIds.size}`);
}

store.close();
