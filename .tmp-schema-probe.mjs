// Read-only schema probe. Written as a file because inline `node -e` with SQL strings keeps tripping the
// PowerShell quoting.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const db = new DatabaseSync(join(process.env.USERPROFILE, '.dsh', 'memory', 'loci', 'memory.db'), { readOnly: true });
const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
const columns = db.prepare('PRAGMA table_info(memory_usage)').all().map((c) => c.name);
console.log('schema_version:', version?.value);
console.log('memory_usage columns:', columns.join(', '));
console.log('has p_base:', columns.includes('p_base'));
const muNow = db.prepare("SELECT value FROM meta WHERE key = 'mu_now'").get();
console.log('mu_now:', muNow?.value);
db.close();
