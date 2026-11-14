import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const cli = join(root, 'scripts', 'cli.mjs');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Run the CLI and return stdout, tolerating the SQLite experimental warning. */
function run(args) {
  return execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  }).trim();
}

test('--version prints the manifest version and nothing else', () => {
  assert.equal(run(['--version']), manifest.version);
  assert.equal(run(['-v']), manifest.version);
  assert.equal(run(['version']), manifest.version);
});

test('flags stay position independent', () => {
  // The version flag must win over a command that follows it.
  assert.equal(run(['--version', 'doctor']), manifest.version);
});

test('help is still help', () => {
  assert.match(run(['help']), /dsh-loci <command>/);
});
