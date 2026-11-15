import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, effectiveConfig } from '../../src/host/config.js';

const root = join(import.meta.dirname, '..', '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

/**
 * Two independent reviewers caught the same defect: the README and the threat
 * model both said "no network unless vectorMode is http", while `updateCheck`
 * defaulted to true and the panel's update route fetched the registry. The
 * default is now false, and these tests keep the prose and the code from drifting
 * apart again.
 */
test('the update check is off by default', () => {
  assert.equal(DEFAULTS.updateCheck, false);
  assert.equal(effectiveConfig({}).updateCheck, false);
});

test('both documented network paths are opt-in in the config schema', () => {
  assert.ok('updateCheck' in DEFAULTS, 'updateCheck must be a documented key');
  assert.ok('vectorMode' in DEFAULTS);
  assert.equal(DEFAULTS.vectorMode, 'off');
});

test('no source file fetches anything except the two opt-in modules', () => {
  // Grep the shipped surface: a new fetch/http call in a network-free module would
  // make the privacy page wrong again.
  const allowed = new Set(['src/host/update.js', 'src/host/store/embedding.js']);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const relative = path.slice(root.length + 1).split(sep).join('/');
      if (allowed.has(relative)) continue;
      const text = readFileSync(path, 'utf8');
      if (/\bglobalThis\.fetch\b|\bawait fetch\(|\bhttps?\.request\(|\bnode-fetch\b/.test(text)) offenders.push(relative);
    }
  };
  walk(join(root, 'src'));
  assert.deepEqual(offenders, [], `unexpected network code in: ${offenders.join(', ')}`);
});

test('the prose matches the code', () => {
  // The failure this guards against is a sentence, not a bug.
  assert.match(read('README.md'), /both off by default/i);
  assert.doesNotMatch(read('README.md'), /no network unless you configure/i);
  assert.match(read('docs/SECURITY.md'), /both off by default/i);
  assert.match(read('docs/PRIVACY.md'), /press "check for updates"/);
});
