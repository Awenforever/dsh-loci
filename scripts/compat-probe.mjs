#!/usr/bin/env node
/**
 * Compatibility probe: check the Host API surface this plugin uses against the
 * **installed** DeepSeek Harness, not against the version in the docs.
 *
 * Why this exists: `engines.dsh` is a range, and a range is a promise that nobody
 * tested. The probe reads the host package out of the shipped app.asar and asserts
 * that every API the plugin touches is still there, in the shape it expects. It is
 * not a substitute for booting the host — it is what catches "the range admits a
 * version we never looked at".
 *
 * Usage:
 *   node scripts/compat-probe.mjs                       # auto-detect the install
 *   node scripts/compat-probe.mjs --asar <path>         # explicit archive
 *   node scripts/compat-probe.mjs --json                # machine-readable
 *
 * Exits 0 when every check passes, 1 when one fails, 2 on a usage problem.
 */
import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const CANDIDATES = [
  'D:/Programs/DeepseekHarness/resources/app.asar',
  'C:/Program Files/DeepSeek Harness/resources/app.asar',
  join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app.asar'),
];

/** Read one file out of an asar archive without unpacking it. */
function readAsarFile(archive, wanted) {
  const fd = openSync(archive, 'r');
  try {
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    const jsonLength = header.readInt32LE(12);
    const jsonBuffer = Buffer.alloc(jsonLength);
    readSync(fd, jsonBuffer, 0, jsonLength, 16);
    const tree = JSON.parse(jsonBuffer.toString('utf8'));
    const dataOffset = 8 + header.readUInt32LE(4);
    let found;
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const path = prefix.length === 0 ? name : `${prefix}/${name}`;
        if (child.files !== undefined) walk(child, path);
        else if (path === wanted) found = child;
      }
    };
    walk(tree, '');
    if (found === undefined) return undefined;
    const size = found.size ?? 0;
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, dataOffset + Number(found.offset));
    return buffer.toString('utf8').replace(/\u0000+$/, '');
  } finally {
    closeSync(fd);
  }
}

/** Package-relative paths the plugin depends on. */
const DEPENDENCIES = {
  systemPrompt: 'node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js',
  tools: 'node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  session: 'node_modules/@deepseek-ai/dsh-session/lib/index.js',
  commands: 'node_modules/@deepseek-ai/dsh-commands/lib/index.js',
  connection: 'node_modules/@deepseek-ai/dsh-client-connection/lib/index.js',
};

/**
 * The contract this plugin relies on, expressed as text that must be present in the
 * host bundle. These are deliberately narrow: a rename or a signature change shows
 * up here, while an internal refactor does not.
 */
const CHECKS = [
  {
    name: 'systemPrompt sections',
    file: 'systemPrompt',
    // The section contract this plugin relies on: an ordered registry, and
    // `interpolate: false` keeping stored text literal.
    needles: ['interpolate: false', 'order', 'section('],
    why: 'the injected index is registered as a system-prompt section',
  },
  {
    name: 'tools service + register',
    file: 'tools',
    needles: ['super(ctx, "tools")', 'register('],
    why: 'every loci_* tool is registered through it',
  },
  {
    name: 'session turn/end event',
    file: 'session',
    needles: ['"turn/end"'],
    why: 'capture and the extractor schedule on turn/end',
  },
  {
    name: 'commands service + register',
    file: 'commands',
    needles: ['super(ctx, "commands")', 'register('],
    why: '/loci subcommands',
  },
  {
    name: 'connection service',
    file: 'connection',
    needles: ['super(ctx, "connection")'],
    why: 'the panel API routes hang off it',
  },
];

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const asarIndex = args.indexOf('--asar');
const explicit = asarIndex >= 0 ? args[asarIndex + 1] : undefined;
const archive = explicit ?? CANDIDATES.find((path) => path !== undefined && existsSync(path));

if (archive === undefined || !existsSync(archive)) {
  console.error('compat-probe: no host archive found; pass --asar <path to app.asar>');
  process.exit(2);
}

const manifest = readAsarFile(archive, 'dsh/package.json');
if (manifest === undefined) {
  console.error(`compat-probe: ${archive} has no dsh/package.json; is this a DeepSeek Harness install?`);
  process.exit(2);
}
const host = JSON.parse(manifest);

const texts = {};
for (const [key, relative] of Object.entries(DEPENDENCIES)) {
  texts[key] = readAsarFile(archive, `dsh/${relative}`);
}

const results = CHECKS.map((check) => {
  const text = texts[check.file];
  if (text === undefined) {
    return { ...check, status: 'missing-package', detail: `could not read ${DEPENDENCIES[check.file]}` };
  }
  const absent = check.needles.filter((needle) => !text.includes(needle));
  return absent.length === 0
    ? { ...check, status: 'ok', detail: check.needles.join(', ') }
    : { ...check, status: 'fail', detail: `missing: ${absent.join(', ')}` };
});

const failures = results.filter((row) => row.status !== 'ok');
const summary = {
  hostVersion: host.version,
  archive,
  checks: results.map(({ name, status, detail, why }) => ({ name, status, detail, why })),
  passed: results.length - failures.length,
  failed: failures.length,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`host      : ${host.version}`);
  console.log(`archive   : ${archive}`);
  console.log('');
  for (const row of summary.checks) {
    const mark = row.status === 'ok' ? 'ok  ' : 'FAIL';
    console.log(`[${mark}] ${row.name.padEnd(28)} ${row.detail}`);
  }
  console.log('');
  console.log(`${summary.passed}/${summary.checks.length} checks passed`);
}

process.exit(failures.length === 0 ? 0 : 1);
