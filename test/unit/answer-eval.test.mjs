import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANSWER_CONTROLS, ANSWER_FIXTURE, runAnswerEval } from '../../src/host/tools/answer-eval.js';
import { openTestStore } from '../helpers.mjs';

/**
 * The answer-quality measurement, exercised without a model.
 *
 * R18 asks whether memory makes answers better. The harness has to be trustworthy before its numbers are:
 * the fixture must be unknowable, the grading must be mechanical, and the controls must catch a model that
 * scores well by inventing.
 */

/** A stub that answers correctly only when the memory block is present. */
function stubModel({ honest = true } = {}) {
  const calls = [];
  return {
    calls,
    complete: async ({ prompt }) => {
      calls.push(prompt);
      const hasMemory = prompt.includes('<loci-context');
      const fact = ANSWER_FIXTURE.find((item) => prompt.endsWith(item.question));
      if (fact === undefined) {
        // A control question: nothing is stored, so the honest answer is to say so.
        return honest ? 'I have no record of that.' : 'It is 42 seconds.';
      }
      return hasMemory ? fact.title : 'I do not know.';
    },
  };
}

test('every fixture fact is unknowable and every control has no fact', () => {
  for (const fact of ANSWER_FIXTURE) {
    assert.ok(fact.title.length > 0 && fact.question.length > 0);
    assert.ok(fact.accepts.length > 0, 'a fact without an accepted answer cannot be graded');
    assert.ok(!fact.question.includes(fact.title), 'the question must not contain its own answer');
  }
  for (const control of ANSWER_CONTROLS) {
    assert.equal(control.accepts.length, 0, 'a control must have no accepted answer');
    const collides = ANSWER_FIXTURE.some((fact) => fact.accepts.some((pattern) => pattern.test(control.question)));
    assert.equal(collides, false, 'a control question must not be answerable from the fixture');
  }
});

test('memory flips the score, and the cost of that flip is reported', async (t) => {
  const { store, scopes } = openTestStore(t);
  const model = stubModel();
  const report = await runAnswerEval({ store, scopes, complete: model.complete, limit: 3 });

  assert.equal(report.questions, 3);
  assert.equal(report.withoutMemory.correct, 0, 'without the block the model cannot know');
  assert.equal(report.withMemory.correct, 3, 'with the block it can');
  assert.ok(report.cost.promptBytesWith > report.cost.promptBytesWithout, 'the block costs bytes');
  assert.ok(report.cost.estimatedTokensWith >= report.cost.estimatedTokensWithout);
  // Two calls per question: alone, then with memory.
  assert.equal(model.calls.length, 6 + ANSWER_CONTROLS.length);
});

test('a model that invents answers for the controls is flagged', async (t) => {
  const { store, scopes } = openTestStore(t);
  const model = stubModel({ honest: false });
  const report = await runAnswerEval({ store, scopes, complete: model.complete, limit: 2 });
  assert.equal(report.controls.invented, ANSWER_CONTROLS.length, 'both controls were answered from nowhere');
  assert.equal(report.controls.abstained, 0);
});

test('the fixture lands in its own scope and cannot pollute real memory', async (t) => {
  const { store, scopes } = openTestStore(t);
  const model = stubModel();
  await runAnswerEval({ store, scopes, complete: model.complete, limit: 2 });
  const fixture = store.db
    .prepare("SELECT COUNT(*) AS n FROM memory WHERE scope_key = 'session:answer-eval'")
    .get().n;
  const real = store.db.prepare('SELECT COUNT(*) AS n FROM memory WHERE scope_key <> ?').get('session:answer-eval').n;
  assert.equal(fixture, 2, 'the fixture is written where it says it is');
  assert.equal(real, 0, 'and nothing else was touched');
});

test('a dry run seeds without calling the model', async (t) => {
  const { store, scopes } = openTestStore(t);
  const model = stubModel();
  const report = await runAnswerEval({ store, scopes, complete: model.complete, limit: 2, dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(model.calls.length, 0);
});

test('without a route the tool says so instead of reporting a zero score', async (t) => {
  const { store, scopes } = openTestStore(t);
  const report = await runAnswerEval({ store, scopes, complete: undefined });
  assert.equal(report.error, 'no model route');
});
