import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCuratorPrompt,
  curate,
  extractJsonObject,
  parseCuratorReply,
  prefilter,
} from '../../src/host/record/curator.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * Rules propose, a model decides.
 *
 * The measurement behind this layering (`scripts/eval-memory.mjs`, part B): the rule extractor
 * scores **100% precision, 50% recall** on eight transcripts. It never misfires and it misses
 * `以后部署先走灰度`, `约定发布窗口是周三` and `永远不要在周五发版`. Safe but blind.
 *
 * The model is a dependency here rather than a global, which is what makes the decision layer
 * testable: a fixture stands in for the judgement and the tests assert the parts that must not
 * depend on model quality — the contract, the validation, and the write path.
 */

const TRANSCRIPT = [
  { role: 'user', text: '以后部署先走灰度，别再直接全量了。' },
  { role: 'assistant', text: '明白，先灰度。' },
  { role: 'user', text: '今天天气不错。' },
  { role: 'user', text: '永远不要在周五发版。' },
];

test('the pre-filter keeps judgement-relevant sentences and drops questions', () => {
  const kept = prefilter([
    ...TRANSCRIPT,
    { role: 'user', text: '要不要周末先发一版？' },
    { role: 'assistant', text: '这条来自助手，不该进候选。' },
  ]);
  const texts = kept.map((item) => item.text);
  assert.ok(texts.some((text) => text.includes('以后部署先走灰度')));
  assert.ok(texts.some((text) => text.includes('永远不要在周五发版')));
  assert.ok(!texts.some((text) => text.includes('要不要周末')), 'a question cannot be a constraint');
  assert.ok(!texts.some((text) => text.includes('这条来自助手')), 'only user messages are testimony');
});

test('the pre-filter is permissive where the rule extractor was strict', () => {
  // `以后…` and `约定…` were exactly what the old extractor missed. As a pre-filter it has no
  // reason to reject them: the cost of a false positive is one line in a prompt to the curator.
  const kept = prefilter([
    { role: 'user', text: '以后部署先走灰度。' },
    { role: 'user', text: '我们说好，约定发布窗口是周三。' },
  ]);
  assert.equal(kept.length, 2);
});

test('the prompt carries the contract, the known memories and the transcript', () => {
  const prompt = buildCuratorPrompt({ messages: TRANSCRIPT, existing: ['已有的规则'] });
  assert.match(prompt, /Return ONLY a JSON object/);
  assert.match(prompt, /evidenceQuote MUST be copied verbatim/);
  assert.match(prompt, /已有的规则/);
  assert.match(prompt, /USER: 以后部署先走灰度/);
});

test('a reply that is not JSON is refused, not guessed at', () => {
  const parsed = parseCuratorReply('Sure! I remembered that you prefer canary deploys.', { messages: TRANSCRIPT });
  assert.equal(parsed.items.length, 0);
  assert.match(parsed.error, /not JSON/);
});

test('a fenced JSON block is tolerated', () => {
  // The contract forbids a fence. A fence is a formatting mistake, and throwing away a correct
  // decision over one would lose real memory.
  const reply = '```json\n{"keep":[],"drop":[]}\n```';
  const parsed = parseCuratorReply(reply, { messages: TRANSCRIPT });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.items.length, 0);
});

test('a JSON object wrapped in a sentence is still read, and the drift is recorded', () => {
  // Observed on the live route: the model answered with prose around a correct object, and the
  // strict parser discarded the whole conversation's memory over a courtesy phrase.
  const reply =
    'Sure, here is what I would keep:\n{"keep":[{"kind":"rule","title":"永远不要在周五发版",' +
    '"body":"永远不要在周五发版。","evidenceQuote":"永远不要在周五发版。"}],"drop":[]}\nLet me know if that looks right.';
  const parsed = parseCuratorReply(reply, { messages: TRANSCRIPT });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.extracted, true, 'a run that needed extraction must be visible');
});

test('extraction is balanced, so braces inside strings do not end it early', () => {
  const reply =
    'ok: {"keep":[{"kind":"semantic","title":"a {b} title","body":"has {braces} in it",' +
    '"evidenceQuote":"永远不要在周五发版。"}],"drop":[]}';
  const parsed = parseCuratorReply(reply, { messages: TRANSCRIPT });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, 'a {b} title');
});

test('prose with no object at all is still refused', () => {
  const parsed = parseCuratorReply('I have remembered your preference.', { messages: TRANSCRIPT });
  assert.equal(parsed.error, 'reply is not JSON');
  assert.equal(parsed.extracted, false);
});

test('an unsupported kind is rejected rather than coerced', () => {
  const reply = JSON.stringify({
    keep: [{ kind: 'note', title: '以后部署先走灰度', body: '先灰度。', evidenceQuote: '以后部署先走灰度，别再直接全量了。' }],
    drop: [],
  });
  const parsed = parseCuratorReply(reply, { messages: TRANSCRIPT });
  assert.equal(parsed.items.length, 0);
  assert.match(parsed.dropped[0].reason, /unsupported kind/);
});

test('a quote that is not verbatim drops the item', () => {
  const reply = JSON.stringify({
    keep: [
      {
        kind: 'rule',
        title: '部署先灰度',
        body: '以后部署先走灰度。',
        evidenceQuote: '部署要走灰度吧', // plausible, but nobody said this
      },
    ],
    drop: [],
  });
  const parsed = parseCuratorReply(reply, { messages: TRANSCRIPT });
  assert.equal(parsed.items.length, 0);
  assert.match(parsed.dropped[0].reason, /not verbatim/);
});

test('oversized fields are rejected against the store limits', () => {
  const reply = JSON.stringify({
    keep: [
      { kind: 'rule', title: 'x'.repeat(200), body: 'ok', evidenceQuote: '永远不要在周五发版。' },
      { kind: 'rule', title: 'ok', body: 'y'.repeat(5000), evidenceQuote: '永远不要在周五发版。' },
    ],
    drop: [],
  });
  const parsed = parseCuratorReply(reply, { messages: TRANSCRIPT });
  assert.equal(parsed.items.length, 0);
  assert.equal(parsed.dropped.length, 2);
});

test('a curated item with real evidence is written through the ordinary gate', async (t) => {
  const { store, scopes } = openTestStore(t, {}, {
    // The same verifier the Host wires: the quote must occur in this session's user messages.
    quoteVerifier: (quote) => TRANSCRIPT.some((message) => String(message.text).includes(quote)),
  });
  const callModel = async () =>
    JSON.stringify({
      keep: [
        {
          kind: 'rule',
          title: '永远不要在周五发版',
          body: '永远不要在周五发版，避免周末无人值守。',
          evidenceQuote: '永远不要在周五发版。',
        },
      ],
      drop: [],
    });

  const result = await curate({
    store,
    scope: { ...workspaceFields(scopes) },
    messages: TRANSCRIPT,
    callModel,
    sessionId: 'session-curated',
  });

  assert.equal(result.error, undefined);
  assert.equal(result.written.length, 1);
  assert.equal(result.written[0].status, 'verified', 'a verbatim quote is the trust signal, not a click');
  const stored = store.get(result.written[0].id).entry;
  assert.equal(stored.title, '永远不要在周五发版');
  assert.equal(stored.status, 'verified');
});

test('without the session id the same item cannot pass the gate', async (t) => {
  const { store, scopes } = openTestStore(t, {}, {
    quoteVerifier: (quote, options) => options?.sessionId !== undefined && TRANSCRIPT.some((m) => String(m.text).includes(quote)),
  });
  const callModel = async () =>
    JSON.stringify({
      keep: [{ kind: 'rule', title: '永远不要在周五发版', body: '别在周五发。', evidenceQuote: '永远不要在周五发版。' }],
      drop: [],
    });
  const result = await curate({ store, scope: { ...workspaceFields(scopes) }, messages: TRANSCRIPT, callModel });
  // This is the bug the first version had: `evidence` was the bare quote string, the gate read
  // `evidence.quote` as undefined, and every curated item silently became a candidate — which
  // looks identical to "the model judged nothing".
  assert.equal(result.written.length, 1);
  assert.equal(result.written[0].status, 'candidate');
});

test('a model failure is reported, never half-applied', async (t) => {
  const { store, scopes } = openTestStore(t);
  const result = await curate({
    store,
    scope: { ...workspaceFields(scopes) },
    messages: TRANSCRIPT,
    callModel: async () => {
      throw new Error('provider down');
    },
    sessionId: 'session-curated',
  });
  assert.match(result.error, /provider down/);
  assert.equal(store.list({ scopeKeys: [scopes.workspace] }).total, 0, 'nothing was written');
});

test('no model means no curation, stated rather than silent', async (t) => {
  const { store, scopes } = openTestStore(t);
  const result = await curate({ store, scope: { ...workspaceFields(scopes) }, messages: TRANSCRIPT });
  assert.match(result.error, /no model available/);
});

test('dry run decides without writing', async (t) => {
  const { store, scopes } = openTestStore(t);
  const callModel = async () =>
    JSON.stringify({
      keep: [{ kind: 'rule', title: '永远不要在周五发版', body: '别在周五发。', evidenceQuote: '永远不要在周五发版。' }],
      drop: [],
    });
  const result = await curate({
    store,
    scope: { ...workspaceFields(scopes) },
    messages: TRANSCRIPT,
    callModel,
    sessionId: 's',
    dryRun: true,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.written.length, 0);
  assert.equal(store.list({ scopeKeys: [scopes.workspace] }).total, 0);
});

// ---------------------------------------------------------------- reply contract, from real data
//
// One day of production produced 146 curation passes, 10 of which failed to parse (7%) and were audited
// only as "reply has no keep array" — which cannot distinguish a model using a different key from one
// returning a stringified apology. These pin the two changes that came out of that: accept the obvious
// equivalent shape, and record what actually came back.

const PARSE_MESSAGES = [{ role: 'user', text: '以后部署先走灰度。' }];

test('a bare array is accepted as the same contract without its envelope', () => {
  const parsed = parseCuratorReply(
    '[{"kind":"rule","title":"部署先灰度","body":"先灰度再全量。","evidenceQuote":"以后部署先走灰度"}]',
    { messages: PARSE_MESSAGES },
  );
  assert.equal(parsed.error, undefined, parsed.error);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].kind, 'rule');
});

test('an unknown envelope fails, and says what came back', () => {
  const parsed = parseCuratorReply('{"items":[{"kind":"rule"}]}', { messages: PARSE_MESSAGES });
  assert.equal(parsed.error, 'reply has no keep array');
  assert.match(parsed.rawHead, /"items"/, 'the audit line can now show the shape');
});

test('unparseable prose fails, and says what came back', () => {
  const parsed = parseCuratorReply('I could not find anything worth keeping.', { messages: PARSE_MESSAGES });
  assert.equal(parsed.error, 'reply is not JSON');
  assert.match(parsed.rawHead, /could not find/);
});

test('the recorded head is bounded, so it is a shape and never a transcript', () => {
  const parsed = parseCuratorReply(`{"keep":[${'"x",'.repeat(400)}]}`, { messages: PARSE_MESSAGES });
  assert.ok((parsed.rawHead ?? '').length <= 160);
});

test('an empty keep list is a decision, not a failure', () => {
  const parsed = parseCuratorReply('{"keep":[],"drop":[]}', { messages: PARSE_MESSAGES });
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.items, []);
});
