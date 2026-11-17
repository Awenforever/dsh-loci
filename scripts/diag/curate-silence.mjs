#!/usr/bin/env node
/**
 * Thirty-five curation runs, zero entries written. Before 5.2.x that was not the pattern.
 *
 * Either the sessions genuinely had nothing worth remembering — plausible for a stretch of mechanical work —
 * or the new fields broke the reply format and every run is failing softly. Those need opposite responses,
 * so this reads the events in full rather than trusting the summary line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';

const root = resolveMemoryRoot(resolveDshHome());
const lines = readFileSync(join(root, 'audit.jsonl'), 'utf8').split('\n').filter((line) => line.trim().length > 0);

const events = [];
for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  events.push(event);
}

// Before the applies change (5.2.0 at 15:05) versus after.
const APPLIES_SHIPPED = Date.parse('2026-11-17T15:05:00+08:00');
const curates = events.filter((event) => event.event === 'curate');

const bucket = (from, to) => {
  const list = curates.filter((event) => Number(event.ts) >= from && (to === undefined || Number(event.ts) < to));
  const ran = list.filter((event) => event.ran === true);
  // `written` is a count, not an array. Reading it as an array is what made this whole file's premise
  // wrong: it reported "zero write rate before AND after", which was the script's bug, not the product's.
  const wrote = ran.filter((event) => Number(event.written ?? 0) > 0);
  const entries = ran.reduce((sum, event) => sum + Number(event.written ?? 0), 0);
  return { total: list.length, ran: ran.length, wrote: wrote.length, entries };
};

const before = bucket(0, APPLIES_SHIPPED);
const after = bucket(APPLIES_SHIPPED);
console.log('curation, before vs after the applies change:');
console.log(`  before  events ${before.total} · ran ${before.ran} · runs that wrote ${before.wrote} · entries ${before.entries}`);
console.log(`  after   events ${after.total} · ran ${after.ran} · runs that wrote ${after.wrote} · entries ${after.entries}`);

if (before.ran > 0 && after.ran > 0) {
  const beforeRate = before.wrote / before.ran;
  const afterRate = after.wrote / after.ran;
  console.log(`\n  write rate per ran curation: ${(beforeRate * 100).toFixed(1)}% → ${(afterRate * 100).toFixed(1)}%`);
}

// The full shape of a recent event, in case a field carries the reason.
const recent = curates.slice(-4);
console.log('\nlast few curate events, in full:');
for (const event of recent) {
  console.log(`  ${JSON.stringify(event).slice(0, 320)}`);
}

// Long-horizon: was "ran but wrote nothing" normal before the change?
const reasonCounts = new Map();
for (const event of curates) {
  if (event.ran !== true) continue;
  const key = Number(event.written ?? 0) > 0 ? `wrote ${event.written}` : `ran, wrote nothing (reason=${JSON.stringify(String(event.reason ?? ''))})`;
  reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
}
console.log('\nall ran curations, by outcome:');
for (const [key, count] of [...reasonCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${key}`);
}
