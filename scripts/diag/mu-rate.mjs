// What rate does mu actually advance at, and what does one event cost?
//
// The absolute value of mu means nothing, but its rate is what makes the number feel like it is flying or
// crawling. This measures the live store so any rescale is based on data rather than on a feeling.

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const db = new DatabaseSync(join(process.env.USERPROFILE, '.dsh', 'memory', 'loci', 'memory.db'), { readOnly: true });

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
  .all()
  .map((row) => row.name);
console.log('tables:', tables.join(', '));

const muNow = Number(db.prepare("SELECT value FROM meta WHERE key = 'mu_now'").get()?.value ?? 0);
console.log('mu_now:', muNow.toFixed(1));

// The oldest and newest memory stamps, so the span is measured rather than assumed.
const span = db
  .prepare(
    `SELECT MIN(created_at) AS first, MAX(updated_at) AS last, COUNT(*) AS n
       FROM memory WHERE valid_to IS NULL`,
  )
  .get();
const hours = (Number(span.last) - Number(span.first)) / 3_600_000;
console.log(`memories: ${span.n} · span ${hours.toFixed(1)} h`);
if (hours > 0) {
  console.log(`mu per hour: ${(muNow / hours).toFixed(1)} · mu per day: ${((muNow / hours) * 24).toFixed(0)}`);
  console.log(`one mu ≈ ${((hours * 60) / Math.max(1, muNow)).toFixed(2)} minutes of wall clock (for perspective only)`);
}

// What does a single mu event cost? The counter advances by log(w_add*add + w_use*use + 1) per event.
const reason = db
  .prepare(
    `SELECT reason, COUNT(*) AS n, SUM(delta) AS total FROM mu_event GROUP BY reason ORDER BY n DESC`,
  )
  .all();
console.log('\nevents by reason:');
for (const row of reason) {
  const per = Number(row.total) / Number(row.n);
  console.log(`  ${String(row.reason).padEnd(8)} ${String(row.n).padStart(6)} events · total ${Number(row.total).toFixed(1).padStart(8)} · ${per.toFixed(3)} per event`);
}
const totalEvents = reason.reduce((sum, row) => sum + Number(row.n), 0);
console.log(`  ${totalEvents} events total → ${(muNow / Math.max(1, totalEvents)).toFixed(3)} mu per event`);

// How much of the growth comes from injections alone? That is the part that makes the number twitch on
// every turn regardless of whether anything was learned.
const injectEvents = reason.find((row) => row.reason === 'inject');
if (injectEvents !== undefined) {
  const share = (Number(injectEvents.total) / muNow) * 100;
  console.log(`\ninjections alone account for ${share.toFixed(0)}% of all mu ever advanced.`);

  // If mu only advanced on writes, how fast would it move?
  const writeEvents = reason.find((row) => row.reason === 'write');
  if (writeEvents !== undefined) {
    console.log(`writes alone would have advanced ${Number(writeEvents.total).toFixed(0)} mu instead of ${muNow.toFixed(0)}.`);
    console.log('That is the scale question: how many units a busy day is worth.');
  }
}
db.close();
