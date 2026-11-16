#!/usr/bin/env node
/** What the panel's Statistics tab receives for the memory-unit block. */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.0.1' });

const scopeKeys = store.activeScopeKeys();
const payload = { mu: store.muPositions({ scopeKeys }), muTrail: store.muTrail(20) };

console.log(`scopes the panel is describing: ${JSON.stringify(scopeKeys)}`);
console.log(`mu.now      ${payload.mu.now.toFixed(2)}`);
console.log(`bands       ${JSON.stringify(payload.mu.bands)}`);
console.log(`retireAfter ${payload.mu.retireAfter} (0 = off)`);
console.log(`entries     ${payload.mu.entries.length}`);
for (const entry of payload.mu.entries.slice(0, 6)) {
  console.log(`   p=${entry.p.toFixed(1).padStart(6)}  ${String(entry.title).slice(0, 52)}`);
}
console.log(`trail (${payload.muTrail.length} rows, newest last):`);
for (const row of payload.muTrail.slice(-6)) {
  console.log(`   ${new Date(row.at).toISOString().slice(11, 19)} mu=${row.mu.toFixed(2)} reason=${row.reason} add=${row.add} use=${row.use}`);
}
if (payload.mu.entries.length === 0) {
  console.log('\nNOTE: nothing in the panel scope yet — the block renders but holds no entries.');
}
store.close();
