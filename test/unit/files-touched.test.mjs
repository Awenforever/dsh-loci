import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Capture } from '../../src/host/capture/capture.js';
import { DEFAULTS } from '../../src/host/config.js';
import { openTestStore } from '../helpers.mjs';

/**
 * "Where were we last time" is a real question this session had to answer by hand.
 * The episodic summary is history — it is never injected — so recording the touched
 * files there costs the prompt nothing and only helps `loci_search`.
 */
function makeCapture(store) {
  return new Capture({
    store,
    config: (key) => ({ ...DEFAULTS, summaryOnDispose: true })[key],
    resolveScopes: () => ({ workspace: 'workspace:test', labels: { workspace: 'test' } }),
    now: () => 1_700_000_000_000,
  });
}

/** A root session stub: capture only records the root agent's events. */
function rootSession(id = 'session-a4') {
  return { id, header: { origin: 'user', delegationDepth: 0, cwd: 'C:/work/project' } };
}

function feed(capture, session, events) {
  for (const event of events) capture.onSessionEvent(session, event);
}

const userTurn = (seq, text) => ({ type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
const assistantTurn = (seq, text) => ({ type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } });

test('tool calls contribute the paths they touched, deduplicated', (t) => {
  const { store } = openTestStore(t);
  const capture = makeCapture(store);
  const session = rootSession();
  feed(capture, session, [
    userTurn(1, '帮我改一下 store 和 client'),
    assistantTurn(2, '好。'),
    { type: 'tool/call', seq: 3, data: { name: 'edit', arguments: JSON.stringify({ file_path: 'src/host/store/store.js' }) } },
    { type: 'tool/call', seq: 4, data: { name: 'edit', arguments: JSON.stringify({ file_path: 'src/host/store/store.js' }) } },
    { type: 'tool/call', seq: 5, data: { name: 'read', arguments: JSON.stringify({ path: 'client.js' }) } },
  ]);
  const buffer = capture.sessions.get('session-a4');
  assert.deepEqual(buffer.files, ['src/host/store/store.js', 'client.js'], 'a file touched twice is listed once');
});

test('a glob loses its pattern but keeps a usable directory', (t) => {
  const { store } = openTestStore(t);
  const capture = makeCapture(store);
  const session = rootSession();
  feed(capture, session, [
    userTurn(1, '看看测试'),
    assistantTurn(2, '好。'),
    { type: 'tool/call', seq: 3, data: { name: 'glob', arguments: JSON.stringify({ pattern: 'test/unit/*.test.mjs' }) } },
  ]);
  const buffer = capture.sessions.get('session-a4');
  assert.deepEqual(buffer.files, ['test/unit']);
});

test('a sentence in an argument is not mistaken for a path', (t) => {
  const { store } = openTestStore(t);
  const capture = makeCapture(store);
  const session = rootSession();
  feed(capture, session, [
    userTurn(1, '跑个命令'),
    assistantTurn(2, '好。'),
    { type: 'tool/call', seq: 3, data: { name: 'pwsh', arguments: JSON.stringify({ command: 'echo hi', description: 'print greeting' }) } },
  ]);
  const buffer = capture.sessions.get('session-a4');
  assert.deepEqual(buffer.files, []);
});

test('the touched files land in the episodic summary', async (t) => {
  const { store } = openTestStore(t);
  const capture = makeCapture(store);
  const session = rootSession('session-a4-summary');
  feed(capture, session, [
    userTurn(1, '改一下 store 的实现，然后跑测试'),
    assistantTurn(2, '好，我改完了。'),
    { type: 'tool/call', seq: 3, data: { name: 'edit', arguments: JSON.stringify({ file_path: 'src/host/store/store.js' }) } },
  ]);
  capture.summarize('session-a4-summary', 'dispose');
  const rows = store.db.prepare("SELECT kind, body FROM memory WHERE kind = 'episodic'").all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /Files touched this session:/);
  assert.match(rows[0].body, /src\/host\/store\/store\.js/);
});

test('an episodic entry with files is still never injected', async (t) => {
  const { store, scopes } = openTestStore(t);
  const capture = makeCapture(store);
  const session = rootSession('session-a4-inject');
  feed(capture, session, [
    userTurn(1, '改一下 store 的实现，然后跑测试'),
    assistantTurn(2, '好，我改完了。'),
    { type: 'tool/call', seq: 3, data: { name: 'edit', arguments: JSON.stringify({ file_path: 'src/host/store/store.js' }) } },
  ]);
  capture.summarize('session-a4-inject', 'dispose');
  assert.equal(store.indexEntries({ scopeKeys: [scopes.workspace] }).length, 0, 'history is not a claim');
});
