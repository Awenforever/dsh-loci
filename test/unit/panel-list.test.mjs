import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { renderIndexBody } from '../../src/host/inject/index-section.js';
import { registerApiRoutes } from '../../src/host/api/routes.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * Two silent-wrongness bugs found by an independent audit, both of the same shape: a
 * query parameter nobody read and a filter nobody applied. Neither threw, neither failed
 * a test, and both made the product say something untrue.
 */
function mount(store, config = effectiveConfig({})) {
  const routes = new Map();
  const ctx = {
    get: (name) =>
      name === 'connection'
        ? { fetch: { register: ({ path, fetch }) => (routes.set(path, fetch), () => routes.delete(path)) } }
        : undefined,
  };
  registerApiRoutes(ctx, { store, paths: {}, config, log: undefined, updates: undefined, version: '2.5.0' });
  const get = async (path, query) => {
    const handler = routes.get(path);
    assert.ok(handler, `${path} must be mounted`);
    const response = await handler(new Request(`http://local${path}?${query}`));
    return { status: response.status, body: await response.json() };
  };
  return { get };
}

test('the list route honours `kinds` as well as `kind`', async (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), kind: 'rule', trustSource: 'user', title: '一条规则', body: '正文。' });
  store.write({ ...workspaceFields(scopes), kind: 'episodic', trustSource: 'summary', title: '一次会话摘要', body: '历史。' });
  const { get } = mount(store);

  // The panel sends `kinds=`; before the fix the route read only `kind=`, so the
  // filter was ignored and session summaries filled a queue designed to exclude them.
  const plural = await get('/api/loci/list', 'status=any&kinds=rule,semantic,procedural');
  const singular = await get('/api/loci/list', 'status=any&kind=rule,semantic,procedural');

  assert.equal(plural.body.total, 1, 'the plural spelling must filter');
  assert.equal(singular.body.total, 1, 'the singular spelling keeps working');
  assert.equal(plural.body.items[0].kind, 'rule');
});

test('an expired candidate stops being counted as pending', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'tool',
    title: '已经过期的候选',
    body: '维护流程把它的 valid_to 关掉了。',
    validTo: Date.now() - 1000,
  });
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'tool', title: '仍在待审的候选', body: '正文。' });

  // `countPending` ignored `valid_to`, so the injected notice counted rows that no
  // review list would ever show — a nag that could not reach zero.
  assert.equal(store.countPending([scopes.workspace]), 1, 'only the live candidate counts');

  const rendered = renderIndexBody({
    store,
    scopeKeys: [scopes.workspace],
    scopeLabel: scopes.labels.workspace,
    config: (key) => effectiveConfig({})[key],
  });
  assert.match(rendered.text, /1 item\(s\) await review/);
});

test('a store whose candidates all expired goes back to zero injected bytes', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'tool',
    title: '唯一的候选',
    body: '正文。',
    validTo: Date.now() - 1000,
  });
  const rendered = renderIndexBody({
    store,
    scopeKeys: [scopes.workspace],
    scopeLabel: scopes.labels.workspace,
    config: (key) => effectiveConfig({})[key],
  });
  // This is the property the notice was supposed to preserve: when nothing is waiting,
  // say nothing. Before the fix the notice outlived the queue forever.
  assert.equal(rendered.text, '');
  assert.equal(rendered.bytes, 0);
});
