#!/usr/bin/env node
/**
 * Falsification test: a topical entry that left the core must still be findable.
 *
 * 5.2.0 moved "位置切换图标不要用简单的左右箭头" out of the core — it went from 442 injections to zero in
 * the first four renders afterwards. That is the intended change, and it is also exactly what "the rule
 * disappeared" looks like from the outside. The difference between "no longer shown every turn" and "lost"
 * is whether retrieval brings it back when the question is actually about it.
 *
 * So this asks the real questions a session would ask, and reports whether the slice surfaces it.
 *
 * Read-only.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { composeSliceMessage, selectCore } from '../../src/host/recall/compose.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.2.0' });

const TARGET = 'm_01M7J1YJ58PAAFACQEH4';
const target = store.get(TARGET).entry;
console.log(`target: ${target.applies} · ${JSON.stringify(String(target.title).slice(0, 60))}`);

const scopeKeys = store.db
  .prepare("SELECT DISTINCT scope_key FROM memory WHERE scope_key LIKE '%4c45fb3c%' AND valid_to IS NULL")
  .all()
  .map((row) => row.scope_key);
console.log(`scope: ${scopeKeys.join(', ')}\n`);

const core = selectCore({ store, scopeKeys });
console.log(`core holds ${core.lines.length} entries; target in core: ${core.ids.includes(TARGET)}`);

// Questions that genuinely concern it, phrased the way a person would.
const shouldFind = [
  '把位置切换的图标换成齿轮',
  '位置切换那个图标不好看，换一个',
  '左上角那个切换按钮的图标想改一下',
  'icon for the position toggle is plain arrows',
];
// Questions that do not concern it.
const shouldNotFind = [
  '给日志搜索框加上失焦自动收起',
  'MFC 面板拖动时卡片要连贯动画',
  '帮我看看 docker 容器为什么起不来',
];

const ask = (question) => {
  const slice = composeSliceMessage({ store, scopeKeys, scopeLabel: 'x', query: question });
  return { hit: slice.ids?.includes(TARGET) ?? false, text: slice.text ?? '', ids: slice.ids ?? [] };
};

console.log('\nquestions that SHOULD surface it:');
let foundRight = 0;
for (const question of shouldFind) {
  const result = ask(question);
  if (result.hit) foundRight += 1;
  console.log(`  ${result.hit ? 'FOUND  ' : 'MISSED '} ${JSON.stringify(question)}  (slice ${result.ids.length} ids)`);
}

console.log('\nquestions that should NOT surface it:');
let correctRejections = 0;
for (const question of shouldNotFind) {
  const result = ask(question);
  if (!result.hit) correctRejections += 1;
  console.log(`  ${result.hit ? 'FALSE+ ' : 'CLEAN  '} ${JSON.stringify(question)}  (slice ${result.ids.length} ids)`);
}

console.log(`\nrecall ${foundRight}/${shouldFind.length} on-topic · ${correctRejections}/${shouldNotFind.length} off-topic kept clean`);
if (foundRight === 0) {
  console.log('\nIt is lost, not topical. Moving an entry out of the core without retrieval finding it is deletion');
  console.log('with extra steps, and the change would have to be reverted.');
} else if (correctRejections < shouldNotFind.length) {
  console.log('\nRetrieval is too eager — it surfaces the rule on unrelated questions, which is the old behaviour');
  console.log('in a different place.');
} else {
  console.log('\nThe split does what it claims: out of the core, back when the subject comes up.');
}
store.close();
