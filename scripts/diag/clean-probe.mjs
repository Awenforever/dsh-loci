#!/usr/bin/env node
/** Remove the probe entry written by loop-proof.mjs, with a soft delete (keeps the audit trail). */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '4.3.0' });

const rows = store.db
  .prepare("SELECT m.id, m.title FROM memory m WHERE m.title LIKE ?")
  .all('回路验证 probe-%');
console.log(`probe entries found: ${rows.length}`);
for (const row of rows) {
  store.forget(row.id, { mode: 'soft', reason: 'end-to-end loop probe' });
  const after = store.get(row.id).entry;
  console.log(`  ${row.id} → status ${after.status}`);
}

const remaining = store.db
  .prepare(
    `SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE h.status = 'verified' AND m.valid_to IS NULL`,
  )
  .get().n;
console.log(`verified entries now: ${remaining}`);
store.close();
