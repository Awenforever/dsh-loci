// Read the mu event log and report the rate under the v10 driver.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const db = new DatabaseSync(join(process.env.USERPROFILE, '.dsh', 'memory', 'loci', 'memory.db'), { readOnly: true });

const byReason = db.prepare('SELECT reason, COUNT(*) n, MIN(mu) mn, MAX(mu) mx FROM mu_event GROUP BY reason').all();
for (const r of byReason) {
  console.log(`  ${String(r.reason).padEnd(8)} n=${String(r.n).padStart(5)}  mu ${Number(r.mn).toFixed(2)} -> ${Number(r.mx).toFixed(2)}`);
}

const recent = db.prepare('SELECT reason, at, mu, use_n FROM mu_event ORDER BY id DESC LIMIT 8').all();
console.log('\nrecent events (newest first):');
for (const r of recent) {
  console.log(`  ${new Date(Number(r.at)).toISOString().slice(11, 19)}  ${String(r.reason).padEnd(7)} use=${r.use_n} -> mu ${Number(r.mu).toFixed(3)}`);
}

const first = db.prepare('SELECT at FROM mu_event ORDER BY at ASC LIMIT 1').get();
const last = db.prepare('SELECT at FROM mu_event ORDER BY at DESC LIMIT 1').get();
const hours = (Number(last.at) - Number(first.at)) / 3_600_000;
const now = Number(db.prepare('SELECT value FROM meta WHERE key = ?').get('mu_now').value);
console.log(`\nspan ${hours.toFixed(1)} h · mu ${now.toFixed(2)} → ${(now / hours).toFixed(2)} mu/h = ${((now / hours) * 24).toFixed(0)} mu/day`);

// How much did the last hour cost?
const hourAgo = Date.now() - 3_600_000;
const recentSum = db.prepare('SELECT COUNT(*) n FROM mu_event WHERE at > ?').get(hourAgo);
const before = db.prepare('SELECT mu FROM mu_event WHERE at <= ? ORDER BY at DESC LIMIT 1').get(hourAgo);
console.log(`events in the last hour: ${recentSum.n} · mu then ${before === undefined ? 'n/a' : Number(before.mu).toFixed(2)} → now ${now.toFixed(2)}`);
db.close();
