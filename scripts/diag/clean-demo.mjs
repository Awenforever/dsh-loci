#!/usr/bin/env node
/** Remove the diagnostic rows the scope API probe wrote into the live database. */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '3.8.0' });

const count = (sql) => store.db.prepare(sql).get().n;
const DEMO = 'session-scope-demo';

const before = {
  request: count(`SELECT COUNT(*) AS n FROM request_stat WHERE session_id = '${DEMO}'`),
  scope: count(`SELECT COUNT(*) AS n FROM session_scope WHERE session_id = '${DEMO}'`),
};

store.db.prepare(`DELETE FROM request_stat WHERE session_id = '${DEMO}'`).run();
store.db.prepare(`DELETE FROM session_scope WHERE session_id = '${DEMO}'`).run();

const after = {
  request: count(`SELECT COUNT(*) AS n FROM request_stat WHERE session_id = '${DEMO}'`),
  scope: count(`SELECT COUNT(*) AS n FROM session_scope WHERE session_id = '${DEMO}'`),
};

console.log('request_stat rows for the demo session', before.request, '->', after.request);
console.log('session_scope rows for the demo session', before.scope, '->', after.scope);
console.log('remaining request_stat rows', count('SELECT COUNT(*) AS n FROM request_stat'));
console.log('entries still present', count('SELECT COUNT(*) AS n FROM memory'));
console.log('schema version', store.db.prepare('PRAGMA user_version').get().user_version);
store.close();
