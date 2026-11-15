import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestStore, workspaceFields } from '../helpers.mjs';
import { search } from '../../src/host/store/search.js';

/**
 * Admission for a natural-language question.
 *
 * The old rule was all-or-nothing per CJK run: every bigram of the query's run had to
 * appear in the entry. A run is the whole sentence between punctuation, so **one word the
 * store had never seen zeroed the query**. Measured: "回滚窗口" found the entry and
 * "回滚窗口多久？" found nothing, which meant `loci_search` returned empty for most real
 * questions — people do not type bare keywords.
 *
 * The replacement admits a contiguous stretch of at least three characters, with two
 * guards so the original false-positive is still rejected: the stretch must be
 * contiguous (scattered words do not form one), and a two-character stretch must be a
 * non-hub token that appears in the title.
 */
async function seed(t) {
  const { store, scopes } = openTestStore(t);
  const fields = workspaceFields(scopes);
  store.write({ ...fields, kind: 'semantic', trustSource: 'user', title: '回滚窗口是三十分钟', body: '出问题后三十分钟内决定。' });
  store.write({ ...fields, kind: 'semantic', trustSource: 'user', title: '发布顺序是 staging 到 canary 到全量', body: '任何一步失败立刻停。' });
  store.write({ ...fields, kind: 'semantic', trustSource: 'user', title: '路径断言要先校验绝对路径', body: '断言之后才允许删除。' });
  return { store, scopes };
}

const run = async (store, scopes, query) =>
  search(store, { query, scopeKeys: [scopes.workspace], statuses: ['verified'], limit: 5, detail: 'snippet' });

test('a sentence with one unfamiliar word still finds the entry', async (t) => {
  const { store, scopes } = await seed(t);
  // 多久 appears in no entry; before the fix this returned nothing at all.
  const result = await run(store, scopes, '回滚窗口多久？');
  assert.equal(result.hits.length, 1);
  assert.match(result.hits[0].title, /回滚窗口/);
});

test('a short content word in the title is enough evidence', async (t) => {
  const { store, scopes } = await seed(t);
  // Coverage of a two-character span, which the old rule rejected outright.
  for (const query of ['我们什么时候回滚？', '断言应该放在哪里？']) {
    const result = await run(store, scopes, query);
    assert.equal(result.hits.length, 1, `${query} should find exactly one entry`);
  }
});

test('a two-character word that only appears in a body is not enough', async (t) => {
  const { store, scopes } = await seed(t);
  // 问题 is in the body of the rollback entry ("出问题后…") but in no title. Admitting on
  // it made completely unrelated questions return that entry.
  const result = await run(store, scopes, '完全无关的问题');
  assert.equal(result.hits.length, 0);
});

test('scattered words do not form an admission', async (t) => {
  const { store, scopes } = openTestStore(t);
  const fields = workspaceFields(scopes);
  // The case the original rule was written for: both words present, in unrelated clauses.
  store.write({
    ...fields,
    kind: 'semantic',
    trustSource: 'user',
    title: '杂项笔记',
    body: '先确认目录路径。另外断言库的版本要固定。',
  });
  const result = await run(store, scopes, '路径断言');
  // The run 路径断言 has bigrams 路径 / 径断 / 断言; 径断 is absent, so the longest
  // contiguous stretch is 2 characters and it is not in the title.
  assert.equal(result.hits.length, 0, 'two words in different clauses must not be read as one phrase');
});

test('unrelated questions stay empty', async (t) => {
  const { store, scopes } = await seed(t);
  for (const query of ['今天天气怎么样？', '中午吃什么好呢']) {
    const result = await run(store, scopes, query);
    assert.equal(result.hits.length, 0, `${query} shares nothing with any entry`);
  }
});
