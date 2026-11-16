import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../../src/host/config.js';
import { createIndexSection } from '../../src/host/inject/index-section.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * The memory manager must never be given memory.
 *
 * This is the operator's hard constraint, quoted: "永远保证记忆管理者本身不被记忆所影响 —
 * 记忆管理者本身不应该被 dsh-loci 注入记忆，dsh-loci 所有的记忆对记忆管理者来说只是可以阅读/
 * 参考/操纵/写入的语料". Its access is the tools, which is reading; the prompt section is the
 * thing that would shape it.
 *
 * Before schema v6 the property held only as a side effect of `delegationDepth > 0` — a fact
 * about delegation, not about being a manager. A manager running as a top-level session would
 * have broken it silently, which is the worst failure mode for a constraint that is supposed to
 * be structural.
 */

function seed(store, scopes, entries) {
  for (const entry of entries) {
    store.write({ ...workspaceFields(scopes), status: 'verified', trustSource: 'user', ...entry });
  }
}

/** A registered section whose context names `sessionId`. */
function sectionFor(store, scopes, sessionId, storeRef) {
  return createIndexSection({
    store: storeRef,
    config: (key) => DEFAULTS[key],
    resolveContext: (assembly) => {
      // The same check the plugin performs, on the real store, so this test exercises the
      // wiring rather than a copy of it.
      if (storeRef.injectionExemptReason(sessionId) !== undefined) return undefined;
      if ((assembly?.delegationDepth ?? 0) > 0) return undefined;
      return {
        sessionId,
        scopeKey: scopes.workspace,
        scopeKeys: [scopes.workspace],
        scopeLabel: scopes.labels.workspace,
        lastUserText: '回滚窗口多久？',
      };
    },
  });
}

test('an ordinary conversation receives the section', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'rule', title: '删除前做断言', body: '先校验路径。' }]);
  const text = sectionFor(store, scopes, 'session-user', store).text({});
  assert.match(text, /删除前做断言/);
});

test('the manager receives nothing at all, not even the pointer', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [
    { kind: 'rule', title: '删除前做断言', body: '先校验路径。' },
    { kind: 'semantic', title: '回滚窗口是三十分钟', body: '超过就升级。' },
  ]);
  store.exemptFromInjection('session-manager', 'curator');
  const text = sectionFor(store, scopes, 'session-manager', store).text({});
  // Not merely "different": empty. A pointer would tell the manager that memory exists, which is
  // itself a hint about the corpus it is supposed to judge independently.
  assert.equal(text, '');
});

test('the exemption is a stored fact, not a property of the call', (t) => {
  const { store } = openTestStore(t);
  assert.equal(store.injectionExemptReason('session-m'), undefined);
  store.exemptFromInjection('session-m', 'curator');
  assert.equal(store.injectionExemptReason('session-m'), 'curator');
  // Reading it back through a fresh query is what a restarted process would do.
  const listed = store.listInjectionExempt();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].session_id, 'session-m');
  assert.equal(listed[0].reason, 'curator');
});

test('an exemption can be lifted', (t) => {
  const { store } = openTestStore(t);
  store.exemptFromInjection('session-m', 'curator');
  assert.equal(store.allowInjection('session-m'), true);
  assert.equal(store.injectionExemptReason('session-m'), undefined);
  assert.equal(store.allowInjection('session-m'), false, 'lifting twice reports nothing was there');
});

test('one manager does not exempt another conversation', (t) => {
  const { store, scopes } = openTestStore(t);
  seed(store, scopes, [{ kind: 'rule', title: '删除前做断言', body: '先校验路径。' }]);
  store.exemptFromInjection('session-manager', 'curator');
  const text = sectionFor(store, scopes, 'session-someone-else', store).text({});
  assert.match(text, /删除前做断言/, 'the exemption must be per session, not global');
});

test('re-exempting updates the reason without duplicating the row', (t) => {
  const { store } = openTestStore(t);
  store.exemptFromInjection('session-m', 'first');
  store.exemptFromInjection('session-m', 'second');
  const listed = store.listInjectionExempt();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].reason, 'second');
});

test('an empty session id is refused rather than stored', (t) => {
  const { store } = openTestStore(t);
  assert.equal(store.exemptFromInjection(''), false);
  assert.equal(store.exemptFromInjection(undefined), false);
  assert.equal(store.listInjectionExempt().length, 0);
});
