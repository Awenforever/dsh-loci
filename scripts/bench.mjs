#!/usr/bin/env node
/**
 * Retrieval benchmark: seed N entries, time M queries, print a JSON report.
 *
 * The threshold this script exists to prove is p95 < 200 ms at 10k entries
 * with the default settings (lexical + entity fusion, vectors off).
 *
 * Usage: node scripts/bench.mjs [--entries 10000] [--queries 200] [--json out.json]
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveConfig } from '../src/host/config.js';
import { ensureMemoryRoot, layout } from '../src/host/paths.js';
import { renderIndexBody } from '../src/host/inject/index-section.js';
import { resolveScopes } from '../src/host/scope.js';
import { search } from '../src/host/store/search.js';
import { Store } from '../src/host/store/store.js';
import { DEFAULTS } from '../src/host/config.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? Number(argv[index + 1]) : fallback;
};
const ENTRIES = Math.max(10, arg('entries', 10000));
const QUERIES = Math.max(10, arg('queries', 200));
const outIndex = argv.indexOf('--json');
const OUT = outIndex >= 0 ? argv[outIndex + 1] : undefined;

/** Deterministic PRNG so two runs compare. */
let seed = 0x2f6e2b1;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};
const pick = (list) => list[Math.floor(random() * list.length)];

const SUBJECTS = ['发布流程', '数据库迁移', '路径断言', '日志脱敏', '回滚窗口', '缓存失效', '并发写入', '权限策略', '备份校验', '索引重建', '会话隔离', '压缩阈值'];
const VERBS = ['必须先', '禁止直接', '应当在', '需要先', '不得在', '只能在'];
const OBJECTS = ['staging 演练', '生产机 prod-01', '白名单根目录', 'pg_dump 全量备份', 'canary 10% 灰度', '受控脚本 dry-run', 'journal 文件', '人工决策', '30 分钟窗口', '幂等重试'];
const LATIN = ['pnpm', 'sqlite', 'busy_timeout', 'WAL', 'FTS5', 'window', 'journal', 'canary', 'staging', 'rollback'];

function makeEntry(i) {
  const subject = pick(SUBJECTS);
  const verb = pick(VERBS);
  const object = pick(OBJECTS);
  const latin = pick(LATIN);
  return {
    kind: pick(['semantic', 'procedural', 'rule', 'episodic']),
    title: `${subject}约定 ${i % 977}`,
    body: `${subject}：${verb}${object}；相关工具 ${latin}。第 ${i} 条用来压测检索与渲染路径，内容长度接近真实条目。`,
    tags: [subject, latin],
    entities: [subject, latin],
  };
}

const home = mkdtempSync(join(tmpdir(), 'loci-bench-'));
const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
const paths = layout(root);
const scopes = resolveScopes({ sessionId: 'bench', cwd: home });
const store = new Store({ memoryRoot: root, paths, config: effectiveConfig({}), pluginVersion: '1.0.0' });

try {
  const seedStart = performance.now();
  // Seeding uses the bulk path: the benchmark measures retrieval, and a
  // per-row duplicate search would spend three minutes proving nothing about it.
  const CHUNK = 1000;
  for (let start = 0; start < ENTRIES; start += CHUNK) {
    const chunk = [];
    for (let i = start; i < Math.min(ENTRIES, start + CHUNK); i += 1) {
      const entry = makeEntry(i);
      chunk.push({
        scope: 'workspace',
        scopeKey: scopes.workspace,
        scopeLabel: scopes.labels.workspace,
        kind: entry.kind,
        status: 'verified',
        trustSource: 'user',
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
        entities: entry.entities,
      });
    }
    store.writeMany(chunk, { source: 'bench' });
  }
  const seedMs = performance.now() - seedStart;

  const queries = [];
  for (let i = 0; i < QUERIES; i += 1) {
    const subject = pick(SUBJECTS);
    const mode = i % 3;
    if (mode === 0) queries.push(subject.slice(0, 2));
    else if (mode === 1) queries.push(`${subject.slice(0, 2)}约定`);
    else queries.push(pick(LATIN));
  }

  const timings = [];
  let totalHits = 0;
  for (const query of queries) {
    const started = performance.now();
    const result = await search(store, {
      query,
      scopeKeys: [scopes.workspace],
      statuses: ['verified'],
      limit: 10,
      detail: 'snippet',
      channel: store.embedding,
    });
    timings.push(performance.now() - started);
    totalHits += result.total;
  }
  const sorted = [...timings].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

  const renderTimings = [];
  for (let i = 0; i < 20; i += 1) {
    const started = performance.now();
    renderIndexBody({
      store,
      scopeKeys: [scopes.workspace],
      scopeLabel: 'workspace:bench',
      config: (key) => DEFAULTS[key],
      now: Date.now(),
    });
    renderTimings.push(performance.now() - started);
  }
  const renderSorted = [...renderTimings].sort((a, b) => a - b);

  const report = {
    entries: ENTRIES,
    queries: QUERIES,
    seedMs: Number(seedMs.toFixed(1)),
    retrievalMs: {
      p50: Number(at(50).toFixed(2)),
      p90: Number(at(90).toFixed(2)),
      p95: Number(at(95).toFixed(2)),
      p99: Number(at(99).toFixed(2)),
      max: Number(sorted.at(-1).toFixed(2)),
    },
    injectionRenderMs: {
      p50: Number(renderSorted[Math.floor(renderSorted.length / 2)].toFixed(2)),
      p95: Number(renderSorted[Math.floor(renderSorted.length * 0.95)].toFixed(2)),
    },
    averageTotal: Number((totalHits / QUERIES).toFixed(1)),
    indexCoverage: store.indexCoverage(),
    dbBytes: store.health().dbBytes,
    threshold: { p95Ms: 200, pass: at(95) < 200 },
  };
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (OUT !== undefined) writeFileSync(OUT, `${text}\n`, 'utf8');
  process.exitCode = report.threshold.pass ? 0 : 1;
} finally {
  store.close();
  rmSync(home, { recursive: true, force: true });
}
