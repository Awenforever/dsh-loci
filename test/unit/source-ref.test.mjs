import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareForStorage } from '../../src/host/inject/sanitize.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * A citation is only worth storing if it survives the whole path: write → store →
 * panel → export → get. These tests follow one `sourceRef` through all of them.
 */
test('a sourceRef is stored with the entry and readable back', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = store.write({
    ...workspaceFields(scopes),
    kind: 'rule',
    trustSource: 'user',
    title: '删除前必须做路径断言',
    body: '任何删除之前先校验绝对路径。',
    sourceRef: 'src/host/paths.js:59',
  });

  assert.equal(written.entry.sourceRef, 'src/host/paths.js:59');
  const fetched = store.get(written.entry.id).entry;
  assert.equal(fetched.sourceRef, 'src/host/paths.js:59');
  // Provenance lives with the evidence, next to the quote, not in a new column.
  assert.equal(fetched.evidence.ref, 'src/host/paths.js:59');
});

test('an entry without a citation reports null, not an empty string', (t) => {
  const { store, scopes } = openTestStore(t);
  const written = store.write({
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '没有出处的一条',
    body: '这条没有 sourceRef。',
  });
  assert.equal(written.entry.sourceRef, null);
});

test('a citation is flattened and capped like every other free-text field', () => {
  const prepared = prepareForStorage(
    { title: 't', body: 'b', sourceRef: `src/a.js:1${'\n'.repeat(3)}src/b.js:2` },
    { secretPolicy: 'redact' },
  );
  assert.equal(prepared.evidence.ref, 'src/a.js:1\n\n\nsrc/b.js:2'.replace(/\n{4,}/g, '\n\n\n').trim().replace(/\n/g, '\n'));
  const long = prepareForStorage({ title: 't', body: 'b', sourceRef: 'x'.repeat(400) }, { secretPolicy: 'redact' });
  assert.ok(long.evidence.ref.length <= 160, 'the citation is capped');
});

test('a citation carrying a secret is dropped, not stored', () => {
  const prepared = prepareForStorage(
    { title: 't', body: 'b', sourceRef: 'deploy.sh:12 sk-abcdefghijklmnopqrstuvwx' },
    { secretPolicy: 'redact' },
  );
  assert.equal('ref' in prepared.evidence, false, 'a ref that trips the scanner is not kept');
  assert.ok(prepared.redactions.includes('openai-key'));
});

test('a citation keeps the entry out of the prompt, as before', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'tool',
    title: '模型自己写的',
    body: '没有逐字证据。',
    sourceRef: 'src/host/store.js:1',
  });
  // The citation is provenance; it does not raise trust.
  const entries = store.indexEntries({ scopeKeys: [scopes.workspace] });
  assert.equal(entries.length, 0);
});
