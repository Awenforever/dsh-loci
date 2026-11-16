#!/usr/bin/env node
/** Inspect the desktop profile manifest and its backups without `require` (the parent package.json is invalid). */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const prof = join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop');
const load = (name) => JSON.parse(readFileSync(join(prof, name), 'utf8'));

const current = load('package.json');
const bundles = current.dsh.profile.bundles;
const seen = new Set();
const duplicates = [];
for (const name of bundles) {
  if (seen.has(name)) duplicates.push(name);
  seen.add(name);
}
console.log('current bundles      ', bundles.length);
console.log('duplicates           ', JSON.stringify(duplicates));
console.log('loci in bundles      ', bundles.includes('dsh-loci'));
console.log('loci spec            ', current.dependencies['dsh-loci']);
console.log('dependencies         ', Object.keys(current.dependencies).length);

console.log('\nbackups:');
for (const name of readdirSync(prof).filter((entry) => entry.startsWith('package.json.bak')).sort()) {
  try {
    const backup = load(name);
    const list = backup.dsh?.profile?.bundles ?? [];
    const set = new Set(list);
    console.log(
      `  ${name.padEnd(38)} bundles=${String(list.length).padStart(2)} unique=${String(set.size).padStart(2)} loci=${set.has('dsh-loci')} spec=${backup.dependencies?.['dsh-loci'] ?? '-'}`,
    );
  } catch (error) {
    console.log(`  ${name.padEnd(38)} unreadable: ${String(error?.message ?? error).slice(0, 40)}`);
  }
}
