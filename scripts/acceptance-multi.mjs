#!/usr/bin/env node
/**
 * Multi-fact and broad-list recall scoring.
 *
 * The single-point suite lives in `acceptance-e2e.mjs`; this script exists
 * because "did it answer a two-fact question" and "did it list everything"
 * cannot be scored by a single keyword. It keeps the full answers so the score
 * can be re-derived without another model call.
 *
 * Usage: node scripts/acceptance-multi.mjs --profile headless --json out.json
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
const jsonOut = flagValue('json', 'acceptance-multi.json');
const home = resolveDshHome();

function runTask(task, timeoutMs = 180_000) {
  return new Promise((resolve) => {
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
      resolve({ code: -1, out, err: `${err}\nTIMEOUT` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err });
    });
  });
}

/** Expected content, one group of acceptable phrasings per required fact. */
const MULTI = [
  { q: '删除前要做什么，回滚窗口多长？', groups: [['路径断言', '路径校验', '绝对路径'], ['30 分钟', '30分钟', '三十分钟']] },
  { q: '迁移前要做什么，生产机能不能直接跑迁移？', groups: [['pg_dump', '全量备份', '备份'], ['不能', '禁止', '不可以']] },
  { q: '发布顺序是什么，失败了怎么办？', groups: [['staging'], ['canary']] },
  { q: '密钥能不能进日志，怎么排查？', groups: [['不能', '不得', '禁止'], ['前缀', '前四位', '前 4 位']] },
  { q: '批量删除怎么保证安全，路径怎么校验？', groups: [['隔离区', 'dry-run', 'dry run'], ['白名单', '绝对路径']] },
  { q: '数据库迁移前怎么备份，备份路径写在哪？', groups: [['pg_dump'], ['发布记录']] },
  { q: '空库时记忆层注入多少，召回会不会静默截断？', groups: [['0 字节', '0字节', '零字节', '0 B'], ['不会', '禁止', '总数', '游标']] },
  { q: '插件怎么安装，安装后怎么验证？', groups: [['install_bundle', 'plugin'], ['验证', 'doctor', '面板', '设置']] },
  { q: '中文召回以前为什么坏，后来怎么修的？', groups: [['unicode61', '分词'], ['bigram', '二元']] },
  { q: '写入变慢的原因是什么，怎么解决的？', groups: [['bm25', '前缀查询', 'FTS'], ['进程内', '有限', '打分', '窗口']] },
];

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
  console.error(`expected the 50-entry corpus in ${home}, found ${heads}`);
  process.exit(2);
}

const report = { profile, home, multi: [], broad: undefined };

for (const item of MULTI) {
  const run = await runTask(`${item.q} 只回答要点，不要解释。`);
  const answer = run.out;
  const matched = item.groups.map((group) => group.some((needle) => answer.includes(needle)));
  report.multi.push({ question: item.q, exit: run.code, matched, pass: matched.every(Boolean), answer });
  console.log(`multi ${report.multi.length}/${MULTI.length} · ${matched.every(Boolean) ? 'PASS' : 'FAIL'} · ${item.q}`);
}

const broadRun = await runTask('列出长期记忆里的全部约定，一条一行，不要遗漏，能列多少列多少。', 300_000);
const broadAnswer = broadRun.out;
// Score by title presence: a listed line counts when it contains the entry title
// or at least its two most distinctive two-character fragments.
const titles = CORPUS.map((entry) => entry[1]);
const listed = titles.filter((title) => broadAnswer.includes(title));
const fuzzy = titles.filter((title) => {
  if (broadAnswer.includes(title)) return true;
  const fragments = title.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '').match(/.{1,4}/gu) ?? [];
  const useful = fragments.filter((fragment) => fragment.length >= 3).slice(0, 3);
  return useful.length > 0 && useful.every((fragment) => broadAnswer.includes(fragment));
});
report.broad = {
  exit: broadRun.code,
  listedExact: listed.length,
  listedFuzzy: fuzzy.length,
  expected: CORPUS.length,
  answer: broadAnswer,
  pass: fuzzy.length >= CORPUS.length,
};
console.log(`broad listed ${fuzzy.length}/${CORPUS.length} (exact ${listed.length})`);

report.multiPassed = report.multi.filter((item) => item.pass).length;
report.pass = report.multiPassed / report.multi.length >= 0.9 && report.broad.pass;
writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`multi ${report.multiPassed}/${report.multi.length} · broad ${fuzzy.length}/${CORPUS.length} · pass=${report.pass}`);
if (!report.pass) process.exitCode = 1;
