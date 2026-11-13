/**
 * Child-process writer used by the concurrency and crash tests.
 *
 * Usage: node writer-child.mjs <memoryRoot> <workerId> <count> [--loop]
 * Prints one JSON line with the result, so the parent can assert on numbers
 * rather than scraping logs.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { ensureMemoryRoot, layout } from '../../src/host/paths.js';
import { resolveScopes } from '../../src/host/scope.js';
import { Store } from '../../src/host/store/store.js';

const [rootArg, workerArg, countArg, flag] = process.argv.slice(2);
const worker = Number(workerArg ?? '0');
const count = Number(countArg ?? '10');
const loop = flag === '--loop';
const root = ensureMemoryRoot(rootArg);
const paths = layout(root);
const scopes = resolveScopes({ sessionId: `session-worker-${worker}`, cwd: process.cwd() });
const store = new Store({
  memoryRoot: root,
  paths,
  config: effectiveConfig({ secretPolicy: 'redact' }),
  pluginVersion: '1.0.0',
});
const errors = [];
let written = 0;

try {
  if (loop) {
    for (let i = 0; ; i += 1) {
      store.write({
        scope: 'workspace',
        scopeKey: scopes.workspace,
        scopeLabel: scopes.labels.workspace,
        kind: 'semantic',
        trustSource: 'user',
        title: `worker ${worker} fact ${i}`,
        body: `第 ${i} 条并发写入，来自 worker ${worker}。`,
      });
      written += 1;
      if (i > 4 && i % 7 === 0) process.stdout.write('');
    }
  }
  for (let i = 0; i < count; i += 1) {
    try {
      store.write({
        scope: 'workspace',
        scopeKey: scopes.workspace,
        scopeLabel: scopes.labels.workspace,
        kind: 'semantic',
        trustSource: 'user',
        title: `worker ${worker} fact ${i}`,
        body: `第 ${i} 条并发写入，来自 worker ${worker}。`,
      });
      written += 1;
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }
  }
  const stats = store.stats();
  process.stdout.write(`${JSON.stringify({ worker, written, errors, heads: stats.heads })}\n`);
} finally {
  store.close();
}
