#!/usr/bin/env node
/**
 * The counter appeared to go backwards: 540.53 at 01:59, then 276.9 read at 02:45.
 *
 * `mu_event` is append-only, so a counter that decreases means `mu_now` was written by something other
 * than an advance — or that two stores disagree. This dumps the evidence instead of reasoning about it.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { readMeta } from '../../src/host/store/schema.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
console.log(`memory root ${root}`);
for (const name of readdirSync(root)) {
  const full = join(root, name);
  const info = statSync(full);
  console.log(`  ${name.padEnd(46)} ${String(info.size).padStart(9)}  ${info.mtime.toISOString().slice(0, 19)}`);
}

const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.0.5' });
const muNow = readMeta(store.db, 'mu_now');
const rows = store.db.prepare('SELECT id, at, mu, add_n, use_n, reason FROM mu_event ORDER BY id').all();

console.log(`\nmeta.mu_now   ${muNow}`);
console.log(`mu_event rows ${rows.length}`);
if (rows.length > 0) {
  const first = rows[0];
  const last = rows[rows.length - 1];
  console.log(`  first ${new Date(first.at).toISOString()}  mu=${Number(first.mu).toFixed(2)}`);
  console.log(`  last  ${new Date(last.at).toISOString()}  mu=${Number(last.mu).toFixed(2)}`);

  // A decrease anywhere in an append-only trail is the signal.
  let decreases = 0;
  let previous = Number(first.mu);
  for (const row of rows.slice(1)) {
    const value = Number(row.mu);
    if (value < previous) {
      decreases += 1;
      if (decreases <= 5) {
        console.log(`  DECREASE at ${new Date(row.at).toISOString()}: ${previous.toFixed(2)} -> ${value.toFixed(2)} (${row.reason})`);
      }
    }
    previous = value;
  }
  console.log(`  decreases in the trail: ${decreases}`);
  console.log(`  trail max ${Math.max(...rows.map((row) => Number(row.mu))).toFixed(2)} · meta says ${Number(muNow ?? 0).toFixed(2)}`);
}

// The store also records its own view; if this disagrees with the meta key, one of them is stale.
console.log(`\nstore.muNow() ${store.muNow().toFixed(2)}`);

// The freeze claim, tested against real gaps rather than asserted.
//
// MU may only advance when something happens, so a long gap between two advances must mean the counter
// did *not* move during it — and, conversely, a gap with advances in it means somebody was working. This
// prints the largest silences, in local time, so "the eight hours I was asleep" is visible as silence
// rather than inferred from it.
if (rows.length > 1) {
  const gaps = [];
  for (let index = 1; index < rows.length; index += 1) {
    const gapMs = Number(rows[index].at) - Number(rows[index - 1].at);
    if (gapMs >= 10 * 60_000) {
      gaps.push({
        from: new Date(Number(rows[index - 1].at)),
        to: new Date(Number(rows[index].at)),
        minutes: Math.round(gapMs / 60_000),
        moved: Number(rows[index].mu) - Number(rows[index - 1].mu),
      });
    }
  }
  gaps.sort((a, b) => b.minutes - a.minutes);
  console.log(`\nsilences of 10 minutes or more: ${gaps.length}`);
  for (const gap of gaps.slice(0, 6)) {
    const local = (date) => date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    console.log(`  ${local(gap.from)} → ${local(gap.to)}  ${String(gap.minutes).padStart(4)} min  counter moved ${gap.moved.toFixed(2)}`);
  }
  const longestIdle = gaps[0];
  if (longestIdle !== undefined) {
    console.log(
      `\nfreeze check: the longest silence is ${longestIdle.minutes} minutes and the counter moved ` +
        `${longestIdle.moved.toFixed(2)} MU across it — it can only move when an inject or a write happened, ` +
        `so the movement at the endpoints is the event that ended the silence, not time passing.`,
    );
  }
}

const lastHour = rows.filter((row) => Number(row.at) > Date.now() - 3_600_000).length;
const sinceMidnight = rows.filter((row) => Number(row.at) > Date.parse('2026-11-17T00:00:00+08:00')).length;
console.log(`\nadvances in the last hour ${lastHour} · today ${sinceMidnight}`);
store.close();
