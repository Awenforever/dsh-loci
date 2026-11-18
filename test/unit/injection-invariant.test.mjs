import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * The invariant that keeps this from being fixed a fourth time.
 *
 * `dsh-loci` has broken conversation logs three times by handing the Host a message it would later refuse:
 *  1. a missing protected head (2026-11-16);
 *  2. a missing message id on the *assist* path;
 *  3. a missing message id on the *slice/rescue* path (2026-11-18, six conversations, 108 events).
 *
 * Each fix repaired the call site that was known to be broken. None of them made the *next* call site safe,
 * which is why there was a next one. So this test does not check a call site — it checks that the shape has
 * exactly one home.
 *
 * The rule: **`decision.messages` may only grow inside `inject/message.js`.** Anywhere else that spreads the
 * existing messages and appends an object literal is building a message by hand, and a message built by hand is
 * a message nobody validated.
 */

const ROOT = new URL('../../src/host/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Every `.js` file under `src/host`. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

/** The one file allowed to append to a decision's message list. */
const ALLOWED = join(ROOT, 'inject', 'message.js').replace(/\\/g, '/');

const relative = (path) => path.replace(/\\/g, '/').split('/src/host/')[1] ?? path;

test('only inject/message.js appends to decision.messages', () => {
  const offenders = [];
  for (const path of walk(ROOT)) {
    if (path.replace(/\\/g, '/') === ALLOWED) continue;
    const source = readFileSync(path, 'utf8');
    // Both spellings that have actually appeared: the spread-then-literal form, and an explicit push.
    const spreads = /messages\s*:\s*\[[\s\S]{0,120}?\.\.\.\s*decision\.messages/.test(source);
    const pushes = /decision\.messages\s*\.\s*push\s*\(/.test(source);
    if (spreads || pushes) offenders.push(relative(path));
  }
  assert.deepEqual(
    offenders,
    [],
    `these files build a message by hand instead of going through inject/message.js: ${offenders.join(', ')}`,
  );
});

test('nothing constructs a raw role:"user" message literal', () => {
  // A narrower check than the one above, deliberately overlapping: the spread form could be written differently
  // tomorrow, but the literal is what makes it a message.
  const offenders = [];
  for (const path of walk(ROOT)) {
    if (path.replace(/\\/g, '/') === ALLOWED) continue;
    const source = readFileSync(path, 'utf8');
    // `{ role: 'user', source: …` on one line is a message being built. The capture buffer uses
    // `{ role: 'user', text }`, which is a different shape and is matched by its own pattern.
    for (const match of source.matchAll(/\{\s*role:\s*'user'\s*,\s*source:/g)) {
      const before = source.slice(0, match.index);
      const line = before.split('\n').length;
      offenders.push(`${relative(path)}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], `raw user message literals found at ${offenders.join(', ')}`);
});

test('every recall injection path routes through withMessage', () => {
  // The call sites that existed when the bug was found. If a new one appears it should be added here — that is
  // the point: making someone write down the new path is what turns "remembered to validate" into a review step.
  const source = readFileSync(join(ROOT, 'index.js'), 'utf8');
  const recallCalls = (source.match(/withRecallMessage\(decision,/g) ?? []).length;
  assert.ok(recallCalls >= 2, `expected the slice and rescue paths, found ${recallCalls}`);
  assert.ok(
    source.includes("import { injectedMessage, withMessage } from './inject/message.js'"),
    'index.js must import the factory rather than build messages inline',
  );
});
