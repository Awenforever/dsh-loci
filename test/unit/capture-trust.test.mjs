import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { openTestStore } from '../helpers.mjs';

/**
 * The review queue is a gate, not a toll booth.
 *
 * A statement lifted verbatim out of the user's own message is testimony: it
 * should pass the same quote gate a model-supplied quote passes, and reach the
 * prompt without anyone clicking. What must *not* happen is an automatic
 * extractor writing entries that nobody can vouch for.
 */
test('a captured statement is verified when its quote is in the session', (t) => {
  const { store, scopes } = openTestStore(t, {}, { quoteVerifier: (quote) => quote.includes('以后都') });
  const result = store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'rule',
    title: '以后都用中文回答',
    body: '用户要求以后都用中文回答。',
    trustSource: 'rule',
    evidence: { quote: '以后都用中文回答', sessionId: 's1' },
  });
  assert.equal(result.entry.status, 'verified', 'testimony carries its own evidence');
});

test('a captured statement whose quote the session cannot confirm stays a candidate', (t) => {
  const { store, scopes } = openTestStore(t, {}, { quoteVerifier: () => false });
  const result = store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'rule',
    title: '模型编的一条规则',
    body: '这句话用户从没说过。',
    trustSource: 'rule',
    evidence: { quote: '这句话用户从没说过', sessionId: 's1' },
  });
  assert.equal(result.entry.status, 'candidate');
});

test('autoVerifyCaptured:false puts captured statements back in review', (t) => {
  const { store, scopes } = openTestStore(
    t,
    { autoVerifyCaptured: false },
    { quoteVerifier: () => true },
  );
  const result = store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'rule',
    title: '以后都用中文回答',
    body: '用户要求以后都用中文回答。',
    trustSource: 'rule',
    evidence: { quote: '以后都用中文回答', sessionId: 's1' },
  });
  assert.equal(result.entry.status, 'candidate', 'a cautious user can keep the queue');
});

test('an import is never verified by its own text', (t) => {
  const { store, scopes } = openTestStore(t, {}, { quoteVerifier: () => true });
  const result = store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'semantic',
    title: '从别处导入的一条',
    body: '无论引文能不能匹配，导入都不是证词。',
    trustSource: 'import',
    evidence: { quote: '无论引文能不能匹配，导入都不是证词' },
  });
  assert.equal(result.entry.status, 'candidate');
});

test('a session summary is never verified by its own text', (t) => {
  const { store, scopes } = openTestStore(t, {}, { quoteVerifier: () => true });
  const result = store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'episodic',
    title: 'Session 2026-11-14 00:10 — 讨论审查队列',
    body: 'Session summary.',
    trustSource: 'summary',
    evidence: { quote: 'Session summary', sessionId: 's1' },
  });
  assert.equal(result.entry.status, 'candidate');
});

test('the default config turns capture verification on', () => {
  assert.equal(effectiveConfig({}).autoVerifyCaptured, true);
});
