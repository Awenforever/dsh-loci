// Is the recall boost actually being applied to entries that are injected every turn?
//
// The standing entries sit at about -26 mu and keep drifting left (they were -24 twelve mu earlier). If they
// were really injected every turn they should be collecting a boost of ~120 mu each time and pinning at the
// entrance instead. One of those two things is wrong, and a model whose central claim is "recall pulls right"
// cannot ship with an unverified pull.

import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';
import { AXIS_DEFAULTS, positionOf, recallBoost } from '../../src/host/store/axis.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '6.1.0' });
const muNow = store.muNow();

const rows = store.db
  .prepare(
    `SELECT m.id, m.title, m.applies, u.p_base, u.mu_base, u.mu_touched,
            COALESCE(u.inject_count, 0) AS injections, COALESCE(u.read_count,0) AS reads
       FROM memory m JOIN memory_head h ON h.ord = m.ord
       LEFT JOIN memory_usage u ON u.id = m.id
      WHERE h.status = 'verified' AND m.valid_to IS NULL AND u.inject_count > 0
      ORDER BY u.inject_count DESC LIMIT 8`,
  )
  .all();

console.log(`muNow ${muNow.toFixed(2)} · R ${AXIS_DEFAULTS.entranceDepth} · boost(0) ${recallBoost(0).toFixed(1)}\n`);
console.log('entries with the most injections — did the anchor ever move?');
for (const row of rows) {
  const p = positionOf({ pBase: row.p_base, muBase: row.mu_base }, muNow);
  const since = row.mu_base === null ? null : (muNow - Number(row.mu_base)).toFixed(1);
  console.log(
    `  inj=${String(row.injections).padStart(3)}  p=${String(Math.round(p)).padStart(6)}  ` +
      `mu_base=${row.mu_base === null ? 'null' : Math.round(Number(row.mu_base))}  ` +
      `since recall=${String(since).padStart(7)} μ`,
  );
}

// The decisive number: if a recall ever happened, `mu_base` must be close to now for a frequently used entry.
const recentlyRecalled = rows.filter((row) => row.mu_base !== null && muNow - Number(row.mu_base) < 200).length;
console.log(`\nof the 8 most-injected entries, ${recentlyRecalled} have an anchor written in the last 200 μ.`);
console.log('If that is 0 while inject_count is in the hundreds, the recall path never writes the anchor.');

// Where the boost should have taken them. Simulate 10 recalls from their current position.
const first = rows[0];
if (first !== undefined) {
  let p = positionOf({ pBase: first.p_base, muBase: first.mu_base }, muNow);
  const start = p;
  for (let i = 0; i < 10; i += 1) p += recallBoost(p);
  console.log(
    `\nsimulation: the most-injected entry at ${Math.round(start)} μ would reach ${Math.round(p)} μ ` +
      `after 10 recalls (capped at ${AXIS_DEFAULTS.entranceDepth}).`,
  );
  console.log('It is not there. So either it is not being injected, or the write is not landing.');
}

// Is it being injected at all? The audit knows.
const since = muNow - 200;
const recent = store.db
  .prepare("SELECT COUNT(*) AS n FROM request_stat WHERE ts > ?")
  .get(Date.now() - 6 * 3600_000);
console.log(`\nrequest_stat rows in the last 6 h: ${recent.n}`);
const log = store.db
  .prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'inject'")
  .get();
console.log(`audit 'inject' events ever: ${log.n}`);
const lastAudit = store.db.prepare("SELECT ts, payload FROM audit WHERE event = 'inject' ORDER BY ts DESC LIMIT 2").all();
for (const row of lastAudit) {
  const payload = JSON.parse(row.payload ?? '{}');
  console.log(`  last inject at ${new Date(Number(row.ts)).toISOString()} ids=${(payload.ids ?? []).length}`);
}
store.close();
