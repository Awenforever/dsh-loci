#!/usr/bin/env node
/**
 * The worst case that decides whether this is ready: what if no model ever answers `applies`?
 *
 * Every entry then defaults to `topic`, the core is empty, and the product is a pure-retrieval system. That
 * is a **safe degradation**, not a failure — but only if it actually works. If an empty core produced a
 * broken prompt, a crash, or a section that retrieves nothing, then readiness would depend on a model
 * behaviour nobody has seen yet, and the honest answer would be "not ready".
 *
 * So: build a throwaway store where *nothing* is standing, populate it the way a real project would, and
 * check that the degraded mode is a working product rather than a quiet outage.
 *
 * Runs entirely in a temporary directory.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveConfig } from '../../src/host/config.js';
import { composeSliceMessage, composeStable, selectCore } from '../../src/host/recall/compose.js';
import { Store } from '../../src/host/store/store.js';

const home = mkdtempSync(join(tmpdir(), 'loci-degraded-'));
const root = join(home, 'memory', 'loci');
const store = new Store({ memoryRoot: root, paths: { db: join(root, 'db') }, config: effectiveConfig({ home }), pluginVersion: 'probe' });

const scopeKey = 'workspace:degraded';
const write = (entry) =>
  store.write({
    kind: 'semantic',
    scope: 'workspace',
    scopeKey,
    scopeLabel: '降级测试',
    status: 'verified',
    trustSource: 'user',
    ...entry,
  });

// A project's worth of memories, none of them standing — exactly what a model that ignores `applies` produces.
const corpus = [
  { title: 'atlas 的回滚窗口是三十分钟', body: '超过就升级到人工。' },
  { title: 'beacon 的负责人是平台组', body: '找平台组而不是基础设施组。' },
  { title: 'cinder 的灰度比例第一次是百分之三', body: '先小后大。' },
  { title: 'delve 的保留期是九个季度', body: '到期自动清理。' },
  { title: 'ember 的上线窗口是周三下午', body: '避开周五。' },
  { title: '网格视图卡片只显示流量偏差，不显示供气异常提示', body: '卡片放不下。' },
  { title: '位置切换图标不要用简单的左右箭头', body: '换更美观的图标。' },
  { title: '日志搜索框在日志为空且失焦时须自动收起', body: '否则很吵。' },
];
for (const entry of corpus) write(entry);

const applies = store.db.prepare('SELECT applies, COUNT(*) AS n FROM memory GROUP BY applies').all();
console.log(`store built: ${corpus.length} entries · distribution ${JSON.stringify(applies.map((row) => ({ ...row })))}`);

// 1. the core is empty, and that is the expected state
const core = selectCore({ store, scopeKeys: [scopeKey] });
console.log(`\n1. core selection`);
console.log(`   entries ${core.lines.length} (expected 0) · bytes ${core.bytes}`);

// 2. the stable section still renders and still tells the model where the rest is
const stable = composeStable({ store, scopeKeys: [scopeKey], scopeLabel: '降级测试' });
const text = String(stable.text ?? '');
console.log(`\n2. stable section: ${text.length} chars, ${Buffer.byteLength(text, 'utf8')} bytes`);
console.log(`   claims "Always applies":  ${/Always applies/.test(text)}  (must be false)`);
console.log(`   names its scope:          ${/Index —/.test(text)}`);
console.log(`   points at the rest:       ${/loci_search/.test(text)}`);
console.log(`   explains the μ unit:      ${/ages are in μ/.test(text)}`);
console.log(`   carries a fence tag:      ${/<loci-context/.test(text)}`);

// 3. retrieval still works — this is the whole product when nothing is standing
const questions = [
  { question: 'atlas 回滚窗口多久', expect: 'atlas 的回滚窗口是三十分钟' },
  { question: '位置切换图标换成什么好', expect: '位置切换图标不要用简单的左右箭头' },
  { question: '日志搜索框怎么收起', expect: '日志搜索框在日志为空且失焦时须自动收起' },
  { question: '这个项目的负责人是谁', expect: 'beacon 的负责人是平台组' },
];
console.log('\n3. retrieval (the only path left when nothing is standing)');
let hits = 0;
for (const item of questions) {
  const slice = composeSliceMessage({ store, scopeKeys: [scopeKey], scopeLabel: 'x', query: item.question });
  const found = String(slice.text ?? '').includes(item.expect.slice(0, 8));
  if (found) hits += 1;
  console.log(`   ${found ? 'FOUND  ' : 'MISSED '} ${JSON.stringify(item.question)}  (${slice.ids?.length ?? 0} ids)`);
}
console.log(`   ${hits}/${questions.length} retrieved`);

// 4. nothing threw, and every entry is still readable
const readable = store.db.prepare("SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE h.status = 'verified' AND m.valid_to IS NULL").get().n;
console.log(`\n4. verified entries still readable: ${readable} of ${corpus.length}`);

const verdict =
  core.lines.length === 0 &&
  !/Always applies/.test(text) &&
  /loci_search/.test(text) &&
  /ages are in μ/.test(text) &&
  text.length > 0 &&
  hits >= questions.length - 1 &&
  readable === corpus.length;

console.log(`\n${verdict ? 'PASS' : 'FAIL'} — ${verdict
  ? 'an empty core is a working product: the section renders, says where the rest is, and retrieval carries it. Readiness does not depend on any model answering `applies`.'
  : 'the degraded mode is broken somewhere above, so readiness WOULD depend on model behaviour nobody has observed.'}`);

store.close();
rmSync(home, { recursive: true, force: true });
process.exit(verdict ? 0 : 1);
