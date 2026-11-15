#!/usr/bin/env node
/** Exercise the /scope endpoints through the real route handlers. */
import { effectiveConfig } from '../../src/host/config.js';
import { registerApiRoutes } from '../../src/host/api/routes.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const paths = layout(root);
const config = effectiveConfig({});
const store = new Store({ memoryRoot: root, paths, config, pluginVersion: '3.8.0' });

const routes = new Map();
const ctx = {
  get: (name) =>
    name === 'connection'
      ? { fetch: { register: ({ path, fetch }) => (routes.set(path, fetch), () => routes.delete(path)) } }
      : undefined,
};
registerApiRoutes(ctx, { store, paths, config, log: undefined, updates: undefined, version: '3.8.0' });

async function call(path, init) {
  const [base] = path.split('?');
  const handler = routes.get(base);
  if (handler === undefined) return { status: 404, body: { error: 'no route' } };
  const response = await handler(new Request('http://local' + path, init));
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? {} : JSON.parse(text) };
}

const show = (label, result) => {
  console.log(`\n${label}  ->  HTTP ${result.status}`);
  console.log('  ' + JSON.stringify(result.body, null, 0).slice(0, 320));
};

show('GET /scope', await call('/api/loci/scope'));

// A write recorded without a cwd, which is what rows created before v5 look like.
store.recordInjection({
  sessionId: 'session-scope-demo',
  scopeKey: 'workspace:d9d179cbb41093ed',
  cwd: 'E:/__VIVE__/Documents/deepseek-harness/default-workspace',
  bytes: 12,
  listed: 1,
  hidden: 0,
  ts: Date.now(),
});
show('GET /scope after a recorded cwd', await call('/api/loci/scope'));

show(
  'POST /scope {mode: workspace}',
  await call('/api/loci/scope', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'workspace' }),
  }),
);
console.log(`  stored for session-scope-demo: ${store.getSessionScope('session-scope-demo')}`);

show(
  'POST /scope {mode: nonsense}',
  await call('/api/loci/scope', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'nonsense' }),
  }),
);

show(
  'POST /scope {mode: auto}',
  await call('/api/loci/scope', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'auto' }),
  }),
);
console.log(`  stored after auto: ${store.getSessionScope('session-scope-demo')} (undefined = cleared)`);

// Clean up the demo choice so the live database is not left with a test row.
store.setSessionScope('session-scope-demo', 'auto');
store.close();
