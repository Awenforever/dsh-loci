import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../../src/host/config.js';
import { createTools } from '../../src/host/tools/tools.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/** Build the tools against a real store. */
function tools(t) {
  const harness = openTestStore(t);
  const defs = createTools({
    store: harness.store,
    config: (key) => DEFAULTS[key],
    log: undefined,
    capture: { lastUserSeq: () => undefined, verifyQuote: () => false },
  });
  const byName = new Map(defs.map((definition) => [definition.name, definition]));
  const exec = {
    agent: { session: { id: 'session-tools', header: { cwd: harness.home } } },
    signal: { aborted: false },
  };
  const call = async (name, args) => byName.get(name).execute(args, exec);
  return { ...harness, defs, byName, call };
}

/** The text a tool result renders to. */
function text(def, args, value) {
  return def.output.render(args, value).map((block) => block.text).join('\n');
}

test('every tool declares a legal parameter schema', (t) => {
  const { defs } = tools(t);
  for (const definition of defs) {
    const required = definition.parameters.required ?? [];
    const properties = Object.keys(definition.parameters.properties ?? {});
    for (const name of required) assert.ok(properties.includes(name), `${definition.name}.${name} is required but undeclared`);
    assert.equal(definition.parameters.type, 'object', `${definition.name} must take an object`);
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 40, `${definition.name} needs a real description`);
  }
});

test('loci_search with no query lists what is remembered', async (t) => {
  const { call, byName, store, scopes } = tools(t);
  for (let i = 0; i < 4; i += 1) {
    store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: `事实 ${i}`, body: `第 ${i} 条正文。` });
  }
  const value = await call('loci_search', { limit: 3 });
  assert.equal(value.total, 4);
  assert.equal(value.returned, 3);
  assert.equal(value.hasMore, true);
  assert.deepEqual(value.channels, ['recent']);
  const rendered = text(byName.get('loci_search'), { limit: 3 }, value);
  assert.match(rendered, /total=4/);
  assert.ok(!rendered.includes('No relevant memory found'));
});

test('an empty search says so instead of looking like an error', async (t) => {
  const { call, byName, store, scopes } = tools(t);
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: '发布顺序', body: 'staging → canary → 全量。' });
  const value = await call('loci_search', { query: '数据库迁移回滚' });
  const rendered = text(byName.get('loci_search'), {}, value);
  assert.match(rendered, /No relevant memory found/);
  assert.equal(rendered.includes('search failed'), false, 'an empty result is not a failure');
});

test('a bounded window is disclosed, never presented as the whole answer', async (t) => {
  const { byName } = tools(t);
  const def = byName.get('loci_search');
  // A full page of real hits, but the ranking only covered a window.
  const withHits = {
    total: 400,
    matchedTotal: null,
    partial: true,
    returned: 10,
    limit: 10,
    hasMore: true,
    cursor: 'c1',
    channels: ['lexical'],
    tookMs: 5,
    hits: [
      {
        id: 'm_01ABC',
        kind: 'semantic',
        title: '一条命中',
        validFrom: Date.now(),
        channels: ['lexical'],
        snippet: '正文',
      },
    ],
  };
  const rendered = text(def, {}, withHits);
  assert.match(rendered, /more than 10 entries match/);
  assert.match(rendered, /narrow the query/);

  // An empty page that still claims a total must not read as "nothing found".
  const emptyPage = { ...withHits, hits: [], returned: 0 };
  const emptyRendered = text(def, {}, emptyPage);
  assert.match(emptyRendered, /400 entries match/);
  assert.equal(emptyRendered.includes('No relevant memory found'), false);
});

test('a missing id is explained, not just "not found"', (t) => {
  const { byName } = tools(t);
  const rendered = text(byName.get('loci_get'), { id: 'm_01ABC' }, { entry: undefined });
  assert.match(rendered, /No memory with that id/);
  assert.match(rendered, /loci_search/);
});

test('a candidate is crowned only with a verbatim quote the session confirms', async (t) => {
  // The store owns the gate; the tool never decides trust on its own.
  const harness = openTestStore(t, {}, { quoteVerifier: (quote) => quote.includes('以后都') });
  const defs = createTools({
    store: harness.store,
    config: (key) => DEFAULTS[key],
    log: undefined,
    capture: { lastUserSeq: () => 42 },
  });
  const write = defs.find((definition) => definition.name === 'loci_write');
  const exec = { agent: { session: { id: 'session-quote', header: { cwd: harness.home } } } };
  const withQuote = await write.execute(
    {
      title: '以后都用中文回答',
      body: '用户要求以后都用中文回答。',
      evidenceQuote: '以后都用中文回答',
      kind: 'rule',
    },
    exec,
  );
  assert.equal(withQuote.entry.status, 'verified');
  const withoutQuote = await write.execute(
    { title: '模型自己猜的偏好', body: '这条没有任何逐字证据。', kind: 'semantic' },
    exec,
  );
  assert.equal(withoutQuote.entry.status, 'candidate');
});
