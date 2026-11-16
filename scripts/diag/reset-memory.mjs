#!/usr/bin/env node
/**
 * Clear the store to a clean baseline.
 *
 * Hard purge rather than soft delete, because the goal is a store that *is* empty rather than one
 * that is full of tombstones: `heads` counts rows, so 51 soft-deleted entries would leave the panel
 * showing zero verified over a non-zero total, and the card would never reach its empty state.
 *
 * A copy of the database is taken first, so the operation is still reversible at the file level.
 *
 * Usage: node scripts/diag/reset-memory.mjs [--yes]
 */
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const confirmed = process.argv.includes('--yes');
// `--only=<trust_source>` narrows the purge to one producer. Used to clear the session summaries
// that were written before 4.13.0 turned that path off, without touching what the curator wrote.
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const only = onlyArg === undefined ? undefined : onlyArg.slice('--only='.length);
const root = resolveMemoryRoot(resolveDshHome());
const paths = layout(root);

console.log(`memory root   ${root}`);
console.log(`database      ${paths.db} (${existsSync(paths.db) ? statSync(paths.db).size : 0} bytes)`);
if (only !== undefined) console.log(`restricted to trust_source=${only}`);

const config = effectiveConfig({ allowHardDelete: true });
const store = new Store({ memoryRoot: root, paths, config, pluginVersion: '4.13.0' });

const scope = only === undefined ? '' : " AND m.trust_source = ?";
const params = only === undefined ? [] : [only];
const live = store.db
  .prepare(
    `SELECT m.id, m.title, m.trust_source, h.status FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE m.valid_to IS NULL${scope}`,
  )
  .all(...params);
console.log(`\nlive rows: ${live.length}`);
const bySource = new Map();
for (const row of live) bySource.set(row.trust_source ?? '(none)', (bySource.get(row.trust_source ?? '(none)') ?? 0) + 1);
console.log(`  by source: ${JSON.stringify(Object.fromEntries(bySource))}`);

if (!confirmed) {
  console.log('\ndry run: pass --yes to purge these rows');
  store.close();
  process.exit(0);
}

// Back the file up before touching it. The purge is deliberate, but "deliberate" is not "undoable".
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(root, `memory.db.bak-${stamp}`);
copyFileSync(paths.db, backup);
console.log(`\nbackup        ${backup}`);

const ids = store.db
  .prepare(
    `SELECT DISTINCT m.id FROM memory m WHERE m.valid_to IS NULL${scope}`,
  )
  .all(...params)
  .map((row) => row.id);

// The first version of `--only` filtered the report but not this list, so a "purge the summaries"
// command deleted every row in the store. Three curator entries were lost and had to be restored from
// the backup. The guard is the fix that would have caught it: the ids being purged must be exactly the
// rows that were reported as selected.
if (ids.length !== live.length) {
  console.error(
    `ABORT: ${live.length} row(s) reported as selected but ${ids.length} id(s) would be purged. ` +
      'The selection and the purge disagree; nothing was deleted.',
  );
  store.close();
  process.exit(1);
}

let purged = 0;
for (const id of ids) {
  try {
    store.forget(id, { mode: 'purge', confirm: id, reason: 'reset to a clean baseline before enabling for real use' });
    purged += 1;
  } catch (error) {
    console.log(`  failed ${id}: ${String(error?.message ?? error)}`);
  }
}
console.log(`purged        ${purged} memories (all revisions)`);

// Usage and request statistics are keyed by memory id or by nothing at all: left behind, they would
// keep reporting 1008 injections against rows that no longer exist.
store.db.prepare('DELETE FROM memory_usage').run();
store.db.prepare('DELETE FROM request_stat').run();
store.db.prepare('DELETE FROM token_stat').run();
store.db.prepare("DELETE FROM meta WHERE key IN ('curator_probe', 'curator_probe_error', 'session_event_seen', 'user_tracker', 'last_injection')").run();

const after = {
  rows: store.db.prepare('SELECT COUNT(*) AS n FROM memory').get().n,
  heads: store.db.prepare('SELECT COUNT(*) AS n FROM memory_head').get().n,
  usage: store.db.prepare('SELECT COUNT(*) AS n FROM memory_usage').get().n,
  requests: store.db.prepare('SELECT COUNT(*) AS n FROM request_stat').get().n,
};
console.log(`\nafter:\n  ${JSON.stringify(after)}`);

const stats = store.stats({ scopeKeys: undefined });
console.log(`  byStatus ${JSON.stringify(stats.byStatus)} · pending ${stats.pendingCandidates} · disputed ${stats.disputed} · heads ${stats.heads}`);
store.close();
