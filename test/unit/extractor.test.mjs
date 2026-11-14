import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../../src/host/config.js';
import { Extractor, completeViaHost, parseExtraction, renderTranscript } from '../../src/host/extract/extractor.js';
import { openTestStore } from '../helpers.mjs';

/** A config reader over the shipped defaults, with overrides. */
function configReader(overrides = {}) {
  const values = { ...DEFAULTS, ...overrides };
  return (key) => values[key];
}

const MESSAGES = [
  { role: 'user', text: '以后别急着改代码，先给我看 diff。' },
  { role: 'assistant', text: '明白。' },
  { role: 'user', text: '还有，写测试时不要用 sleep。' },
];

/** A completer that returns a fixed answer and counts calls. */
function fakeCompleter(answer) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    return answer;
  };
  fn.calls = calls;
  return fn;
}

test('the extractor is off unless it is switched on', async (t) => {
  const { store, scopes } = openTestStore(t);
  const extractor = new Extractor({ store, config: configReader(), complete: fakeCompleter('[]') });
  assert.equal(extractor.enabled(), false);
  const result = await extractor.run({ messages: MESSAGES, scopeKey: scopes.workspace, scopeLabel: 'x' });
  assert.equal(result.reason, 'disabled');
  assert.equal(store.stats().heads, 0);
});

test('with no model route it reports no-model and writes nothing', async (t) => {
  const { store, scopes } = openTestStore(t);
  const extractor = new Extractor({ store, config: configReader({ extractMode: 'on' }), complete: undefined });
  const result = await extractor.run({ messages: MESSAGES, scopeKey: scopes.workspace, scopeLabel: 'x' });
  assert.equal(result.reason, 'no-model');
  assert.equal(store.stats().heads, 0);
});

test('a grounded extraction lands as candidates, never as verified', async (t) => {
  const { store, scopes } = openTestStore(t);
  const answer = JSON.stringify([
    {
      title: '改代码前先给 diff',
      body: '用户希望先看改动再落地。',
      kind: 'procedural',
      quote: '以后别急着改代码，先给我看 diff',
    },
  ]);
  const extractor = new Extractor({ store, config: configReader({ extractMode: 'on' }), complete: fakeCompleter(answer) });
  const result = await extractor.run({ messages: MESSAGES, scopeKey: scopes.workspace, scopeLabel: 'here' });

  assert.equal(result.written, 1);
  const row = store.db.prepare('SELECT status, trust_source, title FROM memory').get();
  assert.equal(row.status, 'candidate', 'an extracted preference is a proposal, not testimony');
  assert.equal(row.trust_source, 'summary');
  assert.equal(store.indexEntries({ scopeKeys: [scopes.workspace] }).length, 0, 'nothing reaches the prompt');
});

test('an invented quote is dropped before it is stored', async (t) => {
  const { store, scopes } = openTestStore(t);
  const answer = JSON.stringify([
    { title: '编的', body: '这条引文不在对话里。', kind: 'rule', quote: '用户从未说过这句话' },
    { title: '真的', body: '这条引文对得上。', kind: 'semantic', quote: '写测试时不要用 sleep' },
  ]);
  const extractor = new Extractor({ store, config: configReader({ extractMode: 'on' }), complete: fakeCompleter(answer) });
  const result = await extractor.run({ messages: MESSAGES, scopeKey: scopes.workspace, scopeLabel: 'here' });
  assert.equal(result.written, 1);
  assert.equal(store.db.prepare('SELECT title FROM memory').get().title, '真的');
});

test('the hourly budget stops calls instead of running every turn', async (t) => {
  const { store, scopes } = openTestStore(t);
  const complete = fakeCompleter('[]');
  const extractor = new Extractor({
    store,
    config: configReader({ extractMode: 'on', extractMaxCallsPerHour: 2 }),
    complete,
  });
  for (let i = 0; i < 4; i += 1) {
    await extractor.run({ messages: MESSAGES, scopeKey: scopes.workspace, scopeLabel: 'x' });
  }
  assert.equal(complete.calls.length, 2, 'only the budgeted calls reach the model');
});

test('a model failure is reported, not thrown', async (t) => {
  const { store, scopes } = openTestStore(t);
  const extractor = new Extractor({
    store,
    config: configReader({ extractMode: 'on' }),
    complete: async () => {
      throw new Error('provider exploded');
    },
  });
  const result = await extractor.run({ messages: MESSAGES, scopeKey: scopes.workspace, scopeLabel: 'x' });
  assert.equal(result.reason, 'model-error');
  assert.equal(result.written, 0);
});

test('a slow model hits the timeout instead of holding the turn', async (t) => {
  const { store, scopes } = openTestStore(t);
  const extractor = new Extractor({
    store,
    config: configReader({ extractMode: 'on', extractTimeoutMs: 1000 }),
    complete: () => new Promise((resolve) => setTimeout(() => resolve('[]'), 5000)),
  });
  const result = await extractor.run({ messages: MESSAGES, scopeKey: scopes.workspace, scopeLabel: 'x' });
  assert.equal(result.reason, 'model-error');
});

test('an unusable answer is treated as nothing, not as garbage input', () => {
  assert.deepEqual(parseExtraction('I cannot help with that'), []);
  assert.deepEqual(parseExtraction('{}'), []);
  assert.deepEqual(parseExtraction('[{"title":"x"}]'), [], 'an item without a quote is dropped');
  const fenced = parseExtraction(
    'Here you go:\n```json\n[{"title":"t","body":"b","kind":"rule","quote":"这句引文来自用户的原始消息"}]\n```',
  );
  assert.equal(fenced.length, 1, 'a fenced array is still read');
});

test('the transcript is bounded and drops tool noise', () => {
  const long = Array.from({ length: 60 }, (_, i) => ({ role: 'user', text: `第 ${i} 条消息` }));
  const rendered = renderTranscript(long);
  assert.ok(rendered.length <= 12_000);
  assert.equal(rendered.includes('第 0 条消息'), false, 'the oldest messages fall out of the window');
  const withTool = renderTranscript([
    { role: 'tool', text: 'grep output' },
    { role: 'user', text: '用户说的话' },
  ]);
  assert.equal(withTool.includes('grep output'), false);
});

test('the host adapter joins text from the frames it understands', async () => {
  const llm = {
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: '[]' };
      },
    }),
  };
  const complete = completeViaHost(llm, { provider: 'p', model: 'm' });
  assert.equal(await complete({ system: 's', prompt: 'p' }), '[]');
  assert.equal(completeViaHost(undefined, {}), undefined, 'no service means no completer');
});
