#!/usr/bin/env node
/**
 * How many entries does a real task actually need on every turn?
 *
 * I answered this from memory-capacity folklore ("five to nine") once, which was a guess dressed as a
 * fact. The evidence was in the store the whole time: every render records which entries it listed, so a
 * per-session histogram says directly how many entries appeared on *nearly every* render of that session.
 *
 * The distinction that matters:
 *
 * - an entry present in most renders of a session is one that session needed throughout — the operational
 *   meaning of "standing";
 * - an entry present in a few renders is one that came up when its subject did — "topical".
 *
 * If real sessions show that almost no entry is present throughout, then `always` is rare in practice and
 * a small core is correct. If they show dozens, the core budget is wrong.
 *
 * Read-only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';

const root = resolveMemoryRoot(resolveDshHome());
const auditPath = join(root, 'audit.jsonl');

const lines = readFileSync(auditPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);

/** sessionId -> { renders, perId: Map<id, count> } */
const sessions = new Map();
let unreadable = 0;

for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    unreadable += 1;
    continue;
  }
  if (event.event !== 'inject') continue;
  const ids = Array.isArray(event.ids) ? event.ids : [];
  // **Only renders that listed something count as a turn for this question.**
  //
  // The first version of this script divided by every inject event and produced a median of zero standing
  // entries — which looked like a finding and was an artefact: half of all inject events carry no ids,
  // because that render listed nothing at all. Asking "how often was this entry present" has to be asked
  // over the renders that were capable of presenting it.
  if (ids.length === 0) continue;
  const sessionId = event.sessionId ?? '(none)';
  const bucket = sessions.get(sessionId) ?? { renders: 0, perId: new Map() };
  bucket.renders += 1;
  for (const id of ids) {
    bucket.perId.set(id, (bucket.perId.get(id) ?? 0) + 1);
  }
  sessions.set(sessionId, bucket);
}

console.log(`audit lines ${lines.length} · unreadable ${unreadable} · sessions with non-empty renders ${sessions.size}\n`);

// Only sessions long enough for "throughout" to mean anything. A three-render session cannot distinguish
// a standing entry from a coincidence.
const MIN_RENDERS = 30;
const eligible = [...sessions.entries()]
  .filter(([, bucket]) => bucket.renders >= MIN_RENDERS)
  .sort((a, b) => b[1].renders - a[1].renders);

console.log(`sessions with >= ${MIN_RENDERS} renders: ${eligible.length}\n`);

if (eligible.length === 0) {
  console.log('no session is long enough to answer the question; the sample is the blocker, not the method');
  process.exit(0);
}

/** Presence thresholds to sweep: what counts as "on nearly every turn". */
const bands = [
  { label: '>= 90% of renders', fraction: 0.9 },
  { label: '>= 75%', fraction: 0.75 },
  { label: '>= 50%', fraction: 0.5 },
  { label: '>= 25%', fraction: 0.25 },
];

const totals = new Map(bands.map((band) => [band.label, []]));

for (const [sessionId, bucket] of eligible) {
  const counts = [];
  for (const [, count] of bucket.perId) counts.push(count / bucket.renders);
  counts.sort((a, b) => b - a);
  console.log(`session ${sessionId.slice(0, 24)}  renders ${String(bucket.renders).padStart(4)}  distinct entries ${String(bucket.perId.size).padStart(3)}`);
  for (const band of bands) {
    const n = counts.filter((fraction) => fraction >= band.fraction).length;
    totals.get(band.label).push(n);
    console.log(`   ${band.label.padEnd(18)} ${String(n).padStart(3)} entries`);
  }
  console.log('');
}

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

console.log('across every long session:');
for (const [label, values] of totals) {
  console.log(`  ${label.padEnd(18)} median ${median(values)}  max ${Math.max(...values)}  min ${Math.min(...values)}`);
}

console.log('\nreading it:');
console.log('  the ">= 90%" row is the operational count of entries that a real task needed on essentially');
console.log('  every turn. The median of that column is the number the core is actually asked to hold.');
