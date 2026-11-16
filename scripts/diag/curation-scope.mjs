#!/usr/bin/env node
/** Why does the curated write not show up under the project scope key? */
import { DEFAULTS, effectiveConfig } from '../../src/host/config.js';
import { createCurationTrigger } from '../../src/host/record/trigger.js';
import { resolveScopes } from '../../src/host/scope.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMemoryRoot, layout } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const MESSAGES = [
  { seq: 0, role: 'user', text: '以后部署先走灰度。' },
  { seq: 1, role: 'assistant', text: '好，先灰度。' },
];

const home = mkdtempSync(join(tmpdir(), 'loci-dbg-'));
const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
const effective = effectiveConfig({ home });
const store = new Store({
  memoryRoot: root,
  paths: layout(root),
  config: effective,
  live: (key) => effective[key],
  quoteVerifier: (quote) => MESSAGES.some((message) => message.text.includes(quote)),
  pluginVersion: '4.2.0',
});

const config = (key) => ({ ...DEFAULTS, curatorMode: 'session-end', defaultScope: 'project' })[key];
const handler = createCurationTrigger({
  store,
  config,
  capture: { messagesOf: () => MESSAGES },
  callModel: async () =>
    JSON.stringify({
      keep: [{ kind: 'procedural', title: '部署先走灰度', body: '以后部署先走灰度。', evidenceQuote: '以后部署先走灰度。' }],
      drop: [],
    }),
  resolveScopes,
  log: { info: (line) => console.log('INFO', line), warn: (line) => console.log('WARN', line) },
  now: () => Date.now(),
});

const result = await handler({ session: { id: 'session-root', header: { delegationDepth: 0, cwd: process.cwd() } } });
console.log('result:', JSON.stringify(result));

const rows = store.db.prepare('SELECT id, scope, scope_key, scope_label, status FROM memory').all();
console.log('\nstored rows:');
for (const row of rows) console.log('  ', JSON.stringify(row));

const scopes = resolveScopes({ sessionId: 'session-root', cwd: process.cwd() });
console.log('\nresolved scopes:', JSON.stringify({ project: scopes.project, workspace: scopes.workspace, projectRootFound: scopes.projectRootFound }));
console.log('list(project):', store.list({ scopeKeys: [scopes.project] }).total);
console.log('list(workspace):', store.list({ scopeKeys: [scopes.workspace] }).total);
store.close();
rmSync(home, { recursive: true, force: true });
