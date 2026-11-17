#!/usr/bin/env node
/** Did the answer-eval fixture land, and is anything still stuck? */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.1' });

const fixture = store.db
  .prepare("SELECT id, title, created_at FROM memory WHERE scope_key = 'session:answer-eval' ORDER BY created_at")
  .all();
console.log(`fixture rows in session:answer-eval: ${fixture.length}`);
for (const row of fixture) {
  console.log(`  ${new Date(Number(row.created_at)).toISOString().slice(11, 19)}  ${row.title}`);
}

const mu = store.muNow();
const last = store.db.prepare('SELECT at, mu, reason, add_n, use_n FROM mu_event ORDER BY id DESC LIMIT 5').all();
console.log(`\nmu now ${mu.toFixed(2)}`);
console.log('last advances:');
for (const row of last) {
  console.log(`  ${new Date(Number(row.at)).toISOString().slice(11, 19)}  mu=${Number(row.mu).toFixed(2)}  ${row.reason} add=${row.add_n} use=${row.use_n}`);
}
store.close();
