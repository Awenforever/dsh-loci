import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * The plugin's own words must be English, and every label it asks for must exist.
 *
 * Two failures motivated this file:
 *   - The sidebar shipped a full Chinese dictionary, so a browser with a zh locale showed
 *     Chinese UI. The English dictionary was complete all along; the second dictionary was
 *     the only reason the product had a language.
 *   - A missing dictionary key renders as the raw key, which is invisible in review and
 *     obvious in production (`card.pendingHint` would have shown as that literal string).
 *
 * Chinese is allowed in this repository, and required in some places — `capture.js`
 * matches Chinese *input*, and the CJK tokenizer tests need Chinese *data*. What is not
 * allowed is Chinese that the plugin **emits**.
 */
const root = join(import.meta.dirname, '..', '..');
const clientPath = join(root, 'client.js');
const client = readFileSync(clientPath, 'utf8').replace(/\r\n/g, '\n');

const CJK = /[\u4e00-\u9fff]/;

test('client.js emits no Chinese', () => {
  const offenders = client
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => CJK.test(entry.line))
    .map((entry) => `${entry.number}: ${entry.line.trim().slice(0, 80)}`);
  assert.deepEqual(offenders, [], 'client.js must contain no Chinese text');
});

test('no zh locale dictionary is registered or shipped', () => {
  assert.doesNotMatch(client, /zh:\s*ZH/, 'the client must register English only');
  assert.doesNotMatch(client, /const ZH = \{/, 'the Chinese dictionary must not exist');
  assert.equal(existsSync(join(root, 'locale/zh.json')), false, 'locale/zh.json must be gone');
});

test('every label the client asks for exists in the English dictionary', () => {
  const block = client.slice(client.indexOf('const EN = {'), client.indexOf("'panel.version'"));
  const defined = new Set([...block.matchAll(/'([a-zA-Z][\w.]*)':/g)].map((match) => match[1]));
  // The panel tail is beyond the slice boundary, so collect the rest too.
  for (const match of client.matchAll(/^\s{6}'([a-zA-Z][\w.]*)':/gm)) defined.add(match[1]);

  const used = new Set([...client.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1]));
  const missing = [...used].filter((key) => !defined.has(key));
  assert.deepEqual(missing, [], 'every t() key must be defined');
});

test('the sidebar card reads like a card, not body copy', () => {
  // The card is the one surface a person sees without opening anything, so its shape is
  // part of the contract: a shadowed shell, a status dot and numeric metrics.
  assert.match(client, /\.loci-card-root \{[^}]*box-shadow/, 'the card needs a shadow to read as a card');
  assert.match(client, /\.loci-card-root \{[^}]*border-radius: 12px/, 'the card needs the shell radius');
  assert.match(client, /\.loci-card-metric-value/, 'the card must render numeric metrics');
  assert.match(client, /function VersionLabel/, 'the version chip must be its own component');
});
