import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * The plugin emits English; Chinese is allowed only where it is data being processed.
 *
 * One test file, not five. The failure this prevents is concrete: the client shipped a
 * `ZH` dictionary, so a browser whose locale resolved to zh rendered the whole UI in
 * Chinese while the English dictionary was already complete. Chinese that the plugin
 * *emits* was the problem; Chinese that it *matches* is a feature.
 */
const root = join(import.meta.dirname, '..', '..');
const CJK = /[\u4e00-\u9fff]/;

/** Files where Chinese is input pattern data, not output. */
const PATTERN_DATA = new Set([
  join('src', 'host', 'capture', 'capture.js'), // matches Chinese statements in the input
  join('src', 'host', 'inject', 'sanitize.js'), // matches Chinese injection/secret shapes
  // The curator probe carries a fixed synthetic transcript: it stands in for what a user said,
  // and the whole point of that transcript is that it is the phrasing the rule extractor misses
  // — which, for this product's actual users, is Chinese.
  join('src', 'host', 'record', 'probe.js'),
]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') return [];
      return walk(path);
    }
    return /\.(js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

test('the client ships one language and no Chinese', () => {
  const client = readFileSync(join(root, 'client.js'), 'utf8').replace(/\r\n/g, '\n');
  const offenders = client
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => CJK.test(entry.line))
    .map((entry) => `${entry.number}: ${entry.line.trim().slice(0, 80)}`);
  assert.deepEqual(offenders, []);
  assert.equal(existsSync(join(root, 'locale/zh.json')), false, 'locale/zh.json must not exist');
  assert.doesNotMatch(client, /const ZH = \{/, 'the Chinese dictionary must not exist');
  // Every label the client asks for must exist, or the UI shows the raw key.
  const defined = new Set([...client.matchAll(/^\s{6}'([a-zA-Z][\w.]*)':/gm)].map((match) => match[1]));
  const missing = [...new Set([...client.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1]))].filter(
    (key) => !defined.has(key),
  );
  assert.deepEqual(missing, [], 'every t() key must be defined');
});

test('source emits no Chinese outside the pattern-data allowlist', () => {
  const offenders = [];
  for (const file of walk(join(root, 'src'))) {
    const relative = file.slice(root.length + 1);
    if (PATTERN_DATA.has(relative)) continue;
    readFileSync(file, 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .forEach((line, index) => {
        const trimmed = line.trim();
        if (!CJK.test(line) || /^(\/\/|\*|\/\*)/.test(trimmed)) return;
        offenders.push(`${relative}:${index + 1}: ${trimmed.slice(0, 100)}`);
      });
  }
  assert.deepEqual(offenders, []);
  // A guard that silently allows a file would hide the deletion it exists to catch.
  for (const relative of PATTERN_DATA) {
    assert.ok(CJK.test(readFileSync(join(root, relative), 'utf8')), `${relative} lost its patterns`);
  }
});
