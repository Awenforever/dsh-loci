import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INJECTED_ID_PREFIX,
  assertInjectedMessage,
  injectedMessage,
  withMessage,
} from '../../src/host/inject/message.js';

/**
 * The injection contract.
 *
 * `dsh-loci` corrupted conversations three times by handing the Host a message that would not survive a
 * reload: the write path does not validate, the load path does. These tests pin the shape against the Host's
 * `assertMessageEventShape`, read out of the shipped bundle by `scripts/diag/host-message-contract.mjs`.
 *
 * The one that matters is "rejects the 7.2.0 shape" — that is the regression, stated as a test.
 */

test('an injected message satisfies every field the Host checks on load', () => {
  const message = injectedMessage({ text: 'recalled memory' });
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.length > 0, 'id must be a non-empty string');
  assert.equal(message.role, 'user', 'user/message requires role "user"');
  assert.equal(typeof message.source.kind, 'string');
  assert.ok(message.source.kind.length > 0, 'source.kind must be a non-empty string');
  assert.ok(Array.isArray(message.content), 'content must be an array');
  assert.deepEqual(message.content, [{ type: 'text', text: 'recalled memory' }]);
});

test('ids are unique, so two recalls in one turn stay distinguishable', () => {
  const a = injectedMessage({ text: 'one' });
  const b = injectedMessage({ text: 'one' });
  assert.notEqual(a.id, b.id);
  assert.ok(a.id.startsWith(INJECTED_ID_PREFIX), 'the prefix is what repair tooling looks for');
});

test('the 7.2.0 shape is rejected', () => {
  // This is exactly what `withRecallMessage` produced before 7.2.1, and exactly what made six conversations
  // unopenable. If this assertion ever stops throwing, the bug is back.
  assert.throws(
    () => assertInjectedMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }),
    /lacks an identified message/,
  );
});

test('each individual defect is named, not collapsed into one error', () => {
  const base = { id: 'loci-recall-1', role: 'user', source: { kind: 'plugin:loci' }, content: [] };
  assert.throws(() => assertInjectedMessage({ ...base, id: '' }), /lacks an identified message/);
  assert.throws(() => assertInjectedMessage({ ...base, id: 42 }), /lacks an identified message/);
  assert.throws(() => assertInjectedMessage({ ...base, role: 'assistant' }), /must have role "user"/);
  assert.throws(() => assertInjectedMessage({ ...base, source: { kind: '' } }), /invalid source/);
  assert.throws(() => assertInjectedMessage({ ...base, source: {} }), /invalid source/);
  assert.throws(() => assertInjectedMessage({ ...base, content: 'text' }), /invalid content/);
  assert.throws(() => assertInjectedMessage(null), /must be an object/);
});

test('appending refuses an invalid message instead of writing it', () => {
  const decision = { messages: [{ role: 'user', id: 'existing', source: { kind: 'user' }, content: [] }] };
  const next = withMessage(decision, injectedMessage({ text: 'recall' }));
  assert.equal(next.messages.length, 2);
  assert.equal(decision.messages.length, 1, 'the input decision is not mutated');

  assert.throws(
    () => withMessage(decision, { role: 'user', source: { kind: 'user' }, content: [] }),
    /lacks an identified message/,
  );
});

test('a long recall text survives unchanged', () => {
  // The slice can be a kilobyte of Chinese; the factory must not clip it.
  const text = '记忆'.repeat(2000);
  const message = injectedMessage({ text });
  assert.equal(message.content[0].text, text);
});

test('a missing text becomes an empty string rather than the word undefined', () => {
  assert.equal(injectedMessage({}).content[0].text, '');
});
