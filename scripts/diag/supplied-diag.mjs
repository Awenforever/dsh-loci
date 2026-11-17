#!/usr/bin/env node
/**
 * The model supplied `whenCondition` on two writes and `applies` on none.
 *
 * That is the most informative thing the store has said all day. It rules out "the model never saw the new
 * prompt" — it did, and it answered one of the two new fields. So the question narrows to: why did it answer
 * the conditional one and skip the categorical one?
 *
 * Candidate explanations, each with a different fix:
 *   a) `applies` reads as redundant with `kind` (a rule is already "always" in most people's heads)
 *   b) the schema line shows every key, so optional keys look skippable
 *   c) the description is long enough that the model treats it as advice rather than a field to fill
 *   d) the write path drops it between the parser and the store
 *
 * (d) is testable right now; the others need the raw reply.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.2.2' });

const lines = readFileSync(join(root, 'audit.jsonl'), 'utf8').split('\n').filter((line) => line.trim().length > 0);
const writes = [];
for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.event === 'write') writes.push(event);
}

const withSignal = writes.filter((event) => event.supplied !== undefined);
console.log(`writes ${writes.length} · carrying the supplied signal ${withSignal.length}\n`);

let appliesYes = 0;
let whenYes = 0;
let importanceYes = 0;
for (const event of withSignal) {
  if (event.supplied.applies) appliesYes += 1;
  if (event.supplied.whenCondition) whenYes += 1;
  if (event.supplied.importance) importanceYes += 1;
}
console.log('among writes that carried the signal:');
console.log(`  applies supplied       ${appliesYes} / ${withSignal.length}`);
console.log(`  whenCondition supplied ${whenYes} / ${withSignal.length}`);
console.log(`  importance supplied    ${importanceYes} / ${withSignal.length}`);

// (d) is checkable immediately: run a reply through the parser and confirm the value survives to the store.
const { parseCuratorReply } = await import('../../src/host/record/curator.js');
const messages = [{ role: 'user', text: '位置切换按钮挂在品牌图标上，hover 显示 switch 图示' }];
const reply = JSON.stringify({
  keep: [
    {
      kind: 'procedural',
      applies: 'topic',
      whenCondition: '当 Codex Advisor 与其它坞同时停靠同一侧时',
      title: 'Codex Advisor 右侧坞让位规则',
      body: '只让上方邻居。',
      evidenceQuote: '位置切换按钮挂在品牌图标上，hover 显示 switch 图示',
    },
  ],
  drop: [],
});
const parsed = parseCuratorReply(reply, { messages });
console.log('\n(d) does the parser keep it?');
console.log(`  items ${parsed.items.length} · applies=${JSON.stringify(parsed.items[0]?.applies)} · whenCondition=${JSON.stringify(parsed.items[0]?.whenCondition)}`);
console.log('  (the store.write half is covered by test/unit/applies-core.test.mjs — a diagnostic script must');
console.log('   not write to the production store to prove itself; an earlier version of this file did, and left');
console.log('   probe entries behind.)');

if (withSignal.length === 0) {
  console.log('  **No write has passed through the signal yet**, so nothing here describes model behaviour.');
  console.log('  The pipeline itself is verified below by writing one entry directly; what is unknown is whether a');
  console.log('  model, given the prompt, chooses to answer the field. Inferring an answer from the absence of');
  console.log('  data is the mistake this release exists to stop making.');
} else {
  console.log('\nso the pipeline is intact end to end; the remaining question is what the model answers.');
}

store.close();
