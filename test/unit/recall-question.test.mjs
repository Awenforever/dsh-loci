import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastSliceOf, recordLastSlice, resetSliceNotes } from '../../src/host/recall/compose.js';
import { resetRescueGuard, rescueMiss } from '../../src/host/recall/rescue.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * The question the section searches with.
 *
 * Observed in real use: the first live rescue after 4.5.1 came back `recall-rewrite-skip` with reason
 * `query too short`. The whole chain worked — note written, waterfall read it, rescue decided to
 * rewrite — and then it was handed an empty string, because the question came from `capture`, which
 * deliberately ignores messages whose `source.kind` is not `user`.
 *
 * That filter is correct for durable extraction and wrong for retrieval: a turn opened by a
 * harness-injected message still has a question worth searching for. The two surfaces need two
 * filters, and one had borrowed the other's.
 *
 * These tests pin the consequence rather than the wiring: a rescue must never be handed nothing,
 * and the skip must say which of the two failures happened.
 */

function seed(store, scopes, entries) {
  for (const entry of entries) {
    store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', ...entry });
  }
}

test('an empty question is refused before the model is called', async (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'semantic', title: 'atlas 服务上线先走灰度', body: '先灰度。' }]);
  resetRescueGuard();
  resetSliceNotes();
  recordLastSlice('session-empty-query', { tier: 'none', query: '', ids: [] });
  let calls = 0;
  const result = await rescueMiss({
    store,
    sessionId: 'session-empty-query',
    scopeKeys: [scopes.workspace],
    complete: async () => {
      calls += 1;
      return '["atlas 上线先走灰度"]';
    },
  });
  assert.equal(result.rescued, false);
  assert.equal(calls, 0, 'an empty question must not cost a model call');
  assert.match(result.error, /too short/);
});

test('a real question is what reaches the rewriter', async (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'semantic', title: 'atlas 服务上线先走灰度', body: '先灰度。' }]);
  resetRescueGuard();
  resetSliceNotes();
  recordLastSlice('session-real-query', { tier: 'none', query: 'atlas 要发新版本第一步进哪个环境', ids: [] });
  let seen = '';
  const result = await rescueMiss({
    store,
    sessionId: 'session-real-query',
    scopeKeys: [scopes.workspace],
    complete: async ({ prompt }) => {
      seen = prompt;
      return '["atlas 上线先走灰度"]';
    },
  });
  assert.ok(seen.includes('atlas 要发新版本'), 'the prompt must carry the actual question');
  assert.equal(result.rescued, true, JSON.stringify(result));
});

test('the note is per session, so one conversation cannot borrow another question', () => {
  resetSliceNotes();
  recordLastSlice('session-a', { tier: 'none', query: 'alpha 的问题', ids: [] });
  recordLastSlice('session-b', { tier: 'none', query: 'beta 的问题', ids: [] });
  assert.equal(lastSliceOf('session-a').query, 'alpha 的问题');
  assert.equal(lastSliceOf('session-b').query, 'beta 的问题');
  assert.equal(lastSliceOf('session-c'), undefined);
});

test('a stale note is dropped rather than answering a later turn', () => {
  resetSliceNotes();
  recordLastSlice('session-stale', { tier: 'none', query: '旧问题', ids: [] });
  assert.equal(lastSliceOf('session-stale', -1), undefined);
});
