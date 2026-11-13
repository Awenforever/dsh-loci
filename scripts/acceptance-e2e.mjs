#!/usr/bin/env node
/**
 * Acceptance measurements that need a real model.
 *
 * Two modes:
 *   --inject-cost   seed 0/20/50/100 verified entries and measure what each
 *                   request actually adds (bytes from the plugin, tokens from
 *                   the Harness's own `usage.inputTokens` delta).
 *   --recall        seed the 50-entry corpus, ask 50 single-point questions,
 *                   10 two-fact questions, and one broad "list everything"
 *                   question; score the answers.
 *
 * Both run against `DSH_HOME` + `DSH_BIN` from the environment and write a JSON
 * report. They are slow on purpose: every number is a real request.
 *
 * Usage: node scripts/acceptance-e2e.mjs --mode recall --profile headless --json report.json
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveConfig } from '../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../src/host/paths.js';
import { resolveScopes } from '../src/host/scope.js';
import { Store } from '../src/host/store/store.js';

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
};
const mode = flagValue('mode', 'recall');
const profile = flagValue('profile', 'headless');
const bin = process.env.DSH_BIN ?? 'dsh';
const home = resolveDshHome();
const jsonOut = flagValue('json');

/** Run one headless task (task over stdin). */
function runTask(task, timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
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
      reject(new Error(`timeout after ${timeoutMs}ms`));
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
      resolve({ code, out: out.trim(), err });
    });
  });
}

/** Open a write handle on the isolated store. */
function openStore() {
  const root = resolveMemoryRoot(home);
  const store = new Store({
    memoryRoot: root,
    paths: layout(root),
    config: effectiveConfig({ home }),
    pluginVersion: '1.0.0',
  });
  return { store, root };
}

/**
 * The 50-entry corpus: 16 rules, 17 conventions, 17 pitfalls.
 * Every entry has a unique keyword so an answer can be scored mechanically.
 */
import { CORPUS } from '../test/fixtures/corpus.mjs';

/** Question per entry keyword. */
function singleQuestion(entry) {
  return `根据长期记忆回答：${entry.title}这条约定的具体内容是什么？只给一句话，必须包含条目里的编号关键词。`;
}

/** Two-fact questions. */
const MULTI = [
  ['删除前要做什么，回滚窗口多长？'],
  ['迁移前要做什么，生产机能不能直接跑迁移？'],
  ['发布顺序是什么，失败了怎么办？'],
  ['密钥能不能进日志，怎么排查？'],
  ['批量删除怎么保证安全，路径怎么校验？'],
  ['数据库迁移前怎么备份，备份路径写在哪？'],
  ['空库时记忆层注入多少，召回会不会静默截断？'],
  ['插件怎么安装，安装后怎么验证？'],
  ['中文召回以前为什么坏，后来怎么修的？'],
  ['写入变慢的原因是什么，怎么解决的？'],
];

/** Seed the corpus as verified entries in the isolated store. */
function seedCorpus(store, key, count = CORPUS.length, offset = 0) {
  const scopes = resolveScopes({ sessionId: 'acceptance', cwd: process.cwd() });
  const now = Date.now();
  return store.writeMany(
    CORPUS.slice(offset, offset + count).map(([kind, title, body], index) => ({
      scope: 'workspace',
      scopeKey: scopes.workspace,
      scopeLabel: scopes.labels.workspace,
      kind,
      status: 'verified',
      trustSource: 'user',
      title,
      body,
      tags: [kind],
      entities: [],
      validFrom: now - index * 1000,
    })),
    { source: `acceptance-${key}` },
  );
}

const report = { mode, home, profile, startedAt: new Date().toISOString(), cases: [] };

if (mode === 'inject-cost') {
  const entriesByLevel = { 0: 0, 20: 20, 50: 50, 100: 100 };
  for (const [levelText, count] of Object.entries(entriesByLevel)) {
    const scratch = mkdtempSync(join(tmpdir(), 'loci-cost-home-'));
    void scratch;
    const { store } = openStore();
    if (count > 0) seedCorpus(store, `cost-${count}`).slice(count);
    const stats = store.stats();
    store.close();
    const run = await runTask('回答一个字：好');
    const reopened = openStore();
    const injections = reopened.store.recentInjections(5);
    const statsAfter = reopened.store.stats();
    reopened.store.close();
    report.cases.push({
      entriesRequested: count,
      entriesPresent: stats.heads,
      exit: run.code,
      lastInjection: statsAfter.lastInjection,
      injections: injections.slice(0, 2),
      answerHead: run.out.slice(0, 40),
    });
    console.log(`inject-cost ${levelText}: heads=${stats.heads} bytes=${statsAfter.lastInjection?.bytes ?? 'n/a'}`);
  }
}

if (mode === 'recall') {
  const { store } = openStore();
  const existing = store.stats().heads;
  if (existing < CORPUS.length) seedCorpus(store, 'recall');
  store.close();

  const single = [];
  for (const entry of CORPUS) {
    const keyword = (entry[2].match(/关键词 ([A-Z]{2}-\d{2})/) ?? [])[1] ?? '';
    const run = await runTask(singleQuestion({ title: entry[1] }));
    const hit = keyword.length > 0 && run.out.includes(keyword);
    single.push({ title: entry[1], keyword, hit, answer: run.out.slice(0, 160), exit: run.code });
    if (single.length % 10 === 0) console.log(`single ${single.length}/${CORPUS.length} · hits ${single.filter((item) => item.hit).length}`);
  }
  const singleHits = single.filter((item) => item.hit).length;

  const multi = [];
  for (const [question] of MULTI) {
    const run = await runTask(`${question} 只回答要点，不要解释。`);
    const tokens = CORPUS.filter((entry) => run.out.includes((entry[2].match(/关键词 ([A-Z]{2}-\d{2})/) ?? [])[1] ?? '###'));
    multi.push({ question, found: tokens.length, answer: run.out.slice(0, 200), exit: run.code });
    console.log(`multi ${multi.length}/${MULTI.length} · found ${tokens.length}`);
  }
  const multiOk = multi.filter((item) => item.found >= 2).length;

  const broadRun = await runTask('列出长期记忆里的全部约定，一条一行，能列多少列多少。');
  const broadKeywords = [...broadRun.out.matchAll(/[A-Z]{2}-\d{2}/g)].map((match) => match[0]);
  const broadUnique = new Set(broadKeywords).size;

  report.recall = {
    single: { total: single.length, hits: singleHits, rate: Number((singleHits / single.length).toFixed(3)), cases: single },
    multi: { total: multi.length, passed: multiOk, rate: Number((multiOk / multi.length).toFixed(3)), cases: multi },
    broad: { listed: broadUnique, expected: CORPUS.length, answer: broadRun.out.slice(0, 800) },
    thresholds: {
      single: singleHits / single.length >= 0.95,
      multi: multiOk / multi.length >= 0.9,
      broad: broadUnique >= CORPUS.length,
    },
  };
  console.log(`single ${singleHits}/${single.length} · multi ${multiOk}/${multi.length} · broad ${broadUnique}/${CORPUS.length}`);
  const allPass = report.recall.thresholds.single && report.recall.thresholds.multi && report.recall.thresholds.broad;
  report.pass = allPass;
  if (!allPass) process.exitCode = 1;
}

report.finishedAt = new Date().toISOString();
const text = JSON.stringify(report, null, 2);
if (jsonOut !== undefined) writeFileSync(jsonOut, `${text}\n`, 'utf8');
console.log(text.slice(0, 2000));
