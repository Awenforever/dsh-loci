/**
 * The one place that builds a message this plugin injects into a turn.
 *
 * ## Why this module exists
 *
 * `dsh-loci` has now corrupted sessions three times by handing the Host a message that would not survive a
 * reload. The pattern is the same each time: the write path does not validate, the *load* path does, so a bad
 * message works for the rest of the session and the conversation becomes unopenable later.
 *
 * The Host's own check for a `user/message`, read out of the shipped bundle
 * (`app.asar`, `assertMessageEventShape`), is:
 *
 * ```js
 * const message = type === 'user/message' ? data : data?.message;
 * if (typeof message !== 'object' || message === null || typeof message.id !== 'string' || message.id === '')
 *   throw new Error(`${subject} lacks an identified message`);
 * if (message.role !== 'user') throw new Error(`${subject} message must have role "user"`);
 * if (typeof message.source !== 'object' || typeof message.source.kind !== 'string' || message.source.kind === '')
 *   throw new Error(`${subject} message has invalid source`);
 * if (!Array.isArray(message.content)) throw new Error(`${subject} message has invalid content`);
 * ```
 *
 * `7.2.0` violated the first line: `withRecallMessage` built `{role, source, content}` with no `id`. Six
 * conversations and 108 events had to be repaired by hand.
 *
 * So the shape is stated once, here, and every injection goes through {@link injectedMessage}. A message that
 * does not satisfy the contract cannot be constructed — which is a stronger guarantee than testing each call
 * site and hoping the next one remembers.
 *
 * @module dsh-loci/inject/message
 */

import { randomUUID } from 'node:crypto';

/**
 * Prefix for message ids so an injected message is recognisable in a session log.
 *
 * Kept stable across releases: the repair tooling from 2026-11-18 looks for `loci-recall-`.
 */
export const INJECTED_ID_PREFIX = 'loci-recall-';

/**
 * Mirror of the Host's `user/message` assertions.
 *
 * Deliberately duplicated rather than imported: the Host validator lives inside the shipped bundle and is not
 * importable, and a check that cannot run is not a check. `scripts/diag/host-message-contract.mjs` extracts the
 * original from `app.asar` so the two can be compared when the Host changes.
 *
 * @param message - the object that will become `event.data` of a `user/message`.
 * @returns the message, unchanged, when it is valid.
 * @throws when it would not survive a reload.
 */
export function assertInjectedMessage(message) {
  if (typeof message !== 'object' || message === null) {
    throw new Error('injected message must be an object');
  }
  if (typeof message.id !== 'string' || message.id === '') {
    throw new Error('injected message lacks an identified message (id must be a non-empty string)');
  }
  if (message.role !== 'user') {
    throw new Error(`injected message must have role "user", got ${JSON.stringify(message.role)}`);
  }
  if (typeof message.source !== 'object' || message.source === null || typeof message.source.kind !== 'string' || message.source.kind === '') {
    throw new Error('injected message has invalid source (kind must be a non-empty string)');
  }
  if (!Array.isArray(message.content)) {
    throw new Error('injected message has invalid content (must be an array)');
  }
  return message;
}

/**
 * Build a message to append to `decision.messages`.
 *
 * @param options.text - the block to inject.
 * @param options.kind - `source.kind`. `'user'` renders as user input; `'plugin:loci'` marks it as injected.
 *   Both are accepted by the Host, which only requires a non-empty string.
 * @param options.form - `source.form`, e.g. `'block'`.
 * @param options.summary - short description shown beside the message.
 * @returns a validated message object.
 */
export function injectedMessage({ text, kind = 'plugin:loci', form = 'block', summary = 'memory recall' }) {
  return assertInjectedMessage({
    id: `${INJECTED_ID_PREFIX}${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind, form: String(summary) === '' ? undefined : (form ?? undefined), summary },
  });
}

/**
 * Append one injected message to a waterfall decision.
 *
 * Kept here next to the shape so a call site cannot append anything else: the only way to add a message is to
 * come through this function, which validates.
 *
 * @param decision - the `agent/pre-step` decision.
 * @param message - a message built by {@link injectedMessage}.
 * @returns a new decision with one more message.
 */
export function withMessage(decision, message) {
  assertInjectedMessage(message);
  return { ...decision, messages: [...decision.messages, message] };
}
