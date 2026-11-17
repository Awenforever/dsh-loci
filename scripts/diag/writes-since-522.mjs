#!/usr/bin/env node
/**
 * Every write since 5.2.2 shipped, from every session — not just the one I was watching.
 *
 * The earlier check filtered by a single session prefix and by a cutoff that preceded the release, so it
 * kept reporting "no data". This lists what actually happened after the signal existed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';

// 5.2.2 (the release that started recording `supplied`) went in at 15:51 +0800.
const CUTOFF = Date.parse('2026-11-17T15:51:00+08:00');
const root = resolveMemoryRoot(resolveDshHome());
const lines = readFileSync(join(root, 'audit.jsonl'), 'utf8').split('\n').filter((line) => line.trim().length > 0);

const writes = [];
for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.event !== 'write') continue;
  writes.push(event);
}

const after = writes.filter((event) => Number(event.ts) >= CUTOFF);
console.log(`total writes in the audit: ${writes.length}`);
console.log(`writes since 5.2.2 (${new Date(CUTOFF).toISOString().slice(11, 16)}Z): ${after.length}\n`);

for (const event of after) {
  const time = new Date(Number(event.ts)).toISOString().slice(11, 19);
  const supplied = event.supplied === undefined ? '(no signal)' : `applies=${event.supplied.applies}`;
  console.log(`${time}  ${String(event.kind ?? '?').padEnd(10)} ${String(event.trust_source ?? '').padEnd(8)} ${supplied.padEnd(24)} ${String(event.scopeKey ?? '').slice(0, 40)}`);
}

// And the curate events, since a curation that writes nothing is also information.
const curates = lines
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .filter((event) => event?.event === 'curate' && Number(event.ts) >= CUTOFF);
console.log(`\ncurate events since 5.2.2: ${curates.length}`);
for (const event of curates.slice(-8)) {
  const time = new Date(Number(event.ts)).toISOString().slice(11, 19);
  console.log(
    `  ${time}  ran=${String(event.ran).padEnd(5)} written=${String(Number(event.written ?? 0)).padEnd(2)} reason=${JSON.stringify(String(event.reason ?? '').slice(0, 46))}`,
  );
}

console.log('\nverdict:');
if (after.length === 0) {
  console.log('  no write has happened since the signal existed, so nothing here says anything about model');
  console.log('  behaviour. The earlier "no data" conclusion was about the window, not about willingness.');
} else {
  const withSignal = after.filter((event) => event.supplied !== undefined);
  const supplied = withSignal.filter((event) => event.supplied.applies === true);
  console.log(`  ${withSignal.length} of ${after.length} writes carried the signal; ${supplied.length} supplied a verdict.`);
  if (withSignal.length > 0 && supplied.length === 0) {
    console.log('  the prompt offers the field and the parser accepts it, yet no caller answered it — worth fixing');
    console.log('  by making the question unskippable rather than optional.');
  }
}
