#!/usr/bin/env node
/**
 * Install → resume → uninstall lifecycle in one isolated Harness home.
 *
 * The compatibility matrix claims these steps work; this script makes the claim
 * checkable instead of narrated. It never touches the user's own profile: the
 * caller supplies a throwaway `DSH_HOME`.
 *
 * Usage:
 *   DSH_BIN=<launcher> DSH_HOME=<temp home> node test/e2e/lifecycle.mjs --profile headless
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
const tarball = flagValue('tarball');
const bin = process.env.DSH_BIN ?? 'dsh';
const home = resolveDshHome();
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
};

/** Run the launcher and capture stdout/stderr. */
function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSH_HOME: home },
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    } else child.stdin.end();
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout: ${args.join(' ')}`));
    }, 240_000);
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
      resolve({ code, out: out.trim(), err });
    });
  });
}

const store = () =>
  new Store({
    memoryRoot: resolveMemoryRoot(home),
    paths: layout(resolveMemoryRoot(home)),
    config: effectiveConfig({ home }),
    pluginVersion: '1.0.0',
  });

// 1. Installed and composed.
const profileDir = join(home, 'profiles', profile);
const manifestPath = join(profileDir, 'package.json');
record('profile exists', existsSync(manifestPath), profileDir);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
record('bundle is selected in the profile', (manifest.dsh?.profile?.bundles ?? []).includes('dsh-loci'));
const dump = spawnSync(bin, ['--profile', profile, '--dump-config'], { encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, DSH_HOME: home } });
record('composed config contains the row', (dump.stdout ?? '').includes('dsh-loci'), `exit ${dump.status}`);

// 2. A session writes a fact through the model, then a new session resumes it.
const fact = '本项目的回滚窗口是 30 分钟，超过必须人工决策 RB-42';
const write = await run(
  ['--profile', profile, '--approval-policy', 'never', '-'],
  `Use the loci_write tool once to save this durable convention verbatim as evidence: ${fact} Then reply DONE.`,
);
record('write session exits cleanly', write.code === 0, write.out.slice(0, 60));

const afterWrite = store();
const heads = afterWrite.stats().heads;
const sessions = afterWrite.db.prepare('SELECT DISTINCT source_session AS s FROM memory WHERE source_session IS NOT NULL').all();
afterWrite.close();
record('a session id was recorded as the source', sessions.length > 0, `${heads} entries · ${sessions[0]?.s ?? 'none'}`);

// 3. Resume *the same* session id explicitly.
const sourceSession = sessions[0]?.s;
if (sourceSession !== undefined) {
  const resume = await run(['--profile', profile, '--session-id', sourceSession, '--approval-policy', 'never', '继续']);
  record('resuming the recorded session id succeeds', resume.code === 0, resume.err.split('\n').at(-1)?.slice(0, 80));
} else {
  record('resuming the recorded session id succeeds', false, 'no source session recorded');
}

// 4. Uninstall: the bundle leaves the profile, the data stays.
const remove = await run(['plugin', '--profile', profile, 'remove', 'dsh-loci']);
record('uninstall command succeeds', remove.code === 0, (remove.err || remove.out).split('\n').at(-1)?.slice(0, 80));
const afterRemove = JSON.parse(readFileSync(manifestPath, 'utf8'));
record('bundle no longer selected', !(afterRemove.dsh?.profile?.bundles ?? []).includes('dsh-loci'));
record('data directory survives the uninstall', existsSync(join(resolveMemoryRoot(home), 'memory.db')));
const dump2 = spawnSync(bin, ['--profile', profile, '--dump-config'], { encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, DSH_HOME: home } });
record('composed config no longer contains the row', !(dump2.stdout ?? '').includes('dsh-loci'));

// 5. Reinstall and confirm the stored fact is still there.
const reinstall = await run(['plugin', '--profile', profile, 'add', tarball]);
record('reinstall succeeds', reinstall.code === 0, (reinstall.err || reinstall.out).split('\n').at(-1)?.slice(0, 80));
const reopened = store();
const kept = reopened.stats().heads;
reopened.close();
record('memory survived uninstall + reinstall', kept >= heads, `${kept} entries`);

const failed = results.filter((entry) => !entry.pass);
console.log(`\n${results.length - failed.length}/${results.length} lifecycle checks passed`);
if (failed.length > 0) process.exitCode = 1;
