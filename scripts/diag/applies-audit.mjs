#!/usr/bin/env node
/**
 * The 29 rules that would need a verdict if `applies` had two values.
 *
 * Before designing the field, look at what has to be classified. If the answers cluster into an obvious
 * pattern the classifier can follow, two values are enough; if they do not, the design is wrong and no
 * amount of prompt engineering will save it.
 *
 * Read-only. Prints every rule with the evidence a person would use to judge it.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.5' });

const rows = store.db
  .prepare(
    `SELECT m.id, m.kind, m.pinned, m.importance, m.title, m.body, m.scope_key, m.trust_source,
            COALESCE(u.inject_count, 0) AS injections
       FROM memory m JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status = 'verified' AND m.valid_to IS NULL AND m.scope_key NOT LIKE 'session:answer-eval'
      ORDER BY u.inject_count DESC`,
  )
  .all();

console.log(`${rows.length} verified entries outside the eval fixture\n`);
console.log('Injections is the only behavioural signal we have. A rule shown on every turn whether or not');
console.log('the task touches its subject is either genuinely standing, or misclassified.\n');

for (const row of rows) {
  const body = String(row.body ?? '').replace(/\s+/g, ' ').slice(0, 100);
  console.log(`${String(row.injections).padStart(5)}×  ${row.kind.padEnd(10)} ${row.trust_source.padEnd(8)} ${row.id}`);
  console.log(`       ${JSON.stringify(String(row.title).slice(0, 96))}`);
  if (body.length > 0 && body !== String(row.title).slice(0, 100)) console.log(`       body: ${JSON.stringify(body)}`);
}

// How many are even arguably standing? A crude split by wording, to see whether the boundary is visible
// in the text or only in someone's head.
const standingish =
  /必须|不要|禁止|只留|只写|不允许|总是|每次|一律|never|always|must|only/;
const subjectish = /图标|面板|窗口|搜索框|悬停|动画|布局|按钮|颜色|字体|卡片|网格/;
let standing = 0;
let subject = 0;
let both = 0;
let neither = 0;
for (const row of rows) {
  const text = `${row.title} ${row.body ?? ''}`;
  const s = standingish.test(text);
  const t = subjectish.test(text);
  if (s && t) both += 1;
  else if (s) standing += 1;
  else if (t) subject += 1;
  else neither += 1;
}
console.log(`\ncrude split by wording: standing-only ${standing} · subject-only ${subject} · both ${both} · neither ${neither}`);
console.log('"both" is the interesting group: a hard constraint about one UI element. Whether it is standing');
console.log('depends on whether that element appears in every task, which the text alone cannot say.');
store.close();
