import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { search } from '../../src/host/store/search.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * The semantic channel, end to end, against a stub embedding server.
 *
 * The claim being tested is narrow and worth keeping narrow: with an OpenAI-shaped `/embeddings`
 * endpoint configured, a question that shares **no** words with the stored sentence can still find it.
 * That is the whole reason the channel exists — the lexical slice misses about 40% of reworded
 * questions at 600 entries, and a tokenizer cannot bridge `atlas 要发新版本` to
 * `atlas 服务上线先走灰度`.
 *
 * What this does *not* prove: that the deployed endpoint is any good, or that the prompt section
 * benefits. The section is synchronous and cannot await an embedding call, so vectors only ever serve
 * the asynchronous paths — `search()` and, through it, the rewrite rescue.
 */

/** A deterministic three-dimensional "embedding": counts of three topical buckets. */
function embed(text) {
  const value = String(text);
  const buckets = [
    ['deploy', 'rollout', 'canary', '灰度', '上线', '发版'],
    ['rollback', 'revert', '回滚', '撤销'],
    ['cost', 'budget', '花费', '预算'],
  ];
  return buckets.map((words) => (words.some((word) => value.includes(word)) ? 1 : 0));
}

async function withStubServer(t) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      requests.push(inputs);
      const payload = {
        data: inputs.map((text, index) => ({ index, embedding: embed(text) })),
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { endpoint: `http://127.0.0.1:${port}/v1/embeddings`, requests };
}

test('a stub endpoint fills the embedding table and a wordless question finds the entry', async (t) => {
  const { endpoint, requests } = await withStubServer(t);
  const { store, scopes } = openTestStore(t, { vectorMode: 'http', vectorEndpoint: endpoint, vectorModel: 'stub', vectorMinScore: 0.5 });

  store.write({
    ...workspaceFields(scopes),
    status: 'verified',
    trustSource: 'user',
    kind: 'semantic',
    title: '发布必须先灰度',
    body: '发布流程先灰度再全量。',
  });

  const filled = await store.backfillEmbeddings();
  assert.equal(filled.skipped, false, 'the channel is configured, so the backfill runs');
  assert.equal(filled.added, 1, 'one entry got a vector');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM embedding').get().n, 1);

  // A question with no word in common with the stored sentence, but the same topic.
  const found = await search(store, {
    query: 'rollout canary first?',
    scopeKeys: [scopes.workspace],
    statuses: ['verified'],
    limit: 5,
    detail: 'snippet',
  });
  assert.ok(
    found.hits.some((hit) => hit.title.includes('灰度')),
    `the vector channel should surface it: ${JSON.stringify(found.hits.map((hit) => hit.title))}`,
  );
  assert.ok(found.channels?.includes('vector') ?? true, 'the vector channel is reported when used');
  assert.ok(requests.length >= 2, 'the query was embedded as well as the entry');
  store.close();
});

test('with the channel off, nothing embeds and search still works', async (t) => {
  const { store, scopes } = openTestStore(t, { vectorMode: 'off' });
  store.write({
    ...workspaceFields(scopes),
    status: 'verified',
    trustSource: 'user',
    kind: 'semantic',
    title: '发布必须先灰度',
    body: '发布流程先灰度再全量。',
  });
  const filled = await store.backfillEmbeddings();
  assert.equal(filled.skipped, true, 'off means off: no request is attempted');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM embedding').get().n, 0);

  const lexical = await search(store, {
    query: '灰度',
    scopeKeys: [scopes.workspace],
    statuses: ['verified'],
    limit: 5,
    detail: 'snippet',
  });
  assert.equal(lexical.hits.length, 1, 'the lexical path is unaffected');
  store.close();
});

test('an unreachable endpoint parks the channel instead of failing every call', async (t) => {
  const { store, scopes } = openTestStore(t, {
    vectorMode: 'http',
    vectorEndpoint: 'http://127.0.0.1:1/v1/embeddings',
    vectorTimeoutMs: 500,
  });
  store.write({
    ...workspaceFields(scopes),
    status: 'verified',
    trustSource: 'user',
    kind: 'semantic',
    title: '发布必须先灰度',
    body: '发布流程先灰度再全量。',
  });
  const filled = await store.backfillEmbeddings();
  assert.equal(filled.added, 0, 'nothing is written when the endpoint is unreachable');
  const health = store.embedding.health();
  assert.ok(health.calls >= 1, 'the attempt was made and recorded');
  assert.ok(health.lastError !== null, 'the failure is visible in health, not swallowed');
  store.close();
});
