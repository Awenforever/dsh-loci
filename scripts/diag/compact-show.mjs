// Show what compaction actually did to a few entries: original vs current text.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const db = new DatabaseSync(join(process.env.USERPROFILE, '.dsh', 'memory', 'loci', 'memory.db'), { readOnly: true });

const rows = db
  .prepare(
    `SELECT m.id, m.title, m.compact_level AS lvl, m.revision,
            (SELECT body FROM memory o WHERE o.id = m.id ORDER BY o.revision ASC LIMIT 1) AS original,
            m.body AS current
       FROM memory m
       JOIN memory_head h ON h.ord = m.ord
      WHERE h.status = 'verified' AND m.valid_to IS NULL AND m.compact_level > 0
      ORDER BY m.compact_level DESC, LENGTH(m.body) DESC
      LIMIT 6`,
  )
  .all();

for (const row of rows) {
  console.log(`\n── ${row.title}  (L${row.lvl}, rev ${row.revision})`);
  console.log(`   original ${row.original.length} chars: ${row.original}`);
  console.log(`   now      ${row.current.length} chars: ${row.current}`);
  console.log(`   kept ${((row.current.length / row.original.length) * 100).toFixed(0)}%`);
}

const summary = db
  .prepare(
    `SELECT lvl, COUNT(*) AS n, SUM(now_len) AS now_bytes, SUM(was_len) AS was_bytes FROM (
       SELECT m.compact_level AS lvl, LENGTH(m.body) AS now_len,
              (SELECT LENGTH(o.body) FROM memory o WHERE o.id = m.id ORDER BY o.revision ASC LIMIT 1) AS was_len
         FROM memory m JOIN memory_head h ON h.ord = m.ord
        WHERE h.status = 'verified' AND m.valid_to IS NULL
     ) GROUP BY lvl ORDER BY lvl`,
  )
  .all();
console.log('\nlevels:');
for (const row of summary) {
  console.log(`  L${row.lvl}: ${String(row.n).padStart(3)} entries · ${row.now_bytes} chars now vs ${row.was_bytes} originally`);
}
db.close();
