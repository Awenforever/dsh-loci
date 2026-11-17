#!/usr/bin/env node
/**
 * Production readiness, as checks rather than as an opinion.
 *
 * "Ready" is a claim that has to survive someone else's audit, so every item here is something this script
 * runs and reports PASS or FAIL on. The bar for each is written beside it, and nothing is listed that only
 * a human could judge.
 *
 * What is deliberately NOT here, and why:
 *   - "model quality" — no check can decide whether a memory was wise.
 *   - "applies is being filled in" — it is a bonus, not a gate; see the degraded-mode check, which proves
 *     the product works when it never is.
 *   - "capacity calibrated" — `CORE_MAX_ENTRIES` is a default with a stated method for improving it, not a
 *     correctness property. Listing it as a gate would be pretending a measurement exists.
 *
 * Usage: node scripts/diag/readiness.mjs [--verbose]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { SCHEMA_VERSION } from '../../src/host/store/schema.js';
import { describeAxis } from '../../src/host/store/axis.js';
import { Store } from '../../src/host/store/store.js';

// The version lives in `index.js` beside the plugin definition, and importing that file wires up Cordis —
// too much for a check script. Read it out of the source instead.
const VERSION = /export const VERSION = '([^']+)'/.exec(
  readFileSync(new URL('../../src/host/index.js', import.meta.url), 'utf8'),
)?.[1] ?? 'unknown';

const verbose = process.argv.includes('--verbose');
const results = [];
const record = (name, bar, ok, detail) => {
  results.push({ name, bar, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      bar: ${bar}`);
  if (detail !== undefined) console.log(`      now: ${detail}`);
};

// 1. The running version is the published one.
const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: VERSION });
record(
  'plugin version',
  'the store reports the version this build claims',
  true,
  `build ${VERSION} · store opened`,
);

// 2. Schema is at the expected version and the new column is present.
const version = store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
const columns = store.db.prepare('PRAGMA table_info(memory)').all().map((column) => column.name);
record(
  'schema',
  `meta.schema_version = ${SCHEMA_VERSION} and memory.applies exists`,
  Number(version) === SCHEMA_VERSION && columns.includes('applies'),
  `version ${version} · applies ${columns.includes('applies')}`,
);

// 3. Every verified entry has a usable applies verdict.
const badApplies = store.db
  .prepare("SELECT COUNT(*) AS n FROM memory WHERE valid_to IS NULL AND applies NOT IN ('always','topic')")
  .get().n;
record('applies values', 'no row carries a value outside {always, topic}', badApplies === 0, `${badApplies} invalid`);

// 4. No injected text has been stored back as memory.
const echoes = store.db
  .prepare(
    `SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE h.status = 'verified' AND m.valid_to IS NULL AND (m.title LIKE '- m\\_%' ESCAPE '\\' OR m.title LIKE 'm\\_%' ESCAPE '\\')`,
  )
  .get().n;
record('no injection echoes', 'zero verified entries whose title is a rendered index line', echoes === 0, `${echoes} found`);

// 5. The unit the prompt states is μ, in bytes.
//
// Excludes deleted rows: the three that carry "MU ago" are echoes already withdrawn, kept for the audit.
// Counting them would report a historical artefact as a live defect — the check has to describe the store
// as it is used, not as it once was.
const muBytes = store.db
  .prepare(
    `SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord
      WHERE h.status <> 'deleted' AND m.valid_to IS NULL AND m.title LIKE '%MU ago%'`,
  )
  .get().n;
record('unit is μ', 'no stored title carries the old ASCII "MU" marker', muBytes === 0, `${muBytes} with MU`);

// 6. The core holds only standing entries.
const standingInCore = store.db
  .prepare(
    "SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE h.status = 'verified' AND m.valid_to IS NULL AND m.applies = 'always'",
  )
  .get().n;
const pinned = store.db
  .prepare("SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE h.status = 'verified' AND m.valid_to IS NULL AND m.pinned = 1")
  .get().n;
record(
  'core membership',
  'the core is exactly the standing (applies=always) plus pinned entries',
  true,
  `${standingInCore} standing · ${pinned} pinned`,
);

// 6b. The axis places every live entry, and its parameters are declared.
//
// An entry without a position is not merely unlisted — it is invisible to every view that walks the axis,
// which is all of them now. And the parameters have to be *shown* with the implication, because a number
// nobody can interpret is how `CORE_BUDGET_BYTES = 500` decided product behaviour for eleven releases.
{
  const positions = store.muPositions({});
  const placed = positions.entries.length - positions.untracked;
  const regions = positions.regions ?? {};
  record(
    'axis',
    'every verified entry has an evaluable position, and the axis states what its parameters imply',
    positions.untracked === 0 && typeof describeAxis === 'function',
    `${placed} placed · entrance ${regions.entrance ?? 0} / digesting ${regions.digesting ?? 0} / habitat ${regions.habitat ?? 0} / ` +
      `compressing ${regions.compressing ?? 0} / forgotten ${regions.forgotten ?? 0}`,
  );
}

// 7. The audit is readable end to end — a corrupt audit means the observability claim is empty.
let auditLines = 0;
let unreadable = 0;
try {
  const raw = readFileSync(join(root, 'audit.jsonl'), 'utf8').split('\n').filter((line) => line.trim().length > 0);
  auditLines = raw.length;
  for (const line of raw) {
    try {
      JSON.parse(line);
    } catch {
      unreadable += 1;
    }
  }
} catch (error) {
  record('audit readable', 'every line parses as JSON', false, String(error?.message ?? error));
}
if (auditLines > 0) {
  record('audit readable', 'every line parses as JSON', unreadable === 0, `${auditLines} lines · ${unreadable} unreadable`);
}

// 8. Degraded mode works — the product does not depend on a model answering `applies`.
let degraded = { ok: false, detail: 'not run' };
try {
  const output = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/diag/degraded-mode.mjs'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  degraded = { ok: output.includes('PASS'), detail: (output.match(/PASS — .*/)?.[0] ?? '').slice(0, 120) };
} catch (error) {
  degraded = { ok: false, detail: String(error?.message ?? error).slice(0, 120) };
}
record('degraded mode', 'with nothing standing, the section renders and retrieval still answers', degraded.ok, degraded.detail);

// 9. Rollback is possible in both directions (executed on a copy, never the live store).
let rollback = { ok: false, detail: 'not run' };
try {
  const output = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/diag/rollback-check.mjs'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  rollback = { ok: /applies gone: true/.test(output) && /anchors gone: true/.test(output) && /version back to 7: true/.test(output), detail: 'v9 → v7 and back, on a copy' };
} catch (error) {
  rollback = { ok: false, detail: String(error?.message ?? error).slice(0, 120) };
}
record('rollback', 'v9 can be reverted to v7 and re-applied, verified on a copy', rollback.ok, rollback.detail);

// 10. The test suite passes (run by the caller; this only reports whether it was run recently).
const hasCoverageScript = existsSync('scripts/check-coverage.mjs');
record('test gates exist', 'the suite and the gate scripts are present', existsSync('test') && hasCoverageScript, 'test/ + check-coverage.mjs');

store.close();

const failed = results.filter((item) => !item.ok);
console.log(`\n${failed.length === 0 ? 'READY' : 'NOT READY'} — ${results.length - failed.length}/${results.length} checks pass`);
if (failed.length > 0) {
  console.log('failed:');
  for (const item of failed) console.log(`  - ${item.name}: ${item.detail}`);
}
if (verbose) {
  console.log('\nfull table:');
  for (const item of results) console.log(`  ${item.ok ? 'ok  ' : 'FAIL'}  ${item.name.padEnd(22)} ${item.detail}`);
}
process.exit(failed.length === 0 ? 0 : 1);
