#!/usr/bin/env node
/** Why does vector recall find nothing? Print each step. */
import { createServer } from 'node:http';
import { openTestStore, workspaceFields } from '../../test/helpers.mjs';
import { search } from '../../src/host/store/search.js';

function embed(text) {
  const value = String(text);
  return [
    ['deploy', 'rollout', 'canary', '灰度', '上线', '发版'].some((w) => value.includes(w)) ? 1 : 0,
    ['rollback', 'revert', '回滚'].some((w) => value.includes(w)) ? 1 : 0,
    ['cost', 'budget', '预算'].some((w) => value.includes(w)) ? 1 : 0,
  ];
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
    console.log('  embed request:', JSON.stringify(inputs), '→', JSON.stringify(inputs.map(embed)));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: inputs.map((t, i) => ({ index: i, embedding: embed(t) })) }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/embeddings`;

const { store, scopes } = openTestStore(
  { after: () => {} },
  { vectorMode: 'http', vectorEndpoint: endpoint, vectorModel: 'stub', vectorMinScore: 0.5 },
);
store.write({
  ...workspaceFields(scopes),
  status: 'verified',
  trustSource: 'user',
  kind: 'semantic',
  title: '发布必须先灰度',
  body: '发布流程先灰度再全量。',
});

console.log('backfill:', JSON.stringify(await store.backfillEmbeddings()));
console.log('channel.available():', store.embedding.available(), 'model:', store.embedding.model);
console.log('embeddings:', JSON.stringify(store.db.prepare('SELECT ord, model, dim FROM embedding').all()));

const queryVec = await store.embedding.embed(['rollout canary first?']);
console.log('query vector:', JSON.stringify(queryVec));

const rows = store.db
  .prepare(
    `SELECT e.ord, e.vec, m.id, m.title FROM embedding e JOIN memory m ON m.ord = e.ord
      JOIN memory_head h ON h.ord = m.ord
     WHERE e.model = ? AND h.status = 'verified' AND m.valid_to IS NULL
       AND m.scope_key IN (?) LIMIT ?`,
  )
  .all(store.embedding.model, scopes.workspace, 5000);
console.log('scan rows:', rows.length, JSON.stringify(rows.map((r) => r.title)));

const found = await search(store, {
  query: 'rollout canary first?',
  scopeKeys: [scopes.workspace],
  statuses: ['verified'],
  limit: 5,
  detail: 'snippet',
});
console.log('search hits:', JSON.stringify(found.hits.map((h) => h.title)), 'channels:', JSON.stringify(found.channels));
store.close();
server.close();
