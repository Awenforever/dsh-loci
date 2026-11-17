#!/usr/bin/env node
/**
 * Does the curator prompt actually contain the new fields, and does the model answer them?
 *
 * Three writes happened after 5.2.0 and none supplied `applies`. Either the prompt did not carry the field,
 * the model ignored it, or the parse dropped it. Those have different fixes, so find out which.
 */
import { buildCuratorPrompt, CURATOR_CONTRACT } from '../../src/host/record/curator.js';

console.log('=== does the contract mention the fields? ===');
console.log(`applies in contract:       ${CURATOR_CONTRACT.includes('applies')}`);
console.log(`whenCondition in contract: ${CURATOR_CONTRACT.includes('whenCondition')}`);

const prompt = buildCuratorPrompt({
  messages: [
    { role: 'user', text: '位置切换按钮挂在品牌图标上，hover 显示 switch 图示' },
    { role: 'assistant', text: '好的，我改一下。' },
  ],
  existing: [],
  scopeLabel: 'workspace 测试',
});

const text = typeof prompt === 'string' ? prompt : String(prompt?.prompt ?? prompt?.text ?? '');
console.log(`\n=== rendered prompt (${text.length} chars) ===`);
console.log(`applies appears ${(text.match(/applies/g) ?? []).length} time(s)`);
console.log(`"always|topic" appears: ${text.includes('always|topic')}`);

const at = text.indexOf('applies');
if (at >= 0) {
  console.log('\ncontext around the first mention:');
  console.log(JSON.stringify(text.slice(Math.max(0, at - 120), at + 260)));
} else {
  console.log('\n**The field is not in the rendered prompt at all.** The contract constant may have it while the');
  console.log('builder assembles from a different string.');
}

// And what the parser does with a reply that omits it, versus one that includes it.
import { parseCuratorReply } from '../../src/host/record/curator.js';
const messages = [{ role: 'user', text: '位置切换按钮挂在品牌图标上' }];
const omitted = parseCuratorReply(
  JSON.stringify({ keep: [{ kind: 'rule', title: 't1', body: 'b1', evidenceQuote: '位置切换按钮挂在品牌图标上' }], drop: [] }),
  { messages },
);
const stated = parseCuratorReply(
  JSON.stringify({ keep: [{ kind: 'rule', applies: 'topic', title: 't2', body: 'b2', evidenceQuote: '位置切换按钮挂在品牌图标上' }], drop: [] }),
  { messages },
);
console.log(`\nreply omitting applies  -> items ${omitted.items.length}, applies=${JSON.stringify(omitted.items[0]?.applies)}`);
console.log(`reply stating  applies  -> items ${stated.items.length}, applies=${JSON.stringify(stated.items[0]?.applies)}`);
