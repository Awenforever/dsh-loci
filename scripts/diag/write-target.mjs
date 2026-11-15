#!/usr/bin/env node
/**
 * What the live store now does with a write, given the new rule.
 *
 * Read-only apart from the schema upgrade the store performs on open (v4 -> v5 adds
 * `session_scope` and `request_stat.cwd`; it does not touch any row).
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { effectiveWriteScope, readScopeKeys, resolveScopes, scopeChoices } from '../../src/host/scope.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const config = effectiveConfig({});
const store = new Store({ memoryRoot: root, paths: layout(root), config, pluginVersion: '3.8.0' });

console.log(`schema version   ${store.db.prepare('PRAGMA user_version').get().user_version}`);
console.log(`tables           ${store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n}`);

const active = store.activeSession();
console.log(`\nactive session   ${active?.sessionId ?? '(none)'}`);
console.log(`recorded cwd     ${active?.cwd ?? '(none — this row predates v5)'}`);

const scopes = resolveScopes({ sessionId: active?.sessionId, cwd: active?.cwd });
console.log(`project found    ${scopes.projectRootFound}`);
console.log(`workspace label  ${scopes.labels.workspace}`);

const chosen = effectiveWriteScope(scopes, {
  override: store.getSessionScope(active?.sessionId),
  configured: config.defaultScope,
});
console.log(`\nconfig defaultScope   ${config.defaultScope}`);
console.log(`a bare write lands in ${chosen.scope}  (${chosen.key})`);
console.log(`reason                ${chosen.reason}`);
console.log(`choices offered       ${scopeChoices().map((c) => c.value).join(', ')}`);

console.log(`\nread set (unchanged, so nothing already stored is lost):`);
for (const key of readScopeKeys(scopes, { includeGlobal: config.includeGlobal !== false })) {
  const n = store.db.prepare('SELECT COUNT(*) AS n FROM memory WHERE scope_key = ?').get(key).n;
  console.log(`  ${key.padEnd(28)} entries ${n}`);
}
store.close();
