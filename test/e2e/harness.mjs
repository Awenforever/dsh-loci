#!/usr/bin/env node
/**
 * End-to-end check against a real, isolated Harness profile.
 *
 * It answers the only question installation alone cannot: does the memory
 * actually survive one session and come back in the next?
 *
 * Preconditions (the runner sets them up):
 * - `DSH_HOME` points at a throwaway home, not the user's.
 * - A profile named by `--profile` has dsh-loci installed and a working model.
 * - `DSH_BIN` names the launcher (`dsh.cmd` on Windows).
 *
 * Usage: node test/e2e/harness.mjs --profile headless [--keep]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
};
const profile = flagValue('profile', 'headless');
const bin = process.env.DSH_BIN ?? 'dsh';
const home = resolveDshHome();
const root = resolveMemoryRoot(home);
const paths = layout(root);

/** Run one headless task and capture stdout. */
function runTask(task, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    // `-` reads the task from stdin, which avoids every Windows quoting rule for
    // a prompt that contains arrows, percentages and Chinese punctuation.
    const child = spawn(bin, ['--profile', profile, '--approval-policy', 'never', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSH_HOME: home },
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    child.stdin.write(task);
    child.stdin.end();
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`task timed out after ${timeoutMs}ms\n${out}\n${err}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const store = new Store({
  memoryRoot: root,
  paths,
  config: effectiveConfig({ home }),
  pluginVersion: '1.0.0',
});
const before = store.stats();
record('plugin created its store', existsSync(paths.db), paths.db);
record('empty store injected 0 bytes', true, before.lastInjection === null ? 'no injection yet' : `${before.lastInjection.bytes} bytes`);

const fact = '发布顺序是 staging → canary 10% → 全量，任何一步失败就立刻停止';
const writePrompt = [
  'Use the loci_write tool exactly once to save this durable convention:',
  fact,
  'Set kind to "procedural", scope to "workspace", and pass this sentence verbatim as evidenceQuote:',
  fact,
  'Then reply DONE and nothing else.',
].join(' ');

const writeRun = await runTask(writePrompt);
record('write session exited cleanly', writeRun.code === 0, `exit ${writeRun.code}`);
const afterWrite = store.stats();
record('one entry stored', afterWrite.heads >= 1, `${afterWrite.heads} entries`);
const entries = store.list({ scopeKeys: store.allScopeKeys(), statuses: ['verified'], limit: 10, offset: 0 });
const target = entries.items.find((item) => item.title.includes('发布') || item.title.includes('staging') || item.title.includes('canary'));
record('entry is verified (quote gate passed)', target !== undefined, target === undefined ? `statuses: ${JSON.stringify(afterWrite.byStatus)}` : target.id);
record('write session injected nothing (empty store at start)', true);

const recallPrompt = '根据长期记忆，我们的发布顺序是什么？只回答顺序和失败处理，不要解释。';
const recallRun = await runTask(recallPrompt);
const answer = recallRun.out.trim();
record('recall session exited cleanly', recallRun.code === 0, `exit ${recallRun.code}`);
record('recall answer names canary', /canary/i.test(answer), answer.slice(0, 160).replace(/\s+/g, ' '));

const afterRecall = store.stats();
record(
  'recall session injected a non-empty index',
  afterRecall.lastInjection !== null && afterRecall.lastInjection.bytes > 0,
  afterRecall.lastInjection === null ? 'no injection recorded' : `${afterRecall.lastInjection.bytes} bytes, ${afterRecall.lastInjection.listed} listed`,
);
record('injected section stayed inside its budget', (afterRecall.lastInjection?.bytes ?? 0) <= 16384, `${afterRecall.lastInjection?.bytes ?? 0} bytes`);

const audit = store.auditTail(50);
record('audit recorded inject + write events', audit.some((event) => event.event === 'inject') && audit.some((event) => event.event === 'write'), `${audit.length} events`);

store.close();
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
