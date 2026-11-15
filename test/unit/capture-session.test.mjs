import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Capture } from '../../src/host/capture/capture.js';
import { DEFAULTS } from '../../src/host/config.js';
import { openTestStore } from '../helpers.mjs';

/**
 * The capture side of `'session'` mode: exactly one digest, when the session ends,
 * and none per turn. This is the wiring that makes the mode real rather than a
 * config value nobody reads.
 */
function makeCapture(store, overrides, extractor) {
  const values = { ...DEFAULTS, summaryOnDispose: false, ...overrides };
  return new Capture({
    store,
    config: (key) => values[key],
    resolveScopes: () => ({ workspace: 'workspace:test', labels: { workspace: 'test' } }),
    extractor,
    now: () => 1_700_000_000_000,
  });
}

function fakeExtractor() {
  const runs = [];
  return {
    runs,
    run: async (request) => {
      runs.push(request);
      return { written: 1, reason: 'written', ids: ['m_x'] };
    },
  };
}

function seed(capture, sessionId) {
  capture.sessions.set(sessionId, {
    messages: [
      { seq: 1, role: 'user', text: '第一条用户消息，足够长以便参与判断。' },
      { seq: 2, role: 'assistant', text: '好的。' },
      { seq: 3, role: 'user', text: '第二条用户消息，也足够长。' },
      { seq: 4, role: 'assistant', text: '明白。' },
    ],
    bytes: 120,
    captures: 0,
    turn: 1,
    cwd: 'C:/work/project',
    timer: undefined,
    extractTimer: undefined,
  });
}

test('session mode runs one digest at the end of the session, with mode "session"', async (t) => {
  const { store } = openTestStore(t);
  const extractor = fakeExtractor();
  const capture = makeCapture(store, { extractMode: 'session' }, extractor);
  seed(capture, 'session-a');

  assert.equal(extractor.runs.length, 0, 'nothing runs while the session is live');
  capture.summarize('session-a', 'dispose');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(extractor.runs.length, 1);
  assert.equal(extractor.runs[0].mode, 'session');
  assert.equal(extractor.runs[0].sessionId, 'session-a');
  assert.ok(extractor.runs[0].messages.length >= 4, 'the digest reads the whole buffered conversation');
});

test('turn modes do not run a digest on dispose', async (t) => {
  const { store } = openTestStore(t);
  const extractor = fakeExtractor();
  const capture = makeCapture(store, { extractMode: 'turn' }, extractor);
  seed(capture, 'session-b');
  capture.summarize('session-b', 'dispose');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(extractor.runs.length, 0);
});

test('session mode keeps the digest even when episodic summaries are off', async (t) => {
  const { store } = openTestStore(t);
  const extractor = fakeExtractor();
  // summaryOnDispose is false in makeCapture's defaults, so this is the case that
  // would silently do nothing if the digest were nested inside the summary path.
  const capture = makeCapture(store, { extractMode: 'session', summaryOnDispose: false }, extractor);
  seed(capture, 'session-c');
  capture.summarize('session-c', 'dispose');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(extractor.runs.length, 1);
});

test('a failing extractor cannot break the session release', async (t) => {
  const { store } = openTestStore(t);
  const capture = makeCapture(
    store,
    { extractMode: 'session' },
    {
      run: async () => {
        throw new Error('model exploded');
      },
    },
  );
  seed(capture, 'session-d');
  assert.doesNotThrow(() => capture.summarize('session-d', 'dispose'));
  await new Promise((resolve) => setTimeout(resolve, 10));
});
