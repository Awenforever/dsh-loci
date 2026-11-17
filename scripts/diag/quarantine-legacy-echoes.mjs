#!/usr/bin/env node
/**
 * Quarantine the echoes that were stored before the quarantine existed.
 *
 * `m_01M7M183T4J19GSYBCSY` was written at 13:56 with `flags: ["index-echo"]` and status `verified`: the
 * detector worked, the enforcement did not, and it was only added later. The entry is the plugin's own
 * rendered index line stored back as if a person had said it, so leaving it verified leaves one loop
 * iteration live in the store.
 *
 * Sets `disputed` rather than deleting: disputed entries are kept, readable, and never injected. That is the
 * same treatment the current code applies, so the store ends up consistent with the rule either way.
 *
 * Usage: node scripts/diag/quarantine-legacy-echoes.mjs [--apply]
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const apply = process.argv.includes('--apply');
const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.2.3' });

const rows = store.db
  .prepare(
    `SELECT m.id, m.scope_key, m.title, m.flags, h.status
       FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE h.status = 'verified' AND m.valid_to IS NULL
        AND (m.title LIKE '- m\\_%' ESCAPE '\\' OR m.title LIKE 'm\\_%' ESCAPE '\\')`,
  )
  .all();

console.log(`verified echoes: ${rows.length}`);
for (const row of rows) {
  console.log(`  ${row.id}  flags=${row.flags}`);
  console.log(`    ${JSON.stringify(String(row.title).slice(0, 90))}`);
  if (apply) {
    // `setTrust` is the existing transition for a status-only change; it records the actor and an audit line.
    store.setTrust(row.id, 'disputed', { actor: 'tool' });
  }
}

if (!apply) {
  console.log('\ndry run. Re-run with --apply to quarantine.');
} else {
  const left = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord
        WHERE h.status = 'verified' AND m.valid_to IS NULL
          AND (m.title LIKE '- m\\_%' ESCAPE '\\' OR m.title LIKE 'm\\_%' ESCAPE '\\')`,
    )
    .get().n;
  console.log(`\nquarantined; verified echoes remaining: ${left}`);
}
store.close();
