// Which conversation does the panel currently describe?
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const db = new DatabaseSync(join(process.env.USERPROFILE, '.dsh', 'memory', 'loci', 'memory.db'), { readOnly: true });
const rows = db
  .prepare(
    `SELECT id, ts, session_id, scope_key, source, section_bytes
       FROM request_stat WHERE source = 'section'
      ORDER BY ts DESC, id DESC LIMIT 6`,
  )
  .all();
console.log('most recent section assemblies:');
for (const row of rows) {
  console.log(`  ${new Date(Number(row.ts)).toISOString().slice(11, 19)}  ${String(row.session_id).slice(0, 16)}  ${row.scope_key}  ${row.section_bytes}B`);
}
const scopes = db
  .prepare("SELECT scope_key, COUNT(*) n FROM memory WHERE valid_to IS NULL GROUP BY scope_key ORDER BY n DESC")
  .all();
console.log('\nentries by scope:');
for (const row of scopes) console.log(`  ${row.scope_key}: ${row.n}`);
db.close();
