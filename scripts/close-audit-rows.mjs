#!/usr/bin/env node
/**
 * Close the audit rows this release actually addressed.
 *
 * The rows are matched by table id rather than by full text: the disposition
 * column uses typographic dashes that are easy to mistype, and a silent
 * no-match is exactly how "fixed" claims go stale.
 *
 * Usage: node scripts/close-audit-rows.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'docs/AUDIT-1.1.md';
const checkOnly = process.argv.includes('--check');

const UPDATES = {
  23: '**fixed** — https://github.com/Awenforever/dsh-loci is public; the remaining gate is the npm token (R1)',
  24: '**fixed in 1.5.0** — a prerelease tag publishes to the `next` dist-tag, and a tag whose commit is not an ancestor of `main` is refused before anything is published',
  25: '**fixed in 1.5.0** — `package-lock.json` is committed and both workflows install with `npm ci`',
  27: '**fixed in 1.5.0** — the gate fails on lines (<80), branches (<55) and functions (<70), and prints all three numbers on every run',
  33: '**fixed in 1.5.0** — OPERATIONS §1 carries the exact install path, flags are position-independent, `/loci review|doctor|export` are documented, and `snapshot`/`snapshots` are real commands',
  34: '**fixed in 1.4.0** — `store.forgetAll()` + `POST /api/loci/forget-all` + Settings → Delete everything, gated by an echoed phrase; purging still requires `allowHardDelete`',
  '30b': '**fixed in 1.4.0** — the importer now reads the tree the exporter writes and restores each entry\'s original scope; `test/unit/export.test.mjs` pins the round trip',
};

const lines = readFileSync(FILE, 'utf8').split('\n');
let changed = 0;
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  if (!line.startsWith('| ')) continue;
  const cells = line.split('|');
  const id = (cells[1] ?? '').trim();
  const update = UPDATES[id];
  if (update === undefined) continue;
  if (cells[4] !== undefined && cells[4].includes(update)) continue;
  // cells: ['', ' 27 ', ' coverage gate… ', ' D ', ' **open** — … ', '']
  cells[4] = ` ${update} `;
  lines[index] = cells.join('|');
  changed += 1;
  console.log(`${checkOnly ? 'would update' : 'updated'} row ${id}`);
}

if (changed > 0 && !checkOnly) writeFileSync(FILE, lines.join('\n'), 'utf8');
console.log(`${changed} row(s) ${checkOnly ? 'need' : 'were'} updated`);
