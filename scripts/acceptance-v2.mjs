#!/usr/bin/env node
/**
 * Acceptance v2 — retrieval and cost, measured on the shipped code.
 *
 * Why v2 exists: the v1.0.0 harness had three defects that made its numbers
 * uninterpretable, and they are fixed here rather than inherited.
 *
 *   1. **The question contained the entry title verbatim**
 *      (`根据长期记忆回答：${entry.title}...`). The title is exactly what the index
 *      lists, so the run measured "can the tool find an entry when the question names
 *      it". Here every question avoids the title and the answer, so the only way to
 *      succeed is genuine retrieval.
 *   2. **The scratch home was created and discarded** (`const scratch = mkdtemp…;
 *      void scratch;`) and `seedCorpus(...).slice(count)` does not limit seeding, so a
 *      "20 entries" row could report 51 present. Here each level gets its own home and
 *      the seed count is asserted.
 *   3. **The corpus lived inside the agent's readable workspace**. Here the corpus is
 *      generated in memory, seeded straight into a throwaway store, and never written
 *      anywhere the model could read — so a future answer-quality run cannot cheat by
 *      reading the fixture.
 *
 * What this script does NOT measure: whether memory makes the model answer better. That
 * needs a real Host session with the model in the loop, which requires the `dsh`
 * launcher; see `docs/ACCEPTANCE.md` for the arm design and the current blocker.
 *
 * Usage:
 *   node scripts/acceptance-v2.mjs [--json]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveConfig } from '../src/host/config.js';
import { ensureMemoryRoot, layout } from '../src/host/paths.js';
import { resolveScopes } from '../src/host/scope.js';
import { Store } from '../src/host/store/store.js';
import { search } from '../src/host/store/search.js';
import { renderIndexBody } from '../src/host/inject/index-section.js';

const asJson = process.argv.includes('--json');

/**
 * Thirty facts, written for this run and used nowhere else.
 *
 * Each row: `question` never contains `title` or `answer`, so a hit means the retrieval
 * layer found it rather than the prompt naming it. `answer` is the discriminating
 * token a scorer looks for downstream.
 */
const FACTS = [
  { title: '发布窗口固定在周四凌晨两点', question: '我们每周哪个时间段可以做上线？', answer: '周四凌晨两点' },
  { title: '回滚窗口是三十分钟', question: '出问题后多久必须做出人工决定？', answer: '三十分钟' },
  { title: '生产机禁止直接跑迁移脚本', question: '线上环境里哪类脚本不许直接执行？', answer: '迁移脚本' },
  { title: '数据库备份保留十四天', question: '快照会被保留多长时间？', answer: '十四天' },
  { title: '日志脱敏保留前四位', question: '敏感字段打印时怎么处理？', answer: '前四位' },
  { title: '分支命名用斜杠分层', question: '仓库里分支名怎么组织层级？', answer: '斜杠' },
  { title: '测试必须能离线运行', question: '单元用例对网络有什么要求？', answer: '离线' },
  { title: '配置文件不放仓库', question: '带密钥的配置该放哪里？', answer: '不放仓库' },
  { title: '告警只在工作时间电话通知', question: '夜间出问题怎么联系值班？', answer: '工作时间' },
  { title: '灰度先放百分之一流量', question: '新版本上线初始比例是多少？', answer: '百分之一' },
  { title: '接口变更要保留旧版本三个月', question: '老客户端能继续用多久？', answer: '三个月' },
  { title: '依赖升级每季度集中做一次', question: '第三方库多久统一升一遍？', answer: '每季度' },
  { title: '代码评审至少两人通过', question: '合并前需要几个人点头？', answer: '两人' },
  { title: '构建产物保留最近五个', question: 'CI 里旧包留存多少？', answer: '五个' },
  { title: '时区统一用东八区', question: '时间戳按哪个时区记录？', answer: '东八区' },
  { title: '错误码段位按模块划分', question: '异常编号怎么分配区间？', answer: '按模块' },
  { title: '缓存失效用主动推送', question: '缓存什么时候失效？', answer: '主动推送' },
  { title: '上传限制单文件五百兆', question: '单个附件最大多少？', answer: '五百兆' },
  { title: '会话超时是两小时', question: '登录状态能维持多久？', answer: '两小时' },
  { title: '任务队列优先级分三档', question: '后台作业的优先顺序有几级？', answer: '三档' },
  { title: '健康检查走独立端口', question: '探活接口占用哪个端口？', answer: '独立端口' },
  { title: '证书到期前三十天续期', question: 'TLS 证书什么时候更换？', answer: '三十天' },
  { title: '慢查询阈值设为两百毫秒', question: '多慢的语句会被记录？', answer: '两百毫秒' },
  { title: '冷数据归档到对象存储', question: '长期不访问的记录去哪？', answer: '对象存储' },
  { title: '发布说明必须写影响面', question: '变更记录里必须包含什么？', answer: '影响面' },
  { title: '回滚演练每半年一次', question: '撤销训练多久组织一回？', answer: '半年' },
  { title: '鉴权令牌有效期十五分钟', question: '访问凭证多久过期？', answer: '十五分钟' },
  { title: '批量任务分片上限一百', question: '一个大作业切成多少份？', answer: '一百' },
  { title: '监控保留原始指标七天', question: '原始时序数据存多久？', answer: '七天' },
  { title: '生产变更需要双人复核', question: '动线上配置要几个人确认？', answer: '双人' },
];

const reader = (overrides = {}) => {
  const values = { ...effectiveConfig(overrides), ...overrides };
  return (key) => values[key];
};

/** Open a throwaway store holding the first `count` facts as verified entries. */
function seedStore(count, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'loci-acc2-'));
  const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({ home }), pluginVersion: '2.6.0' });
  const scopes = resolveScopes({ sessionId: 'acceptance-v2', cwd: home });
  for (const fact of FACTS.slice(0, count)) {
    store.write({
      scope: 'workspace',
      scopeKey: scopes.workspace,
      scopeLabel: scopes.labels.workspace,
      kind: 'semantic',
      trustSource: 'user',
      title: fact.title,
      body: `${fact.title}。这条记录用来说明约束：${fact.answer}。`,
    });
  }
  const present = store.db.prepare('SELECT COUNT(*) AS n FROM memory_head').get().n;
  if (Number(present) !== count) throw new Error(`seeded ${present}, expected ${count}`);
  return { store, home, scopes };
}

/** Run retrieval over every fact and record where the target landed. */
async function measureRetrieval() {
  const { store, home, scopes } = seedStore(FACTS.length);
  const rows = [];
  try {
    const section = renderIndexBody({
      store,
      scopeKeys: [scopes.workspace],
      scopeLabel: scopes.labels.workspace,
      config: reader(),
    });
    for (const fact of FACTS) {
      const result = await search(store, {
        query: fact.question,
        scopeKeys: [scopes.workspace],
        statuses: ['verified'],
        limit: 5,
        detail: 'snippet',
      });
      const rank = result.hits.findIndex((hit) => hit.title === fact.title);
      rows.push({
        question: fact.question,
        target: fact.title,
        rank: rank < 0 ? null : rank + 1,
        inSection: section.text.includes(fact.title.slice(0, 12)),
      });
    }
    return { rows, sectionBytes: section.bytes, listed: section.listed, total: section.total };
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/** Section bytes at several store sizes, each in its own home. */
function measureCost() {
  const levels = [];
  for (const count of [0, 10, 30]) {
    const { store, home, scopes } = seedStore(count);
    try {
      const rendered = renderIndexBody({
        store,
        scopeKeys: [scopes.workspace],
        scopeLabel: scopes.labels.workspace,
        config: reader(),
      });
      levels.push({ entries: count, bytes: rendered.bytes, listed: rendered.listed, total: rendered.total });
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
  return levels;
}

/**
 * Does the index carry enough information for a model to pick ONE entry out of many?
 *
 * The first version of this experiment asked twelve questions against twelve summary
 * titles, saw twelve fetches, and concluded the model over-fetches. That was wrong: twelve
 * questions about twelve entries need twelve bodies. The fair version is one question
 * against many candidates. These numbers are what a future re-run should compare against
 * (see `docs/ACCEPTANCE.md` B.4 for the measured arms).
 */
function measureIndexSelectivity() {
  const caseSingle = [{ title: '发布窗口固定在每周固定时段', relevant: true }];
  for (let i = 0; i < 39; i += 1) {
    caseSingle.push({ title: FACTS[i].title, relevant: false });
  }
  return {
    note: 'measured with blind model arms; see docs/ACCEPTANCE.md B.4',
    oneQuestionManyCandidates: { candidates: caseSingle.length, expected: 1 },
    oneQuestionNothingRelevant: { candidates: caseSingle.length, expected: 0 },
  };
}

const retrieval = await measureRetrieval();
const cost = measureCost();

const top1 = retrieval.rows.filter((row) => row.rank === 1).length;
const top3 = retrieval.rows.filter((row) => row.rank !== null && row.rank <= 3).length;
const missed = retrieval.rows.filter((row) => row.rank === null);
// The index and the search are two different channels and conflating them is what made
// the v1.0.0 number meaningless. The index is what the model reads every request; the
// search is only used when somebody calls a tool. A paraphrase with no shared tokens
// fails the second channel and is still present in the first.
const inIndex = retrieval.rows.filter((row) => row.inSection).length;
const summary = {
  version: '2.6.0',
  corpus: FACTS.length,
  retrieval: {
    top1,
    top3,
    missed: missed.length,
    inIndex,
    top1Rate: Number((top1 / FACTS.length).toFixed(3)),
    top3Rate: Number((top3 / FACTS.length).toFixed(3)),
    indexRate: Number((inIndex / FACTS.length).toFixed(3)),
  },
  index: { bytes: retrieval.sectionBytes, listed: retrieval.listed, total: retrieval.total },
  cost,
  misses: missed.map((row) => ({ question: row.question, target: row.target })),
};

if (asJson) {
  console.log(JSON.stringify({ ...summary, rows: retrieval.rows }, null, 2));
} else {
  console.log(`corpus       ${summary.corpus} facts, questions never contain the title or the answer`);
  console.log(`channel A    lexical search · top-1 ${top1}/${FACTS.length} · top-3 ${top3}/${FACTS.length} · missed ${missed.length}`);
  console.log(`channel B    injected index · target present ${inIndex}/${FACTS.length} (${(summary.retrieval.indexRate * 100).toFixed(1)}%)`);
  console.log('');
  console.log('Read this as two channels, not one score. Channel A is what a tool call sees;');
  console.log('channel B is what the model reads on every request. A paraphrase with no shared');
  console.log('tokens fails A every time and is still present in B — which is the whole reason');
  console.log('the index exists and search is not the primary path.');
  console.log(`index        ${retrieval.sectionBytes} B, ${retrieval.listed}/${retrieval.total} listed`);
  console.log('cost         ' + cost.map((level) => `${level.entries}→${level.bytes}B`).join(' · '));
  if (missed.length > 0) {
    console.log('misses       ' + missed.map((row) => `"${row.question}" → ${row.target}`).join(' | '));
  }
  console.log('');
  console.log('NOT measured here: whether memory improves answers. That needs a Host session');
  console.log('with the model in the loop (`dsh --profile headless`), which this machine lacks.');
}
