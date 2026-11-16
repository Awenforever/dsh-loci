#!/usr/bin/env node
/** What version opened the live store, and did any probe/curation event reach the audit log? */
import { effectiveConfig } from '../../src/host/config.js';
import { existsSync, readFileSync } from 'node:fs';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { PROBE_META_KEY } from '../../src/host/record/probe.js';
import { META_KEYS, readMeta } from '../../src/host/store/schema.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.4.0' });

console.log('meta plugin_version   ', readMeta(store.db, META_KEYS.pluginVersion));
console.log('meta host_version     ', readMeta(store.db, META_KEYS.hostVersion));
console.log('meta curator_probe    ', readMeta(store.db, PROBE_META_KEY) === undefined ? '(absent)' : 'present');

const audit = store.paths.audit;
console.log('audit file            ', audit);
if (existsSync(audit)) {
  const lines = readFileSync(audit, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  console.log('audit lines           ', lines.length);
  const counts = new Map();
  for (const line of lines) {
    try {
      const event = JSON.parse(line).event;
      counts.set(event, (counts.get(event) ?? 0) + 1);
    } catch {
      /* ignore */
    }
  }
  console.log('audit events          ', JSON.stringify(Object.fromEntries(counts)));
  const probeLines = lines.filter((line) => line.includes('curate'));
  for (const line of probeLines.slice(-3)) console.log('  ', line.slice(0, 220));
} else {
  console.log('audit file missing');
}
store.close();
