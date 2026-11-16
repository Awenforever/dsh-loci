#!/usr/bin/env node
/**
 * What the model actually receives, rendered from the live store.
 *
 * The point is C3: no calendar date may reach the model, and every age must be a memory-unit distance.
 * Reading the code proves what was written; this proves what is emitted.
 */
import { effectiveConfig } from '../../src/host/config.js';
import { composeSliceMessage, composeStable } from '../../src/host/recall/compose.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.0.1' });

// Every verified entry, so the render has something to show regardless of the panel's scope.
const scopes = store.db
  .prepare("SELECT DISTINCT scope_key FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE h.status = 'verified' AND m.valid_to IS NULL")
  .all()
  .map((row) => row.scope_key);
console.log(`scope keys with verified entries: ${scopes.length}`);

const stable = composeStable({ store, scopeKeys: scopes, scopeLabel: 'all' });
const slice = composeSliceMessage({
  store,
  scopeKeys: scopes,
  scopeLabel: 'all',
  query: 'Codex Advisor 的图标对齐要怎么改？',
});

const text = `${stable.text}\n${slice.text}`.trim();
console.log(`\n--- section (${Buffer.byteLength(stable.text, 'utf8')} B) ---`);
console.log(stable.text || '(empty)');
console.log(`\n--- slice (${Buffer.byteLength(slice.text, 'utf8')} B, ${slice.ids.length} ids) ---`);
console.log(slice.text || '(empty)');

const dates = text.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
const ages = text.match(/\d+(\.\d+)? MU ago/g) ?? [];
console.log(`\nC3 check: calendar dates in the prompt = ${dates.length} ${dates.length ? JSON.stringify(dates) : '(none)'}`);
console.log(`          MU distances in the prompt   = ${ages.length} ${ages.length ? JSON.stringify(ages.slice(0, 5)) : '(none)'}`);
store.close();
