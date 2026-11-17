#!/usr/bin/env node
/**
 * A proposed `always` / `topic` verdict for every live entry, with the reasoning shown.
 *
 * The rule being applied, from `docs/MEMORY-CONTRACT.md` §1: **does the thing this entry is about appear
 * in every task?** Not "is it a firm constraint" — a firm constraint about one screen is still topical.
 *
 * This is a proposal, not a migration. Reclassifying is a decision with a visible cost on both sides: a
 * wrong `always` costs every turn, a wrong `topic` costs a retrieval that may not fire. So the list is
 * printed with the reason for each verdict and nothing is written.
 *
 * Usage: node scripts/diag/applies-classify.mjs [--apply]
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const apply = process.argv.includes('--apply');
const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.6' });

const rows = store.db
  .prepare(
    `SELECT m.id, m.kind, m.applies, m.importance, m.title, m.body, m.scope_key, COALESCE(u.inject_count,0) AS injections
       FROM memory m JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status = 'verified' AND m.valid_to IS NULL AND m.scope_key NOT LIKE 'session:answer-eval'
      ORDER BY u.inject_count DESC`,
  )
  .all();

/**
 * Standing means the subject is the way work is done, not a thing in the work.
 *
 * These patterns describe that, not a keyword list to be trusted blindly — each verdict below is printed
 * with the reason so a person can disagree entry by entry.
 */
const STANDING_MARKERS = [
  { pattern: /AGENTS\.md/, reason: 'how the agent\'s own instruction file is written' },
  { pattern: /LOG\.md|reports\//, reason: 'where durable notes are recorded — applies to every task' },
  { pattern: /验收|截图/, reason: 'acceptance procedure, independent of what is being accepted' },
  { pattern: /交接|传授给另一个会话/, reason: 'how to hand work to another session' },
  { pattern: /上下文不是阻塞|上下文窗口/, reason: 'a fact about the agent itself' },
  { pattern: /netstat|查端口/, reason: 'a technique for finding any port' },
  { pattern: /不要写|不要沿用/, reason: 'a rule about how to phrase things' },
];

const SUBJECT_MARKERS = [
  { pattern: /图标|面板|窗口|搜索框|悬停|动画|布局|按钮|颜色|字体|卡片|网格|状态栏|串口|表格|间距|小数|灰度/, reason: 'names a specific screen element' },
  { pattern: /Zephyr|Quartz|Nimbus|Bramble|Tessera/, reason: 'eval fixture wording' },
];

const propose = (row) => {
  const text = `${row.title} ${row.body ?? ''}`;
  const subjectHit = SUBJECT_MARKERS.find((marker) => marker.pattern.test(text));
  if (subjectHit !== undefined) {
    return { applies: 'topic', why: subjectHit.reason, confidence: 'high' };
  }
  const standingHit = STANDING_MARKERS.find((marker) => marker.pattern.test(text));
  if (standingHit !== undefined) {
    return { applies: 'always', why: standingHit.reason, confidence: 'medium' };
  }
  return { applies: 'topic', why: 'no standing marker — default to retrieval', confidence: 'low' };
};

let standing = 0;
const lines = [];
for (const row of rows) {
  const verdict = propose(row);
  if (verdict.applies === 'always') standing += 1;
  lines.push({ row, verdict });
}

console.log(`verified entries ${rows.length} · proposed always ${standing} · proposed topic ${rows.length - standing}\n`);
console.log('A subject marker outranks a standing marker on purpose: "the grid card must not show X" mentions');
console.log('a firm constraint, but its subject is one screen.\n');

for (const { row, verdict } of lines) {
  const mark = verdict.applies === 'always' ? 'ALWAYS' : 'topic ';
  console.log(`${mark} [${verdict.confidence}] ${String(row.injections).padStart(4)}×  ${row.id}`);
  console.log(`       ${JSON.stringify(String(row.title).slice(0, 92))}`);
  console.log(`       why: ${verdict.why}`);
}

if (!apply) {
  console.log(`\ndry run. Re-run with --apply to write these verdicts (each is a normal revision, audit kept).`);
} else {
  let changed = 0;
  for (const { row, verdict } of lines) {
    if (row.applies === verdict.applies) continue;
    try {
      store.update(row.id, {
        scope: 'workspace',
        scopeKey: row.scope_key,
        applies: verdict.applies,
        title: row.title,
        body: row.body,
      });
      changed += 1;
    } catch (error) {
      console.log(`  could not update ${row.id}: ${String(error?.message ?? error)}`);
    }
  }
  console.log(`\nchanged ${changed} of ${lines.length}`);
}
store.close();
