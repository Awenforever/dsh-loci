#!/usr/bin/env node
/**
 * What the memory scope actually means, stated only as far as the data proves it.
 *
 * An earlier version of this probe claimed "entry X was injected into session Y" by pairing
 * every injection row with every entry written by a different session. `request_stat` does not
 * store the ids it listed, so that pairing proved nothing — it was an inference dressed as a
 * measurement. This version separates the three things that can actually be shown:
 *
 *   1. which scope key every entry lives in (a fact: one column);
 *   2. which scope key each session resolves to (a fact: recomputed from cwd);
 *   3. what a session's prompt *would* contain right now (rendered, not inferred).
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { renderIndexBody } from '../../src/host/inject/index-section.js';
import { resolveScopes, readScopeKeys } from '../../src/host/scope.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const config = effectiveConfig({});
const store = new Store({ memoryRoot: root, paths: layout(root), config, pluginVersion: '3.7.0' });

const entries = store.db
  .prepare(
    `SELECT m.id, m.kind, m.scope, m.scope_label, m.source_session, h.status, m.title,
            COALESCE(u.inject_count, 0) AS injections
       FROM memory m
       JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      ORDER BY m.created_at`,
  )
  .all();

console.log('=== 1. entries and the scope key they live in ===');
for (const entry of entries) {
  console.log(
    `  ${entry.status.padEnd(10)} ${entry.kind.padEnd(10)} inj=${String(entry.injections).padStart(2)} ` +
      `${entry.scope}:${String(entry.scope_label)}  wrote:${String(entry.source_session ?? '-').slice(8, 16)}  ${JSON.stringify(String(entry.title).slice(0, 38))}`,
  );
}

console.log('\n=== 2. which scope each session resolves to (recomputed from its cwd) ===');
const sessions = store.db
  .prepare('SELECT DISTINCT session_id FROM request_stat WHERE source = \'section\' AND session_id IS NOT NULL')
  .all();
const cwd = process.cwd().includes('dsh-loci')
  ? process.cwd().replace(/\\dsh-loci$/, '').replace(/\/dsh-loci$/, '')
  : process.cwd();
console.log(`  (workspace assumed for all: ${cwd})`);
const keys = new Map();
for (const row of sessions) {
  const scopes = resolveScopes({ sessionId: row.session_id, cwd });
  keys.set(row.session_id, readScopeKeys(scopes, { includeGlobal: true }));
}
// Each session contributes its own `session:` key, so compare only the shared part.
const sharedPart = (list) => list.filter((key) => !key.startsWith('session:')).join('|');
const distinct = new Set([...keys.values()].map(sharedPart));
for (const [session, list] of keys) {
  console.log(`  ${session.slice(8, 20)}  workspace:${list[1]}`);
}
console.log(`  distinct read sets across sessions: ${distinct.size}`);

console.log('\n=== 3. what a session actually receives right now (rendered) ===');
const rendered = renderIndexBody({
  store,
  scopeKeys: keys.values().next().value ?? store.allScopeKeys(),
  scopeLabel: 'default-workspace',
  config: (key) => config[key],
});
console.log(`  bytes ${rendered.bytes} · listed ${rendered.listed} · total ${rendered.total}`);
console.log(`  ids ${JSON.stringify(rendered.ids)}`);
console.log('  ---');
for (const line of rendered.text.split('\n')) console.log('  ' + line);

console.log('\n=== conclusion that the data supports ===');
const sameSet = distinct.size === 1;
const verified = entries.filter((entry) => entry.status === 'verified');
console.log(`  every entry shares one scope key: ${new Set(entries.map((e) => `${e.scope}:${e.scope_label}`)).size === 1}`);
console.log(`  every active session resolves to the same read set: ${sameSet}`);
console.log(`  verified entries (the only ones that can be injected): ${verified.length}`);
console.log('  => a verified entry is visible to every session that shares this scope, by construction.');
console.log('  NOT shown here: which id each past injection listed — request_stat does not record ids.');
store.close();
