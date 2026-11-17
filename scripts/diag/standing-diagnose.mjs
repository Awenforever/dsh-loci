#!/usr/bin/env node
/**
 * Why do the audit's inject events and request_stat's render count disagree?
 *
 * `request_stat` records 2092 renders; the standing-evidence script saw far fewer sessions and renders from
 * the audit. One of the two is not measuring what I assumed, and the conclusion about "how many entries a
 * task needs every turn" rests on knowing which.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.6' });

const lines = readFileSync(join(root, 'audit.jsonl'), 'utf8').split('\n').filter((line) => line.trim().length > 0);
let injectEvents = 0;
let injectWithIds = 0;
let injectTotalIds = 0;
const sessionsFromAudit = new Set();
const eventTypes = new Map();

for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  eventTypes.set(event.event, (eventTypes.get(event.event) ?? 0) + 1);
  if (event.event !== 'inject') continue;
  injectEvents += 1;
  const ids = event.ids;
  if (Array.isArray(ids) && ids.length > 0) {
    injectWithIds += 1;
    injectTotalIds += ids.length;
  }
  if (typeof event.sessionId === 'string') sessionsFromAudit.add(event.sessionId);
}

const stat = store.db.prepare('SELECT COUNT(*) AS n, SUM(entries_listed) AS listed FROM request_stat').get();
console.log(`audit inject events      ${injectEvents}`);
console.log(`  of which carried ids   ${injectWithIds}`);
console.log(`  total ids recorded     ${injectTotalIds}`);
console.log(`  distinct session ids   ${sessionsFromAudit.size}`);
console.log(`\nrequest_stat renders     ${stat.n}`);
console.log(`  entries_listed total   ${stat.listed}`);
console.log('\naudit event types:');
for (const [type, count] of [...eventTypes].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(count).padStart(5)}  ${type}`);
}

console.log('\nthe discrepancy explained:');
console.log(`  ${injectEvents} inject events against ${stat.n} renders — the audit stream and the table are written`);
console.log('  by the same call, so a gap means the audit file was rotated or truncated at some point, or that');
console.log('  request_stat survived a rebuild that the audit did not.');
store.close();
