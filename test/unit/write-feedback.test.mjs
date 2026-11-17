import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFeedback } from '../../src/host/tools/write-feedback.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * Feedback rides on the write, because a model does not go looking for the health of its own memory.
 *
 * The rule this file enforces: every note must be something the store can compute *and* something the model
 * can act on in the same turn. A note it cannot act on is noise that costs bytes on every write.
 */

function seed(store, scopes, entry) {
  return store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', ...entry });
}

test('nothing is said when there is nothing to say', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, { kind: 'semantic', title: '一条普通的记忆', body: '正文。', applies: 'topic' });
  const notes = writeFeedback({ store, sessionId: 'session-quiet', scopeKeys: [scopes.workspace] });
  assert.deepEqual(notes, [], 'a healthy store produces no noise');
});

test('a session whose writes never reached a prompt is told so', (t) => {
  // A verified entry that was never injected usually means the scope is one this session does not read
  // from. Saying it is the difference between "I recorded that" and a silent no-op.
  const { store, scopes } = openTestStore(t);
  for (let i = 0; i < 4; i += 1) {
    store.write({
      ...workspaceFields(scopes),
      status: 'verified',
      trustSource: 'user',
      kind: 'semantic',
      applies: 'topic',
      title: `本会话写入的条目 ${i}`,
      body: '正文。',
      sourceSession: 'session-invisible',
    });
  }
  const notes = writeFeedback({ store, sessionId: 'session-invisible', scopeKeys: [scopes.workspace] });
  assert.equal(notes.length >= 1, true, 'at least one note is produced');
  assert.match(notes[0], /never been injected/);
  assert.match(notes[0], /scope/, 'and it points at the thing to check');
});

test('one or two invisible writes is not yet a signal', (t) => {
  // A topical entry that simply has not come up is normal. Only a pattern is worth a note.
  const { store, scopes } = openTestStore(t);
  store.write({
    ...workspaceFields(scopes),
    status: 'verified',
    trustSource: 'user',
    kind: 'semantic',
    applies: 'topic',
    title: '只有一条',
    body: '正文。',
    sourceSession: 'session-sparse',
  });
  const notes = writeFeedback({ store, sessionId: 'session-sparse', scopeKeys: [scopes.workspace] });
  assert.equal(notes.some((note) => /never been injected/.test(note)), false);
});

test('the review queue is reported, because candidates never reach the prompt', (t) => {
  const { store, scopes } = openTestStore(t);
  for (let i = 0; i < 2; i += 1) {
    store.write({
      ...workspaceFields(scopes),
      status: 'candidate',
      trustSource: 'user',
      kind: 'semantic',
      applies: 'topic',
      title: `待审条目 ${i}`,
      body: '正文。',
    });
  }
  const notes = writeFeedback({ store, scopeKeys: [scopes.workspace] });
  const pending = notes.find((note) => /waiting for review/.test(note));
  assert.ok(pending !== undefined, `expected a review note, got ${JSON.stringify(notes)}`);
  assert.match(pending, /^2 entries are/);
});

test('a store where most entries claim to be standing is warned about', (t) => {
  // This is the failure mode `docs/MEMORY-CONTRACT.md` §7 names: if `always` stops being rare, the core
  // fills up again and the column has bought nothing.
  const { store, scopes } = openTestStore(t);
  for (let i = 0; i < 12; i += 1) {
    seed(store, scopes, { kind: 'rule', applies: 'always', title: `常驻规则 ${i}`, body: '正文。' });
  }
  const notes = writeFeedback({ store, scopeKeys: [scopes.workspace] });
  const warning = notes.find((note) => /marked always/.test(note));
  assert.ok(warning !== undefined, `expected an always-ratio warning, got ${JSON.stringify(notes)}`);
  assert.match(warning, /12 of 12/);
});

test('a store with a healthy ratio says nothing about it', (t) => {
  const { store, scopes } = openTestStore(t);
  for (let i = 0; i < 12; i += 1) {
    seed(store, scopes, { kind: 'semantic', applies: 'topic', title: `话题条目 ${i}`, body: '正文。' });
  }
  seed(store, scopes, { kind: 'rule', applies: 'always', title: '唯一一条常驻规则', body: '正文。' });
  const notes = writeFeedback({ store, scopeKeys: [scopes.workspace] });
  assert.equal(notes.some((note) => /marked always/.test(note)), false, '1 of 13 is not a warning');
});

test('a broken store does not turn a diagnostic into a failed write', (t) => {
  // The real constraint: this runs inside the write path. Anything it does must be unable to break a write.
  const fakeStore = {
    db: {
      prepare() {
        throw new Error('database is on fire');
      },
    },
  };
  assert.deepEqual(writeFeedback({ store: fakeStore, sessionId: 's', scopeKeys: ['w'] }), []);
});
