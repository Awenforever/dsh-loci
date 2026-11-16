#!/usr/bin/env node
/**
 * Is what is running actually what was published?
 *
 * A hand-synced fix is a claim, not a fact, and this project has already shipped one release whose
 * on-disk code differed from what anyone believed. This compares the installed package against the
 * published tarball for the same version, file by file.
 *
 * Usage: node scripts/diag/deploy-integrity.mjs [--version 5.0.3] [--keep]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const versionArg = process.argv.find((arg) => arg.startsWith('--version='));
const keep = process.argv.includes('--keep');
const work = join(tmpdir(), 'loci-integrity');
const installed = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-loci');

if (!existsSync(installed)) {
  console.error(`not installed: ${installed}`);
  process.exit(2);
}
const installedVersion = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version;
const version = versionArg === undefined ? installedVersion : versionArg.slice('--version='.length);
console.log(`installed ${installedVersion} · comparing against published ${version}`);

if (existsSync(work)) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const meta = JSON.parse(
  curl(['-sS', '--max-time', '30', `https://registry.npmjs.org/dsh-loci/${version}`]),
);
const tarball = meta.dist.tarball;
console.log(`tarball   ${tarball}`);
curl(['-sS', '--max-time', '120', '-L', '-o', join(work, 'pkg.tgz'), tarball]);
const bytes = statSync(join(work, 'pkg.tgz')).size;
console.log(`downloaded ${bytes} bytes`);

execFileSync('tar', ['-xzf', join(work, 'pkg.tgz'), '-C', work]);
const published = join(work, 'package');

/**
 * curl with the proxy this machine actually needs.
 *
 * The environment var is inherited, but curl.exe on Windows has been seen to go direct anyway when the
 * shell exported it late; passing `--proxy` explicitly makes the check work the same way from a
 * scheduled task, a terminal, or an agent.
 *
 * @param args - curl arguments.
 * @returns stdout as text.
 */
function curl(args) {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '';
  const proxied = proxy.length > 0 ? ['--proxy', proxy, ...args] : args;
  return execFileSync('curl', proxied, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      out.push(...walk(full, base));
    } else {
      out.push(relative(base, full));
    }
  }
  return out;
}

const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const publishedFiles = walk(published);
const installedFiles = walk(installed);

let same = 0;
const differing = [];
const missing = [];
for (const file of publishedFiles) {
  const a = join(published, file);
  const b = join(installed, file);
  if (!existsSync(b)) missing.push(file);
  else if (hash(a) === hash(b)) same += 1;
  else differing.push(file);
}
const extra = installedFiles.filter((file) => !publishedFiles.includes(file));

console.log(`\nfiles     ${publishedFiles.length} published · ${installedFiles.length} installed`);
console.log(`same      ${same}`);
console.log(`differing ${differing.length}${differing.length ? ` → ${differing.slice(0, 8).join(', ')}` : ''}`);
console.log(`missing   ${missing.length}${missing.length ? ` → ${missing.slice(0, 8).join(', ')}` : ''}`);
console.log(`extra     ${extra.length}${extra.length ? ` → ${extra.slice(0, 8).join(', ')}` : ''}`);

const clean = differing.length === 0 && missing.length === 0 && extra.length === 0;
console.log(`\n${clean ? 'identical: what runs is what was published' : 'DIVERGED: the installed tree is not the published artifact'}`);
if (!keep) rmSync(work, { recursive: true, force: true });
process.exit(clean ? 0 : 1);
