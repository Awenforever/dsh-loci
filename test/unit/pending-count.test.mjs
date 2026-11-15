import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REVIEWABLE_KINDS } from '../../src/host/store/store.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * A number that sends a person to an empty room is worse than no number.
 *
 * The card read "3 item(s) waiting for you in Review" while the Review tab was empty. Both
 * were right about different questions: the counter counted every candidate in scope, and
 * Review lists only the kinds that can reach the prompt. Episodic session summaries are
 * candidates by design — history, not claims — so on a normal day the entire count could be
 * composed of rows Review deliberately hides.
 *
 * Found in the live store, not in a test: three session summaries, all `episodic`, all
 * `candidate`, and the sidebar offering to show them somewhere it would not.
 */
test('the reviewable kinds are the three that can reach the prompt', () => {
  assert.deepEqual([...REVIEWABLE_KINDS], ['rule', 'semantic', 'procedural']);
  assert.equal(REVIEWABLE_KINDS.includes('episodic'), false);
  assert.equal(REVIEWABLE_KINDS.includes('working'), false);
});

test('an episodic candidate is not counted as pending', (t) => {
  const { store, scopes } = openTestStore(t);
  const fields = workspaceFields(scopes);
  store.write({ ...fields, kind: 'episodic', trustSource: 'summary', title: 'Session 2026-11-15 — a summary', body: 'history' });

  // The row really is a candidate; it simply is not a question for a person.
  assert.equal(store.stats({ scopeKeys: [scopes.workspace] }).byStatus.candidate, 1);
  assert.equal(store.countPending([scopes.workspace]), 0);
  assert.equal(store.stats({ scopeKeys: [scopes.workspace] }).pendingCandidates, 0);
});

test('a reviewable candidate is counted, and the count matches a filtered list', (t) => {
  const { store, scopes } = openTestStore(t);
  const fields = workspaceFields(scopes);
  store.write({ ...fields, kind: 'rule', trustSource: 'tool', title: 'Never deploy on Friday', body: 'unless it is a revert' });
  store.write({ ...fields, kind: 'episodic', trustSource: 'summary', title: 'Session 2026-11-15 — a summary', body: 'history' });
  store.write({ ...fields, kind: 'working', trustSource: 'tool', title: 'scratch note', body: 'temporary' });

  const stats = store.stats({ scopeKeys: [scopes.workspace] });
  const listed = store.list({ scopeKeys: [scopes.workspace], statuses: ['candidate'], kinds: [...REVIEWABLE_KINDS] });

  assert.equal(stats.pendingCandidates, 1, 'only the rule is a question for a person');
  assert.equal(store.countPending([scopes.workspace]), 1);
  // The invariant that matters: the badge equals the list.
  assert.equal(stats.pendingCandidates, listed.total);
});

test('an expired reviewable candidate stops being counted', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    ...workspaceFields(scopes),
    kind: 'rule',
    trustSource: 'tool',
    title: 'An old proposal',
    body: 'body',
    validTo: Date.now() - 1000,
  });
  assert.equal(store.countPending([scopes.workspace]), 0);
  assert.equal(store.stats({ scopeKeys: [scopes.workspace] }).pendingCandidates, 0);
});
