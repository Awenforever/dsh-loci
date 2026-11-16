import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../../src/host/config.js';
import { createCurationTrigger } from '../../src/host/record/trigger.js';
import { resolveScopes } from '../../src/host/scope.js';
import { openTestStore } from '../helpers.mjs';

/**
 * When the curation pass runs, and when it must not.
 *
 * The rules that matter here are the boundaries, not the judgement: disposition happens while the
 * process is shutting down and nobody is left to catch an exception, so this handler has to be
 * unable to fail loudly, unable to run twice, and unable to treat a delegated step as testimony.
 */

const MESSAGES = [
  { seq: 0, role: 'user', text: '以后部署先走灰度。' },
  { seq: 1, role: 'assistant', text: '好，先灰度。' },
];

function makeTrigger(store, overrides = {}) {
  const config = (key) => ({ ...DEFAULTS, ...overrides })[key];
  const logs = [];
  return {
    logs,
    handler: createCurationTrigger({
      store,
      config,
      capture: { messagesOf: () => MESSAGES },
      callModel: async () =>
        JSON.stringify({
          keep: [{ kind: 'procedural', title: '部署先走灰度', body: '以后部署先走灰度。', evidenceQuote: '以后部署先走灰度。' }],
          drop: [],
        }),
      resolveScopes,
      log: { info: (line) => logs.push(['info', line]), warn: (line) => logs.push(['warn', line]) },
      now: () => Date.now(),
    }),
  };
}

const rootAgent = (id = 'session-root') => ({ session: { id, header: { delegationDepth: 0, cwd: process.cwd() } } });

test('off by default: the extractor stays the only writer', async (t) => {
  const { store } = openTestStore(t);
  const { handler } = makeTrigger(store);
  const result = await handler(rootAgent());
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'off');
});

test('a root conversation is curated when enabled', async (t) => {
  const { store, scopes, home } = openTestStore(t, {}, {
    quoteVerifier: (quote) => MESSAGES.some((message) => message.text.includes(quote)),
  });
  const { handler } = makeTrigger(store, { curatorMode: 'session-end', defaultScope: 'project' });
  // The session's cwd has to be the same directory the store's scopes were resolved against,
  // otherwise the write lands under a key the assertion is not looking at — which is what the
  // first version of this test did, and it read as "curation wrote nothing".
  const result = await handler({
    session: { id: 'session-root', header: { delegationDepth: 0, cwd: home } },
  });
  assert.equal(result.ran, true, JSON.stringify(result));
  assert.equal(result.written.length, 1);
  assert.ok(store.list({ scopeKeys: [scopes.project] }).total >= 1, 'it lands in the effective write scope');
});

test('a delegated step is not testimony', async (t) => {
  const { store } = openTestStore(t);
  const { handler } = makeTrigger(store, { curatorMode: 'session-end' });
  const delegated = await handler({ session: { id: 's-sub', header: { delegationDepth: 1, cwd: process.cwd() } } });
  assert.equal(delegated.ran, false);
  assert.match(delegated.reason, /root conversation/);
  const subagent = await handler({ session: { id: 's-sub2', header: { origin: 'subagent', cwd: process.cwd() } } });
  assert.equal(subagent.ran, false);
});

test('nothing to read means no model call is spent', async (t) => {
  const { store } = openTestStore(t);
  let called = 0;
  const config = (key) => ({ ...DEFAULTS, curatorMode: 'session-end' })[key];
  const handler = createCurationTrigger({
    store,
    config,
    capture: { messagesOf: () => [] },
    callModel: async () => {
      called += 1;
      return '{}';
    },
    resolveScopes,
    log: undefined,
    now: () => Date.now(),
  });
  const result = await handler(rootAgent());
  assert.equal(result.ran, false);
  assert.equal(called, 0, 'an empty conversation must not cost a model call');
});

test('a model failure during disposal is logged, never thrown', async (t) => {
  const { store } = openTestStore(t);
  const config = (key) => ({ ...DEFAULTS, curatorMode: 'session-end' })[key];
  const logs = [];
  const handler = createCurationTrigger({
    store,
    config,
    capture: { messagesOf: () => MESSAGES },
    callModel: async () => {
      throw new Error('provider down');
    },
    resolveScopes,
    log: { info: () => {}, warn: (line) => logs.push(line) },
    now: () => Date.now(),
  });
  const result = await handler(rootAgent());
  assert.equal(result.ran, false);
  assert.match(result.reason, /provider down/);
  assert.ok(logs.some((line) => line.includes('provider down')), 'the operator can find out why');
});

test('a missing session is refused rather than guessed', async (t) => {
  const { store } = openTestStore(t);
  const { handler } = makeTrigger(store, { curatorMode: 'session-end' });
  const result = await handler({});
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'no session');
});

test('a conversation with nothing but chatter spends no model call', async (t) => {
  const { store } = openTestStore(t);
  let called = 0;
  const config = (key) => ({ ...DEFAULTS, curatorMode: 'session-end' })[key];
  const handler = createCurationTrigger({
    store,
    config,
    capture: { messagesOf: () => [{ seq: 0, role: 'user', text: '嗯。' }] },
    callModel: async () => {
      called += 1;
      return '{}';
    },
    resolveScopes,
    log: undefined,
    now: () => Date.now(),
  });
  const result = await handler(rootAgent());
  assert.equal(result.ran, false);
  assert.equal(called, 0);
});
