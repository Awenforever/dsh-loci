#!/usr/bin/env node
/**
 * End-to-end proof on the live database: a conversation-scoped memory written now is visible in
 * that same conversation's next assembly, with no approval step.
 *
 * This is the loop the product exists for, and the one that was broken: before the layer model a
 * memory like this landed as `candidate`, could never be reviewed (session-scoped writes are not
 * in the reviewable set), and therefore never reached a prompt. The probe writes through the real
 * store path, renders the real section, and then removes what it wrote.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { composeRecall } from '../../src/host/recall/compose.js';
import { resolveScopes, readScopeKeys } from '../../src/host/scope.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const config = effectiveConfig({});
const store = new Store({ memoryRoot: root, paths: layout(root), config, pluginVersion: '4.3.0' });

const active = store.activeSession();
const sessionId = active?.sessionId ?? 'session-probe';
const scopes = resolveScopes({ sessionId, cwd: active?.cwd });

console.log(`session            ${sessionId}`);
console.log(`write target       session:${sessionId.slice(0, 12)}…  (conversation layer)`);

const marker = `probe-${Date.now().toString(36)}`;
const title = `回路验证 ${marker}：回滚窗口是四十五分钟`;

let entry;
try {
  const result = store.write({
    kind: 'procedural',
    scope: 'session',
    scopeKey: scopes.session,
    scopeLabel: scopes.labels.session,
    title,
    body: `${title}。这条是端到端验证写入，验证后即删除。`,
    trustSource: 'tool',
  });
  entry = result?.entry;
  console.log(`written            ${entry?.id} status=${entry?.status}`);
  if (entry?.status !== 'verified') {
    console.log('FAIL: a conversation-scoped write was not trusted, so it could never be injected');
    process.exitCode = 1;
  }

  // The read set a real assembly would use for this session.
  const keys = readScopeKeys(scopes, { includeGlobal: config.includeGlobal !== false });
  const composed = composeRecall({
    store,
    scopeKeys: keys,
    scopeLabel: 'conversation',
    query: '回滚窗口多久？',
  });
  const present = composed.text.includes(marker);
  console.log(`section bytes      ${composed.bytes}`);
  console.log(`entry in section   ${present}`);
  if (!present) {
    console.log('FAIL: the write did not reach the next assembly');
    process.exitCode = 1;
  }
  console.log('\n--- what the model would receive ---');
  console.log(composed.text.split('\n').slice(2, -2).join('\n'));
} finally {
  if (entry?.id !== undefined) {
    // Soft delete: the audit trail is the point, and hard delete is disabled by default — which
    // is the correct default for a store whose whole value is being able to say what happened.
    store.forget(entry.id, { mode: 'soft', reason: 'end-to-end loop probe' });
    const after = store.get(entry.id)?.entry;
    console.log(`\ncleanup            ${entry.id} → status ${after?.status ?? 'gone'}`);
  }
  store.close();
}
