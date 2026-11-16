#!/usr/bin/env node
/** Migrate the live store to v6 and report what changed. Read-only apart from the migration. */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.1.0' });

const tableExists = (name) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).n === 1;

console.log('schema version       ', store.db.prepare('PRAGMA user_version').get().user_version);
console.log('injection_exempt     ', tableExists('injection_exempt'));
console.log('exempt sessions      ', store.listInjectionExempt().length);
console.log('entries still present', store.db.prepare('SELECT COUNT(*) AS n FROM memory').get().n);
console.log('verified entries     ', store.db
  .prepare("SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE h.status = 'verified'")
  .get().n);
store.close();
