#!/usr/bin/env node
/** Did the `llm` route ever resolve for the plugin? Read the marker 4.4.1 writes. */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { readMeta } from '../../src/host/store/schema.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.4.1' });

const marker = readMeta(store.db, 'llm_route_seen');
console.log(`llm_route_seen      ${marker === undefined ? '(absent — the route never resolved for this plugin)' : new Date(Number(marker)).toISOString()}`);
console.log(`curator_probe       ${readMeta(store.db, 'curator_probe') === undefined ? '(absent)' : 'present'}`);

// What the plugin would see: is `llm` among the installed provider routes at all?
const bundles = store.db.prepare('SELECT COUNT(*) AS n FROM memory').get().n;
console.log(`entries             ${bundles}`);
store.close();
