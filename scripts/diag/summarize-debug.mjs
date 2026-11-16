#!/usr/bin/env node
/** Why does summarize() return undefined when summaries are off? */
import { Capture } from '../../src/host/capture/capture.js';
import { DEFAULTS } from '../../src/host/config.js';
import { openTestStore } from '../../test/helpers.mjs';

console.log('DEFAULTS.summaryOnDispose =', DEFAULTS.summaryOnDispose);

// openTestStore registers cleanup on a test context; pass a minimal one.
const ctx = { after: () => {} };
const { store } = openTestStore(ctx);
const values = { ...DEFAULTS, summaryOnDispose: false };
const capture = new Capture({
  store,
  config: (key) => values[key],
  resolveScopes: () => ({ workspace: 'workspace:test', labels: { workspace: 'test' } }),
  extractor: undefined,
  now: () => 1_700_000_000_000,
});

capture.sessions.set('s1', {
  messages: [
    { seq: 1, role: 'user', text: '第一条用户消息，足够长以便参与判断。' },
    { seq: 2, role: 'assistant', text: '好的。' },
  ],
  bytes: 40,
  captures: 0,
  turn: 1,
  cwd: 'C:/work/project',
  timer: undefined,
  extractTimer: undefined,
});

console.log('config("summaryOnDispose") =', capture.config('summaryOnDispose'));
const result = capture.summarize('s1', 'dispose');
console.log('summarize returned', result, '(', typeof result, ')');
console.log('source of summarize:', String(Capture.prototype.summarize).split('\n').slice(0, 6).join(' | '));
store.close();
