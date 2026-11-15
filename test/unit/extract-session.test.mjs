import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../../src/host/config.js';
import { Extractor } from '../../src/host/extract/extractor.js';
import { openTestStore } from '../helpers.mjs';

/**
 * `'session'` mode exists because the two previous choices were both wrong for daily
 * use: deterministic rules miss anything stated in passing, and per-turn extraction
 * asks for one review decision per turn until the queue is abandoned. One digest at
 * the end of a session is a single sitting.
 */
const reader = (overrides = {}) => {
  const values = { ...DEFAULTS, ...overrides };
  return (key) => values[key];
};

const MESSAGES = [
  { role: 'user', text: '以后别急着改代码，先给我看 diff。' },
  { role: 'assistant', text: '明白。' },
  { role: 'user', text: '还有，写测试时不要用 sleep。' },
];

const completer = (answer) => {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    return answer;
  };
  fn.calls = calls;
  return fn;
};

const ANSWER = JSON.stringify([
  { title: '改代码前先给 diff', body: '先展示改动再落地。', kind: 'procedural', quote: '以后别急着改代码，先给我看 diff' },
  { title: '测试不要 sleep', body: '用等待条件代替固定睡眠。', kind: 'rule', quote: '写测试时不要用 sleep' },
]);

test('session mode is a real mode, and it has its own candidate cap', () => {
  assert.ok(DEFAULTS.extractMode === 'off', 'still off by default');
  assert.equal(DEFAULTS.extractSessionMaxCandidates, 5);
});

test('extraction is disabled unless the mode names it', async (t) => {
  const { store, scopes } = openTestStore(t);
  const extractor = new Extractor({ store, config: reader({ extractMode: 'off' }), complete: completer(ANSWER) });
  const result = await extractor.run({ mode: 'session', messages: MESSAGES, scopeKey: scopes.workspace, scopeLabel: 'x' });
  assert.equal(result.reason, 'disabled');
});

test('a session digest writes candidates and never verified entries', async (t) => {
  const { store, scopes } = openTestStore(t);
  const extractor = new Extractor({
    store,
    config: reader({ extractMode: 'session' }),
    complete: completer(ANSWER),
  });
  const result = await extractor.run({ mode: 'session', messages: MESSAGES, scopeKey: scopes.workspace, scopeLabel: 'here' });
  assert.equal(result.written, 2);
  const rows = store.db.prepare('SELECT status, trust_source FROM memory').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === 'candidate'), 'a proposal is not testimony');
  assert.ok(rows.every((row) => row.trust_source === 'summary'));
  assert.equal(store.indexEntries({ scopeKeys: [scopes.workspace] }).length, 0, 'nothing reaches the prompt');
});

test('the session cap is applied instead of the per-turn cap', async (t) => {
  const { store, scopes } = openTestStore(t);
  const many = JSON.stringify(
    Array.from({ length: 12 }, (_, index) => ({
      title: `条目 ${index}`,
      body: `正文 ${index}`,
      kind: 'semantic',
      quote: index === 0 ? '以后别急着改代码，先给我看 diff' : '写测试时不要用 sleep',
    })),
  );
  const extractor = new Extractor({
    store,
    config: reader({ extractMode: 'session', extractMaxCandidates: 3, extractSessionMaxCandidates: 5 }),
    complete: completer(many),
  });
  const result = await extractor.run({ mode: 'session', messages: MESSAGES, scopeKey: scopes.workspace, scopeLabel: 'x' });
  assert.equal(result.written, 5, 'a digest proposes at most extractSessionMaxCandidates');
});

test('the frame is still the same in turn mode', async (t) => {
  const { store, scopes } = openTestStore(t);
  const extractor = new Extractor({
    store,
    config: reader({ extractMode: 'turn', extractMaxCandidates: 3, extractSessionMaxCandidates: 5 }),
    complete: completer(ANSWER),
  });
  const result = await extractor.run({ mode: 'turn', messages: MESSAGES, scopeKey: scopes.workspace, scopeLabel: 'x' });
  assert.equal(result.written, 2);
});
