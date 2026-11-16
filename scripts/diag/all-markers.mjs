#!/usr/bin/env node
/** Every diagnostic marker the plugin records, so a silent no-op cannot hide. */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { readMeta } from '../../src/host/store/schema.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.4.2' });

const show = (label, value) => console.log(`${label.padEnd(26)} ${value}`);

const seen = readMeta(store.db, 'llm_route_seen');
show('llm_route_seen', seen === undefined ? '(absent)' : new Date(Number(seen)).toISOString());
show('llm_complete', readMeta(store.db, 'llm_complete') ?? '(absent)');

const probe = readMeta(store.db, 'curator_probe');
show('curator_probe', probe === undefined ? '(absent)' : 'present');
if (probe !== undefined) {
  const record = JSON.parse(probe);
  show('  ok', record.ok);
  show('  version', record.version);
  show('  caught', JSON.stringify(record.caught));
  show('  missed', JSON.stringify(record.missed));
  for (const item of record.kept ?? []) console.log(`  kept: ${item.kind} · ${item.title}`);
}

show('curator_probe_skipped', readMeta(store.db, 'curator_probe_skipped') ?? '(absent)');
show('curator_probe_error', readMeta(store.db, 'curator_probe_error') ?? '(absent)');
store.close();
