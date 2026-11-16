#!/usr/bin/env node
/**
 * Why does curation come back without writing anything?
 *
 * The production report lists the distinct reasons from `curate` events, and some of them are not
 * decisions — `reply is not JSON`, `reply has no keep array` — they are the model transport or the
 * parser failing. Those are worth separating from "the model judged and kept nothing", because only
 * the first kind is a defect.
 *
 * Usage: node scripts/diag/curate-reasons.mjs [--hours 48]
 */
import { existsSync, readFileSync } from 'node:fs';
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const hoursArg = process.argv.find((arg) => arg.startsWith('--hours='));
const hours = hoursArg === undefined ? 48 : Math.max(1, Number(hoursArg.slice('--hours='.length)) || 48);

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.0.3' });
if (!existsSync(store.paths.audit)) {
  console.log('no audit log');
  store.close();
  process.exit(0);
}

const since = Date.now() - hours * 3_600_000;
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

const curates = events.filter((event) => event.event === 'curate' && Number(event.ts) >= since);
const byReason = new Map();
for (const event of curates) {
  const reason = String(event.reason ?? '(ran, wrote nothing)');
  byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
}

console.log(`curate outcomes in the last ${hours}h: ${curates.length}`);
for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
  const defect = /not JSON|no keep array|threw|model|route/i.test(reason) ? '  ← transport/parse defect' : '';
  console.log(`  ${String(n).padStart(4)}  ${reason}${defect}`);
}

const defects = curates.filter((event) => /not JSON|no keep array|threw|route/i.test(String(event.reason ?? '')));
if (defects.length > 0) {
  console.log(`\nmost recent ${Math.min(3, defects.length)} defect(s):`);
  for (const event of defects.slice(-3)) {
    const { ts, ...rest } = event;
    console.log(`  ${new Date(ts).toISOString().slice(11, 19)} ${JSON.stringify(rest).slice(0, 220)}`);
  }
  console.log('\nA defect means the model route or the parser failed — not that the model judged and kept nothing.');
} else {
  console.log('\nno transport or parse defects in the window');
}
store.close();
