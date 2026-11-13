#!/usr/bin/env node
/**
 * Broad-list recall: can the model enumerate the whole store?
 *
 * This is the one acceptance question that measures behaviour rather than
 * retrieval: the tool can page, and the question is whether the model pages.
 * The prompt says so explicitly; the score counts how many corpus titles the
 * answer contains.
 *
 * Usage: node scripts/acceptance-broad.mjs --profile headless --json out.json
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { effectiveConfig } from '../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../src/host/paths.js';
import { Store } from '../src/host/store/store.js';
import { CORPUS } from '../test/fixtures/corpus.mjs';

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
};
const profile = flagValue('profile', 'headless');
const bin = process.env.DSH_BIN ?? 'dsh';
const jsonOut = flagValue('json', 'acceptance-broad.json');
const home = resolveDshHome();

const store = new Store({
  memoryRoot: resolveMemoryRoot(home),
  paths: layout(resolveMemoryRoot(home)),
  config: effectiveConfig({ home }),
  pluginVersion: '1.0.0',
  readOnly: true,
});
const heads = store.stats().heads;
store.close();
if (heads < CORPUS.length) {
  console.error(`expected the corpus in ${home}, found ${heads}`);
  process.exit(2);
}

const PROMPT = [
  '列出长期记忆里的全部条目，包括 rule、procedural、episodic 三种类型。',
  '必须使用 loci_search：limit 设为 50；如果返回 hasMore=true，就用返回的 cursor 继续调用，直到 hasMore=false。',
  '一条一行，只写标题，不要省略，不要解释。',
].join(' ');

const child = spawn(bin, ['--profile', profile, '--approval-policy', 'never', '-'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home },
  windowsHide: true,
  shell: process.platform === 'win32',
});
child.stdin.write(PROMPT);
child.stdin.end();
let out = '';
let err = '';
child.stdout.on('data', (chunk) => {
  out += chunk.toString('utf8');
});
child.stderr.on('data', (chunk) => {
  err += chunk.toString('utf8');
});
const code = await new Promise((resolve) => child.on('close', resolve));

const answer = out.trim();
const titles = CORPUS.map((entry) => entry[1]);
const exact = titles.filter((title) => answer.includes(title));
const fuzzy = titles.filter((title) => {
  if (answer.includes(title)) return true;
  const fragments = (title.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '').match(/.{1,4}/gu) ?? []).filter((fragment) => fragment.length >= 3);
  return fragments.length > 0 && fragments.slice(0, 3).every((fragment) => answer.includes(fragment));
});

const report = {
  profile,
  home,
  exit: code,
  expected: CORPUS.length,
  listedExact: exact.length,
  listedFuzzy: fuzzy.length,
  pass: fuzzy.length >= CORPUS.length,
  missing: titles.filter((title) => !fuzzy.includes(title)).slice(0, 10),
  stderrHead: err.slice(0, 400),
  answer,
};
writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`broad listed ${fuzzy.length}/${CORPUS.length} (exact ${exact.length}) · exit ${code}`);
if (!report.pass) process.exitCode = 1;
