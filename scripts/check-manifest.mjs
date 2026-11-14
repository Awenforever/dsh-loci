#!/usr/bin/env node
/**
 * Manifest and source gate: the checks that must hold before a pack or publish.
 *
 * These are the failures this project has actually seen in the wild: a
 * peer-only version range that excluded the running Host, a package that
 * shipped without its client half, a locale file that lost its display title.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const problems = [];
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const manifest = JSON.parse(read('package.json'));

// 1. Version and identity.
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) problems.push(`version is not semver: ${manifest.version}`);
if (manifest.name !== 'dsh-loci') problems.push(`unexpected package name: ${manifest.name}`);

// 2. The compatibility gate reads `engines.dsh` first; make sure it accepts a
//    current Host and that the matrix documents what was verified.
if (typeof manifest.engines?.dsh !== 'string') problems.push('engines.dsh is required (peer-only ranges are what break Host upgrades)');
else if (!/>=0\.2\.2-rc\.1/.test(manifest.engines.dsh)) problems.push(`engines.dsh must include 0.2.2-rc.1: ${manifest.engines.dsh}`);
if (!Array.isArray(manifest.dshReleases) || manifest.dshReleases.length === 0) problems.push('dshReleases matrix is required');
else if (!manifest.dshReleases.some((row) => row.dsh === '0.2.2-rc.1' && row.status === 'verified')) {
  problems.push('dshReleases must record 0.2.2-rc.1 as verified');
}

// 3. Every runtime file the bundle declares must exist.
for (const path of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
  if (!existsSync(join(root, path))) problems.push(`missing runtime file: ${path}`);
}
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') problems.push('dsh.bundle.patch must point at cordis.patch.yml');
if (manifest.dsh?.client?.platform !== 'web') problems.push('dsh.client.platform must be web');
if (!manifest.exports?.['./client']) problems.push('the ./client export is required for the UI half');

// 4. Display metadata: the plugin manager reads these without activating the plugin.
for (const locale of ['en', 'zh']) {
  try {
    const data = JSON.parse(read(`locale/${locale}.json`));
    if (typeof data?.meta?.title !== 'string' || data.meta.title.length < 3) problems.push(`locale/${locale}.json lacks meta.title`);
    if (typeof data?.meta?.description !== 'string' || data.meta.description.length < 10) problems.push(`locale/${locale}.json lacks meta.description`);
  } catch (error) {
    problems.push(`locale/${locale}.json is not valid JSON: ${String(error?.message ?? error)}`);
  }
}

// 5. The client half must be a module-loader bundle whose id matches the package.
const client = read('client.js');
if (!client.includes('__ModuleLoader__.load')) problems.push('client.js does not register a module-loader factory');
if (!client.includes(`id: '${manifest.name}'`)) problems.push(`client.js registers an id other than ${manifest.name}`);
if (/\bimport\s+[^('"]/.test(client.replace(/\/\*[\s\S]*?\*\//g, ''))) problems.push('client.js must not use static imports; the shell provides React');

// 6. Patch sanity: exactly one row, addressed by the package name.
const patch = read('cordis.patch.yml');
if (!patch.includes('id: dsh-loci')) problems.push('cordis.patch.yml does not insert the dsh-loci row');
if (!patch.includes('name: dsh-loci')) problems.push('cordis.patch.yml row must resolve the package by name');

// 7. Keep the bin entry canonical.
//
// npm normalises a bin path that starts with `./` and prints
// "script name … was invalid and removed", which reads far more alarming than it
// is: measured on the published 2.0.0 and 2.0.1, the registry metadata still
// carries `bin: {"dsh-loci":"scripts/cli.mjs"}`, a fresh install creates
// `node_modules/.bin/dsh-loci`, and `npx dsh-loci help` works. So this is not a
// "the binary was dropped" guard — it is a guard against the value drifting into
// a form npm rewrites, or into a target that no longer exists or lost its shebang,
// and against that warning being the only signal.
for (const [name, target] of Object.entries(manifest.bin ?? {})) {
  if (typeof target !== 'string') {
    problems.push(`bin.${name} must be a string`);
    continue;
  }
  if (target.startsWith('./') || target.startsWith('/') || target.includes('..')) {
    problems.push(`bin.${name} must be a bare relative path (no "./", no ".."): ${target}`);
  }
  if (!existsSync(join(root, target))) problems.push(`bin.${name} points at a missing file: ${target}`);
  else if (!read(target).startsWith('#!')) problems.push(`bin.${name} target must start with a shebang: ${target}`);
  const files = manifest.files ?? [];
  if (!files.some((entry) => entry === target || entry === 'scripts/**/*.js' || entry.startsWith('scripts/'))) {
    problems.push(`bin.${name} target is not covered by "files": ${target}`);
  }
}

if (problems.length > 0) {
  console.error(`manifest gate failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('manifest gate ok');
