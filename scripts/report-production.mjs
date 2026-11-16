#!/usr/bin/env node
/**
 * Is it healthy right now?
 *
 * One command that answers the production question, from the live store and the audit log rather than
 * from anyone's memory of what was shipped. It aggregates the two halves and the clock:
 *
 * - **忆**: how much was injected, how often the slice found something, how often the rewriter had to
 *   be paid for, and how often it came back empty — the difference between "not wired" and "wired and
 *   useless" has cost this project several releases, so both are reported separately;
 * - **记**: whether curation runs, whether it writes, and how many entries the model has produced;
 * - **时钟**: the memory-unit counter and the four distance bands;
 * - **健康**: failures from the audit, and a single "look here first" line.
 *
 * Wall clock appears here for one purpose only: grouping activity into recent windows so a person can
 * tell "running now" from "stopped three days ago". Nothing in the product decides anything from it.
 *
 * Usage: node scripts/report-production.mjs [--json] [--hours 24]
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { effectiveConfig } from '../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../src/host/paths.js';
import { Store } from '../src/host/store/store.js';

const json = process.argv.includes('--json');
const hoursArg = process.argv.find((arg) => arg.startsWith('--hours='));
const hours = hoursArg === undefined ? 24 : Math.max(1, Number(hoursArg.slice('--hours='.length)) || 24);

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({
  memoryRoot: root,
  paths: layout(root),
  config: effectiveConfig({}),
  pluginVersion: process.env.DSH_LOCI_VERSION ?? 'unknown',
});

const since = Date.now() - hours * 3_600_000;

/** Audit rows, parsed, newest last. A malformed line is counted rather than dropped silently. */
function readAudit(file) {
  if (!existsSync(file)) return { events: [], malformed: 0 };
  const events = [];
  let malformed = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  return { events, malformed };
}

const audit = readAudit(store.paths.audit);
const recent = audit.events.filter((event) => Number(event.ts) >= since);
const count = (list, name) => list.filter((event) => event.event === name).length;

const positions = store.muPositions({});
const entriesByStatus = store.db
  .prepare('SELECT h.status AS status, COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord GROUP BY h.status')
  .all();
const bySource = store.db
  .prepare("SELECT COALESCE(trust_source, '(none)') AS src, COUNT(*) AS n FROM memory m WHERE m.valid_to IS NULL GROUP BY src")
  .all();
const curatorTotal = Number(
  store.db.prepare("SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE m.trust_source = 'curator' AND h.status = 'verified' AND m.valid_to IS NULL").get()?.n ?? 0,
);

const injections = recent.filter((event) => event.event === 'inject');
const injectedEntries = injections.reduce((sum, event) => sum + Number(event.ids?.length ?? event.listed ?? 0), 0);

const slices = recent.filter((event) => event.event === 'recall-slice');
const rewritten = recent.filter((event) => event.event === 'recall-rewrite');
const rewriteEmpty = recent.filter((event) => event.event === 'recall-rewrite-empty');
const rewriteSkip = recent.filter((event) => event.event === 'recall-rewrite-skip');
const curateRuns = recent.filter((event) => event.event === 'curate');
const curateStart = recent.filter((event) => event.event === 'curate-start');
const curateWrote = curateRuns.filter((event) => (event.written ?? 0) > 0);

const failures = recent.filter((event) =>
  ['error', 'fail'].includes(String(event.level)) ||
  String(event.event ?? '').includes('error') ||
  (event.event === 'curate' && event.ran === false && String(event.reason ?? '').startsWith('threw')),
);

const report = {
  window: { hours, since, until: Date.now() },
  store: {
    path: store.paths.db,
    bytes: existsSync(store.paths.db) ? statSync(store.paths.db).size : 0,
    byStatus: Object.fromEntries(entriesByStatus.map((row) => [row.status, Number(row.n)])),
    bySource: Object.fromEntries(bySource.map((row) => [row.src, Number(row.n)])),
    curatorVerified: curatorTotal,
  },
  clock: {
    now: Number(positions.now.toFixed(2)),
    bands: positions.bands,
    retireAfter: positions.retireAfter,
    advances: recent.filter((event) => event.event === 'inject').length,
  },
  recall: {
    injections: injections.length,
    injectedEntries,
    sliceHits: slices.length,
    sliceMisses: rewriteEmpty.length + rewriteSkip.length,
    rewriteFired: rewritten.length + rewriteEmpty.length + rewriteSkip.length,
    rewriteFound: rewritten.length,
    rewriteEmpty: rewriteEmpty.length,
    rewriteSkipped: rewriteSkip.length,
  },
  record: {
    curateStarted: curateStart.length,
    curateRan: curateRuns.filter((event) => event.ran === true).length,
    curateWrote: curateWrote.length,
    entriesWritten: curateRuns.reduce((sum, event) => sum + Number(event.written ?? 0), 0),
    reasons: [...new Set(curateRuns.map((event) => String(event.reason ?? '(none)')))],
  },
  failures: failures.length,
  audit: { total: audit.events.length, malformed: audit.malformed },
};

/**
 * The one line a person should read.
 *
 * Ordered by what would make the product wrong rather than merely idle: corruption first, then a
 * surface that is silent, then growth with no retirement.
 */
function verdict(entry) {
  if (entry.audit.malformed > 0) return `look here: ${entry.audit.malformed} unreadable audit line(s)`;
  if (entry.failures > 0) return `look here: ${entry.failures} failure event(s) in the window`;
  if (entry.recall.injections === 0) {
    return 'silent: no injection in the window — is the plugin loaded, or is the store empty for this scope?';
  }
  if (entry.record.curateStarted === 0) return 'record half idle: curation has not been triggered in the window';
  if (entry.clock.bands.cold > 0 && entry.clock.retireAfter === 0) {
    return `growing: ${entry.clock.bands.cold} entries past the cool band and retirement is off (threshold not calibrated)`;
  }
  if (entry.recall.rewriteFound === 0 && entry.recall.rewriteFired > 0) {
    return 'rewriter is firing but never finding anything — the hints or the alternative count may need work';
  }
  return 'healthy: both halves are running and nothing is failing';
}

report.verdict = verdict(report);

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const w = report.window;
  console.log(`window            last ${w.hours}h (wall clock, for grouping only)`);
  console.log(`store             ${report.store.byStatus.verified ?? 0} verified · ${report.store.byStatus.candidate ?? 0} candidate · ${(report.store.bytes / 1024).toFixed(0)} KB`);
  console.log(`by source         ${JSON.stringify(report.store.bySource)}`);
  console.log(`clock             ${report.clock.now} MU · fresh ${report.clock.bands.fresh} / active ${report.clock.bands.active} / cool ${report.clock.bands.cool} / cold ${report.clock.bands.cold}`);
  console.log(`                  retirement ${report.clock.retireAfter > 0 ? `after ${report.clock.retireAfter} MU` : 'off (threshold not calibrated)'}`);
  console.log('');
  console.log(`忆 · injections  ${report.recall.injections} (${report.recall.injectedEntries} entries listed)`);
  console.log(`     slice hits  ${report.recall.sliceHits}`);
  console.log(`     rewrite     fired ${report.recall.rewriteFired} · found ${report.recall.rewriteFound} · empty ${report.recall.rewriteEmpty} · skipped ${report.recall.rewriteSkipped}`);
  console.log(`记 · curate      started ${report.record.curateStarted} · ran ${report.record.curateRan} · wrote ${report.record.curateWrote} (${report.record.entriesWritten} entries)`);
  console.log(`     reasons      ${JSON.stringify(report.record.reasons)}`);
  console.log(`     curator      ${report.store.curatorVerified} verified entries in total`);
  console.log('');
  console.log(`audit             ${report.audit.total} lines · ${report.audit.malformed} unreadable`);
  console.log(`failures          ${report.failures}`);
  console.log(`\n${report.verdict}`);
}
store.close();
