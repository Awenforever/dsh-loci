#!/usr/bin/env node
/**
 * Measure the two halves of memory separately: 记 (record) and 忆 (recall).
 *
 * The product's philosophy is that memory is both halves and neither alone is memory: a store
 * that records well but cannot surface the right line at the right moment is an archive, and a
 * retrieval layer over an empty or wrong corpus is a search engine. Previous releases measured
 * storage and UI; this measures whether the thing does what it is named after.
 *
 * Three measurements, deliberately kept apart so a bad result points at one half:
 *
 *   A. 忆 at scale — for a store of N facts, does the injected section contain the target, does
 *      `search` rank it first, and how many bytes of the section are actually about the current
 *      question. The last number is the one that matters: a static index spends the same bytes
 *      on every question, so its cost is fixed and its relevance falls as the store grows.
 *   B. 记 by rules — synthetic transcripts with a known ground-truth set of durable statements,
 *      run through the rule-based capture. Precision and recall say whether rules can carry
 *      this half or whether it needs a model, which is the operator's hypothesis.
 *   C. The gate — how many human approvals stand between "stored" and "injectable". This is the
 *      number that made the live store freeze.
 *
 * What this does NOT measure: whether an answer built on the retrieved memory is better. That
 * needs a model in the loop and is the next stage; this harness establishes the baseline it
 * will be compared against.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveConfig } from '../src/host/config.js';
import { renderIndexBody } from '../src/host/inject/index-section.js';
import { ensureMemoryRoot, layout } from '../src/host/paths.js';
import { resolveScopes } from '../src/host/scope.js';
import { Capture } from '../src/host/capture/capture.js';
import { Store } from '../src/host/store/store.js';
import { search } from '../src/host/store/search.js';
import { composeRecall } from '../src/host/recall/compose.js';
import { prefilter } from '../src/host/record/curator.js';
import { tokenize, bigramJaccard } from '../src/host/store/tokenize.js';

const asJson = process.argv.includes('--json');

/** Topics are the only token a question and its fact may share. */
const TOPICS = [
  'atlas', 'beacon', 'cipher', 'delta', 'ember', 'forge', 'garnet', 'harbor',
  'iris', 'juniper', 'kelp', 'lantern', 'marlin', 'nimbus', 'onyx', 'pilot',
  'quartz', 'raven', 'sable', 'tundra', 'umber', 'violet', 'willow', 'xenon',
];

/**
 * One fact shape.
 *
 * `hard` is a paraphrase that shares only the topic name with the fact — the case where a
 * person asks about the consequence without reusing any of the words the fact was written in.
 * `natural` reuses the content words, which is how people usually talk about something they
 * have discussed before. Measuring only the first made retrieval look broken (it returns zero
 * hits, because admission needs two contiguous shared tokens); measuring only the second would
 * have hidden that. Both are reported.
 */
const SHAPES = [
  {
    title: (t) => `${t} 服务上线先走灰度`,
    natural: (t) => `${t} 上线是不是先走灰度？`,
    hard: (t) => `${t} 要发新版本，第一步该进哪个环境？`,
  },
  {
    title: (t) => `${t} 的负责人是平台组`,
    natural: (t) => `${t} 的负责人是谁？`,
    hard: (t) => `${t} 出问题该找哪个组？`,
  },
  {
    title: (t) => `${t} 的数据保留九十天`,
    natural: (t) => `${t} 的数据保留多久？`,
    hard: (t) => `${t} 的历史记录能留多长时间？`,
  },
  {
    title: (t) => `${t} 默认端口是 8443`,
    natural: (t) => `${t} 的默认端口是多少？`,
    hard: (t) => `连 ${t} 该用哪个口子？`,
  },
  {
    title: (t) => `${t} 的请求超时是 2500 毫秒`,
    natural: (t) => `${t} 的请求超时设成多少？`,
    hard: (t) => `${t} 等多久算失败？`,
  },
  {
    title: (t) => `${t} 的备份放 nas-02`,
    natural: (t) => `${t} 的备份放在哪？`,
    hard: (t) => `${t} 的副本存在哪台机器上？`,
  },
  {
    title: (t) => `${t} 的许可证是 MIT`,
    natural: (t) => `${t} 的许可证是什么？`,
    hard: (t) => `${t} 用的是哪个开源协议？`,
  },
  {
    title: (t) => `${t} 的缓存十五分钟过期`,
    natural: (t) => `${t} 的缓存多久过期？`,
    hard: (t) => `${t} 的结果多久要重新拉一次？`,
  },
  {
    title: (t) => `${t} 部署在 ap-east 区`,
    natural: (t) => `${t} 部署在哪个区？`,
    hard: (t) => `${t} 的机器放在什么地域？`,
  },
  {
    title: (t) => `${t} 的限流是 200 rps`,
    natural: (t) => `${t} 的限流是多少？`,
    hard: (t) => `${t} 每秒最多接多少请求？`,
  },
  {
    title: (t) => `${t} 的回滚窗口是三十分钟`,
    natural: (t) => `${t} 的回滚窗口多久？`,
    hard: (t) => `${t} 出事故后多久必须决定？`,
  },
  {
    title: (t) => `${t} 的值班是每周轮换`,
    natural: (t) => `${t} 的值班怎么轮换？`,
    hard: (t) => `${t} 多久换一次人？`,
  },
];

/** Build the measured corpus: every fact is asked about. */
function buildCorpus(count) {
  const facts = [];
  let index = 0;
  while (facts.length < count) {
    const shape = SHAPES[index % SHAPES.length];
    const base = TOPICS[Math.floor(index / SHAPES.length) % TOPICS.length];
    facts.push({ title: shape.title(base), natural: shape.natural(base), hard: shape.hard(base), topic: base });
    index += 1;
  }
  return facts;
}

/** How many facts can be asked about before an anchor would have to repeat. */
const MEASURED_CAP = SHAPES.length * TOPICS.length;

/**
 * Filler, for measuring what a larger store costs.
 *
 * The anchors are deliberately unrelated to every question. An earlier version scaled by
 * suffixing anchors ("atlas2o"), which backfired: Latin runs are bigrammed for matching, so
 * those entries matched "atlas" just as well as the real one and outranked it, and the harness
 * reported a retrieval fault that was really a corpus fault. Filler that is never asked about
 * cannot cause that, and it still occupies a slot in the static index, which is what the
 * measurement is about.
 */
function buildFiller(count) {
  const filler = [];
  for (let index = 0; index < count; index += 1) {
    const id = index.toString(36).padStart(3, '0');
    filler.push({
      title: `记录条目 ${id} 的说明`,
      body: `记录条目 ${id} 是一条与本次问题无关的填充记录，用来占住索引位置。`,
    });
  }
  return filler;
}

const reader = (overrides = {}) => {
  const values = { ...effectiveConfig(overrides), ...overrides };
  return (key) => values[key];
};

/** Open a throwaway store holding `facts` as verified entries in one workspace scope. */
function seedStore(facts, filler = []) {
  const home = mkdtempSync(join(tmpdir(), 'loci-eval-'));
  const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const store = new Store({
    memoryRoot: root,
    paths: layout(root),
    config: effectiveConfig({ home }),
    pluginVersion: '4.0.0',
  });
  const scopes = resolveScopes({ sessionId: 'eval', cwd: home });
  for (const fact of facts) {
    store.write({
      scope: 'workspace',
      scopeKey: scopes.workspace,
      scopeLabel: scopes.labels.workspace,
      kind: 'semantic',
      status: 'verified',
      trustSource: 'user',
      title: fact.title,
      body: `${fact.title}。`,
    });
  }
  for (const item of filler) {
    store.write({
      scope: 'workspace',
      scopeKey: scopes.workspace,
      scopeLabel: scopes.labels.workspace,
      kind: 'semantic',
      status: 'verified',
      trustSource: 'user',
      title: item.title,
      body: item.body,
    });
  }
  return { store, home, scopes };
}

/**
 * A. 忆 at scale.
 *
 * For every fact: is its line in the injected section, where does `search` rank it, and how
 * much of the section is about this question at all.
 */
async function measureRecall(sizes) {
  const results = [];
  for (const size of sizes) {
    const measured = buildCorpus(Math.min(size, MEASURED_CAP));
    const filler = buildFiller(Math.max(0, size - measured.length));
    const facts = measured;
    const { store, home, scopes } = seedStore(facts, filler);
    try {
      const section = renderIndexBody({
        store,
        scopeKeys: [scopes.workspace],
        scopeLabel: scopes.labels.workspace,
        config: reader(),
      });
      const rows = [];
      for (const fact of facts) {
        const ask = async (question) => {
          const result = await search(store, {
            query: question,
            scopeKeys: [scopes.workspace],
            statuses: ['verified'],
            limit: 5,
            detail: 'snippet',
          });
          const rank = result.hits.findIndex((hit) => hit.title === fact.title);
          return { rank: rank < 0 ? null : rank + 1, hits: result.hits.length };
        };
        const natural = await ask(fact.natural);
        const hard = await ask(fact.hard);
        const ownLineBytes = Buffer.byteLength(`- ${fact.title}`, 'utf8');
        rows.push({
          naturalRank: natural.rank,
          naturalHits: natural.hits,
          hardRank: hard.rank,
          hardHits: hard.hits,
          inSection: section.text.includes(fact.title),
          ownLineBytes,
          overlap: bigramJaccard(fact.title, fact.hard),
        });
      }
      const rate = (predicate) => rows.filter(predicate).length / Math.max(1, rows.length);
      results.push({
        size,
        sectionBytes: section.bytes,
        listed: section.listed,
        total: section.total,
        inSection: rate((row) => row.inSection),
        naturalTop1: rate((row) => row.naturalRank === 1),
        naturalHit: rate((row) => row.naturalRank !== null),
        hardTop1: rate((row) => row.hardRank === 1),
        hardHit: rate((row) => row.hardRank !== null),
        // How often a question returns nothing at all: retrieval is all-or-nothing here,
        // because admission needs two contiguous shared tokens.
        hardEmpty: rate((row) => row.hardHits === 0),
        // Share of the section that is about the question being asked. A static index cannot
        // raise this: its content is identical for every question.
        relevance:
          rows.length === 0
            ? 0
            : rows.reduce((sum, row) => sum + row.ownLineBytes, 0) / rows.length / Math.max(1, section.bytes),
        meanOverlap: rows.reduce((sum, row) => sum + row.overlap, 0) / Math.max(1, rows.length),
      });
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
  return results;
}

/** Bigram Jaccard between two strings, to show how much word overlap a question shares. */
function jaccard(a, b) {
  // Reuse the store's own comparison so the measured overlap is the one retrieval sees.
  return bigramJaccard(a, b);
}
void tokenize;

/**
 * B. 记 by rules.
 *
 * Each case is a transcript plus the set of durable statements a careful reader would keep.
 * Everything else in the transcript is chatter that must not be stored.
 */
const TRANSCRIPTS = [
  {
    name: 'deployment rule stated plainly',
    durable: ['以后部署先走灰度'],
    lines: ['以后部署先走灰度。', '今天天气不错。', '这个文件我已经看过了。'],
  },
  {
    name: 'prohibition with a reason',
    durable: ['不要直接改生产库'],
    lines: ['不要直接改生产库，风险太大。', '顺便问一下这个接口怎么调。', '刚才那个报错截图在哪。'],
  },
  {
    name: 'agreement',
    durable: ['约定发布窗口是周三'],
    lines: ['我们说好，约定发布窗口是周三。', '这块代码写得挺绕的。', '你看下这个函数。'],
  },
  {
    name: 'a question is not a rule',
    durable: [],
    lines: ['要不要周末先发一版？', '这个参数是什么意思？', '能不能再快一点？'],
  },
  {
    name: 'noise word inside a normal word',
    durable: [],
    lines: ['这个级别的要求比较高。', '我特别想看看 diff。', '两者区别不大，随便选。'],
  },
  {
    name: 'always phrasing',
    durable: ['永远不要在周五发版'],
    lines: ['永远不要在周五发版。', '今天的会议改到三点了。', '文档在共享盘里。'],
  },
  {
    name: 'remember request',
    durable: ['记住我的时区是东八区'],
    lines: ['记住我的时区是东八区。', '这个表格的列顺序有点怪。', '我先去吃个饭。'],
  },
  {
    name: 'mixed: one rule among many sentences',
    durable: ['禁止把密钥写进代码'],
    lines: ['禁止把密钥写进代码。', '这个 PR 谁 review 的？', '测试跑得有点慢。', '日志文件越来越大了。'],
  },
];

/** Drive the rule-based capture over one transcript and return what it tried to store. */
function runCapture(lines) {
  const home = mkdtempSync(join(tmpdir(), 'loci-eval-cap-'));
  const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const store = new Store({
    memoryRoot: root,
    paths: layout(root),
    config: effectiveConfig({ home }),
    pluginVersion: '4.0.0',
  });
  const capture = new Capture({
    store,
    config: (key) => ({ ...effectiveConfig({ home }), summaryOnDispose: false })[key],
    resolveScopes: (options) => resolveScopes(options),
    now: () => Date.now(),
  });
  const session = { id: 'eval-capture', header: { origin: 'user', delegationDepth: 0, cwd: home } };
  let seq = 0;
  try {
    for (const line of lines) {
      seq += 1;
      capture.onSessionEvent(session, {
        type: 'user/message',
        seq,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: line }] },
      });
    }
    // Capture writes on a debounce timer (30s by default), so a harness that reads the store
    // immediately sees nothing and would report a 0% recall that says more about the harness
    // than about the extractor. Run the pass explicitly instead of waiting.
    capture.runCapture('eval-capture');
    // The rule path writes candidates immediately; read what landed.
    const rows = store.db
      .prepare("SELECT title FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE h.status = 'candidate'")
      .all();
    return rows.map((row) => row.title);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
}

function measureCapture() {
  const rows = [];
  for (const item of TRANSCRIPTS) {
    const stored = runCapture(item.lines);
    const matched = item.durable.filter((want) => stored.some((got) => got.includes(want) || want.includes(got)));
    // Whether the curator's pre-filter even offers the durable sentence to a model. The rule
    // extractor is the decision today; the pre-filter is what a model would see instead. If the
    // pre-filter dropped a sentence the rules also missed, model judgement could never recover
    // it, and the layering would be decorative.
    const seen = prefilter(item.lines.map((text, index) => ({ role: 'user', text, seq: index })));
    const offered = item.durable.filter((want) => seen.some((candidate) => candidate.text.includes(want) || want.includes(candidate.text)));
    rows.push({
      name: item.name,
      want: item.durable.length,
      stored: stored.length,
      matched: matched.length,
      offered: offered.length,
      spurious: stored.filter((got) => !item.durable.some((want) => got.includes(want) || want.includes(got))),
    });
  }
  const want = rows.reduce((sum, row) => sum + row.want, 0);
  const matched = rows.reduce((sum, row) => sum + row.matched, 0);
  const stored = rows.reduce((sum, row) => sum + row.stored, 0);
  const offered = rows.reduce((sum, row) => sum + row.offered, 0);
  return {
    rows,
    recall: want === 0 ? 1 : matched / want,
    precision: stored === 0 ? 1 : matched / stored,
    prefilterRecall: want === 0 ? 1 : offered / want,
  };
}

/**
 * C. The gate.
 *
 * How many human approvals stand between "stored" and "injectable". Measured two ways now,
 * because the layer model makes the answer depend on where the memory goes rather than on who
 * wrote it: a conversation-scoped memory can only reach the conversation it came from, so it
 * does not need a person; a memory that crosses a boundary follows every other conversation
 * into its prompt, so it does.
 *
 * The first version of this section measured only the cross-boundary case and read it as "the
 * gate costs 120 approvals", which was true and also hid the fact that it was blocking
 * everything, including memory that could never harm anything else.
 */
function measureGate(count) {
  const home = mkdtempSync(join(tmpdir(), 'loci-eval-gate-'));
  const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const store = new Store({
    memoryRoot: root,
    paths: layout(root),
    config: effectiveConfig({ home }),
    pluginVersion: '4.0.0',
  });
  const scopes = resolveScopes({ sessionId: 'eval', cwd: home });
  const measurable = (scopeKind, fact) =>
    store.write({
      scope: scopeKind,
      scopeKey: scopes[scopeKind],
      scopeLabel: scopes.labels[scopeKind],
      kind: 'semantic',
      trustSource: 'tool',
      title: fact.title,
      body: `${fact.title}。`,
    });
  try {
    const facts = buildCorpus(count);
    for (const fact of facts) measurable('workspace', fact);
    const durable = store.db
      .prepare('SELECT h.status, COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord GROUP BY h.status')
      .all();
    const section = renderIndexBody({
      store,
      scopeKeys: [scopes.workspace],
      scopeLabel: scopes.labels.workspace,
      config: reader(),
    });
    const durableByStatus = Object.fromEntries(durable.map((row) => [row.status, row.n]));

    // The same claims, written into the conversation they came from.
    const conversational = buildCorpus(count).map((fact) => ({ ...fact, title: `${fact.title}（对话内）` }));
    for (const fact of conversational) measurable('session', fact);
    const sessionRows = store.db
      .prepare(
        `SELECT h.status, COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord
          WHERE m.scope = 'session' GROUP BY h.status`,
      )
      .all();
    const sessionByStatus = Object.fromEntries(sessionRows.map((row) => [row.status, row.n]));

    return {
      written: facts.length,
      byStatus: durableByStatus,
      injectable: durableByStatus.verified ?? 0,
      sectionBytes: section.bytes,
      listed: section.listed,
      sessionWritten: conversational.length,
      sessionByStatus,
      sessionInjectable: sessionByStatus.verified ?? 0,
    };
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * A2. 忆 with the slice composer — the architecture under test.
 *
 * Same corpus, same questions, different section builder. The point of the comparison is not
 * that one number beats another; it is that the new design spends bytes per question and the
 * old one spends them per request.
 */
async function measureRecallSlice(sizes) {
  const results = [];
  for (const size of sizes) {
    const measured = buildCorpus(Math.min(size, MEASURED_CAP));
    const filler = buildFiller(Math.max(0, size - measured.length));
    const facts = measured;
    const { store, home, scopes } = seedStore(facts, filler);
    try {
      const perQuestion = [];
      for (const fact of facts) {
        const runOne = async (query) => {
          const composed = await composeRecall({
            store,
            scopeKeys: [scopes.workspace],
            scopeLabel: scopes.labels.workspace,
            query,
          });
          const ownLineBytes = Buffer.byteLength(`- ${fact.title}`, 'utf8');
          const present = composed.text.includes(fact.title);
          return {
            bytes: composed.bytes,
            present,
            tier: composed.slice.tier,
            ownLineBytes: present ? ownLineBytes : 0,
            remaining: composed.remaining,
          };
        };
        perQuestion.push({ natural: await runOne(fact.natural), hard: await runOne(fact.hard) });
      }
      const rate = (pick) => perQuestion.filter(pick).length / Math.max(1, perQuestion.length);
      const mean = (pick) =>
        perQuestion.reduce((sum, row) => sum + pick(row), 0) / Math.max(1, perQuestion.length);
      results.push({
        size,
        bytes: mean((row) => row.hard.bytes),
        naturalPresent: rate((row) => row.natural.present),
        hardPresent: rate((row) => row.hard.present),
        hardLoose: rate((row) => row.hard.tier === 'loose'),
        hardNone: rate((row) => row.hard.tier === 'none'),
        // Bytes of the needed entry over bytes of the section, per question.
        relevance: mean((row) => (row.hard.bytes === 0 ? 0 : row.hard.ownLineBytes / row.hard.bytes)),
        naturalRelevance: mean((row) => (row.natural.bytes === 0 ? 0 : row.natural.ownLineBytes / row.natural.bytes)),
        remaining: mean((row) => row.hard.remaining),
      });
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
  return results;
}

const recall = await measureRecall([40, 200, 600]);
const slice = await measureRecallSlice([40, 200, 600]);
const capture = measureCapture();
const gate = measureGate(120);

const report = { recall, slice, capture, gate };

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  console.log('=== A. 忆 (recall) — does the right line reach the model? ===');
  console.log('  store  section  listed/total   in-section   natural#1   hard#1   hard-empty   relevance');
  for (const row of recall) {
    console.log(
      `  ${String(row.size).padStart(5)}  ${String(row.sectionBytes).padStart(7)}  ` +
        `${String(row.listed).padStart(6)}/${String(row.total).padEnd(5)}  ` +
        `${pct(row.inSection).padStart(11)}  ${pct(row.naturalTop1).padStart(9)}  ` +
        `${pct(row.hardTop1).padStart(7)}  ${pct(row.hardEmpty).padStart(10)}  ${pct(row.relevance).padStart(9)}`,
    );
  }
  console.log('\n  natural = asks with the fact\'s own content words; hard = same consequence, different words.');
  console.log('  hard-empty = the question returned no hits at all, which is why hard#1 can equal hard#5.');
  console.log('  relevance = bytes of the one needed entry / section bytes, averaged over questions.');
  console.log('  It cannot rise with a static index: every question gets the same bytes.');
  console.log(`  mean hard-question / title bigram overlap: ${pct(recall[0].meanOverlap)}`);

  console.log('\n=== A2. 忆 with the slice composer (architecture under test) ===');
  console.log('  store   mean bytes   natural-found   hard-found   loose tier   none   relevance  (natural)');
  for (const row of slice) {
    console.log(
      `  ${String(row.size).padStart(5)}  ${row.bytes.toFixed(0).padStart(11)}  ` +
        `${pct(row.naturalPresent).padStart(13)}  ${pct(row.hardPresent).padStart(11)}  ` +
        `${pct(row.hardLoose).padStart(11)}  ${pct(row.hardNone).padStart(6)}  ` +
        `${pct(row.relevance).padStart(9)}  ${pct(row.naturalRelevance).padStart(10)}`,
    );
  }
  console.log('\n  natural-found / hard-found = the needed entry is in the section at all (not just rank 1).');
  console.log('  loose tier = recovered by the second-chance pass after the strict pass returned nothing.');

  console.log('\n=== B. 记 (record) — can rules extract durable statements? ===');
  for (const row of capture.rows) {
    const flag = row.matched === row.want && row.spurious.length === 0 ? 'ok  ' : 'FAIL';
    console.log(`  ${flag} ${row.name.padEnd(38)} want ${row.want} · matched ${row.matched} · stored ${row.stored}`);
    if (row.spurious.length > 0) console.log(`         spurious: ${row.spurious.join(' | ')}`);
  }
  console.log(`\n  rules:     recall ${pct(capture.recall)} · precision ${pct(capture.precision)}`);
  console.log(
    `  prefilter: recall ${pct(capture.prefilterRecall)} — what a model would be offered. ` +
      (capture.prefilterRecall >= capture.recall
        ? 'It sees everything the rules saw, and more.'
        : 'It drops things the rules caught, which would be a regression.'),
  );
  console.log('  The curator\'s own judgement is not measured here: it needs a model transport,');
  console.log('  and a fixture standing in for one would measure the fixture.');

  console.log('\n=== C. The gate — approvals needed before anything is injectable ===');
  console.log('  same claims, two destinations:');
  console.log(`    workspace  written ${gate.written} · status ${JSON.stringify(gate.byStatus)}`);
  console.log(`               injectable ${gate.injectable} · approvals required ${gate.written - gate.injectable}`);
  console.log(`    session    written ${gate.sessionWritten} · status ${JSON.stringify(gate.sessionByStatus)}`);
  console.log(
    `               injectable ${gate.sessionInjectable} · approvals required ${gate.sessionWritten - gate.sessionInjectable}`,
  );
  console.log('  A conversation-scoped memory can only reach the conversation it came from, so it needs');
  console.log('  no click. A memory that crosses a boundary still does — and promotion re-opens the');
  console.log('  gate by construction, because changing scope drops the entry back to candidate.');
}
