#!/usr/bin/env node
/**
 * Which character actually reaches the model: U+03BC (μ) or the ASCII letters MU?
 *
 * PowerShell renders μ as a lookalike glyph in a GBK console, so "it looks right" is not evidence. The
 * bytes are.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { composeSliceMessage, composeStable } from '../../src/host/recall/compose.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.3' });

const rows = store.db
  .prepare("SELECT DISTINCT scope_key FROM memory WHERE valid_to IS NULL LIMIT 5")
  .all();
const scopeKeys = rows.map((row) => row.scope_key);
console.log(`scopes: ${scopeKeys.length === 0 ? '(none — the store is empty)' : scopeKeys.join(', ')}`);

const stable = composeStable({ store, scopeKeys, scopeLabel: 'probe', coreBudgetBytes: 4000, now: Date.now() });
const slice = composeSliceMessage({
  store,
  scopeKeys,
  scopeLabel: 'probe',
  query: '规则',
  budgetBytes: 4000,
  now: Date.now(),
});

const inspect = (label, text) => {
  const micro = (text.match(/\u03bc/g) ?? []).length;
  const ascii = (text.match(/MU/g) ?? []).length;
  console.log(`${label}: μ(U+03BC) × ${micro} · "MU" × ${ascii}`);
  const sample = text.split('\n').find((line) => /\u03bc|MU/.test(line));
  if (sample !== undefined) {
    const bytes = Buffer.from(sample, 'utf8');
    const at = bytes.indexOf(0xce);
    console.log(`  first matching line as bytes around the symbol: ${[...bytes.slice(Math.max(0, at - 4), at + 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    console.log(`  decoded: ${JSON.stringify(sample.trim().slice(0, 90))}`);
  }
};

inspect('stable', stable.text ?? '');
inspect('slice ', slice.text ?? '');
store.close();
