import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * The plugin emits English. Chinese is allowed only where it is *data being processed*.
 *
 * Two surfaces had Chinese that a user or a model would actually read:
 *   - the client dictionary (fixed: English only),
 *   - nothing else, as it turned out — but nothing prevented a future string from being
 *     added in Chinese, and a reviewer reading a diff does not notice a language switch.
 *
 * The allowlist below is deliberately narrow and each entry has a reason. Anything else
 * fails, which is the point: adding Chinese to an emitted string now requires editing this
 * list and explaining why.
 */
const root = join(import.meta.dirname, '..', '..');
const CJK = /[\u4e00-\u9fff]/;

/** Files where Chinese is input pattern data, not output. */
const PATTERN_DATA = new Set([
  // Matches Chinese sentences that announce a durable statement ("以后都用…", "禁止…").
  // Remove the Chinese and capture stops working for Chinese input.
  join('src', 'host', 'capture', 'capture.js'),
  // Matches Chinese secret shapes and Chinese prompt-injection phrasings — the text it
  // recognizes is hostile input, and it has to be spelled the way an attacker spells it.
  join('src', 'host', 'inject', 'sanitize.js'),
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      out.push(...walk(path));
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

test('source emits no Chinese outside the pattern-data allowlist', () => {
  const offenders = [];
  for (const file of walk(join(root, 'src'))) {
    const relative = file.slice(root.length + 1);
    if (PATTERN_DATA.has(relative)) continue;
    const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      // Comments are allowed to quote Chinese when explaining a Chinese pattern.
      if (!CJK.test(line) || /^(\/\/|\*|\/\*)/.test(trimmed)) return;
      offenders.push(`${relative}:${index + 1}: ${trimmed.slice(0, 100)}`);
    });
  }
  assert.deepEqual(offenders, [], 'only client-visible text matters, and it must be English');
});

test('the allowed pattern files still actually contain their patterns', () => {
  // A guard that silently allows a file is a guard that hides a deletion: if the Chinese
  // patterns were removed from capture.js, the allowlist would still pass and CJK capture
  // would be dead without a failing test.
  for (const relative of PATTERN_DATA) {
    const text = readFileSync(join(root, relative), 'utf8');
    assert.ok(CJK.test(text), `${relative} is allowlisted but no longer contains Chinese patterns`);
  }
});

test('the tool descriptions a model reads are English', () => {
  const tools = readFileSync(join(root, 'src', 'host', 'tools', 'tools.js'), 'utf8');
  for (const match of tools.matchAll(/description:\s*\n?\s*'([^']*)'/g)) {
    assert.equal(CJK.test(match[1]), false, `tool description is not English: ${match[1].slice(0, 60)}`);
  }
});

test('the injected section text is English', () => {
  const section = readFileSync(join(root, 'src', 'host', 'inject', 'index-section.js'), 'utf8');
  for (const match of section.matchAll(/'([^']*\s[^']*)'/g)) {
    const value = match[1];
    if (!CJK.test(value)) continue;
    assert.fail(`the injected section contains Chinese: ${value.slice(0, 80)}`);
  }
});
