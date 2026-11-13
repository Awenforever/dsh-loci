#!/usr/bin/env node
/**
 * Neutralise private identifiers on the public surface.
 *
 * The repository is public, and `GOVERNANCE.md` §4.1 says the public surface must
 * not carry private hostnames, OS user names or absolute home paths. The fixtures
 * and the recorded acceptance answers used a real machine name as sample data,
 * which is a leak of exactly that kind.
 *
 * The substitution is a *rename*, not a deletion: the corpus keeps the same
 * shape, so the recorded recall numbers stay meaningful.
 *
 * The patterns live in `.redaction.json`, which is **not** committed: a redaction
 * tool that ships the strings it removes is itself the leak. Copy
 * `.redaction.example.json` to `.redaction.json` and fill in your own host names
 * before running this on a different machine.
 *
 * Usage: node scripts/redact-public-surface.mjs [--check]
 */
import { existsSync, readFileSync, writeFileSync, globSync } from 'node:fs';

const checkOnly = process.argv.includes('--check');
const CONFIG = '.redaction.json';

if (!existsSync(CONFIG)) {
  console.error(`no ${CONFIG}; copy ${CONFIG.replace('.json', '.example.json')} and fill in the private identifiers`);
  process.exit(2);
}

/** Turn the JSON entries into [pattern, replacement] pairs. */
function loadReplacements() {
  const raw = JSON.parse(readFileSync(CONFIG, 'utf8'));
  return raw.map(({ match, flags = 'g', replace }) => [new RegExp(match, flags), replace]);
}

const REPLACEMENTS = loadReplacements();

const SKIP = /(^|[\\/])(\.git|node_modules|backups|exports|markdown)([\\/]|$)/;
const EXTENSIONS = /\.(md|json|ya?ml|js|mjs|ps1|sh|txt|svg)$/;

const files = globSync('**/*.{md,json,yml,yaml,js,mjs,ps1,sh,txt,svg}').filter(
  (file) => !SKIP.test(file) && EXTENSIONS.test(file) && file !== CONFIG,
);

let changed = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const before = text;
  for (const [pattern, replacement] of REPLACEMENTS) text = text.replace(pattern, replacement);
  if (text === before) continue;
  changed += 1;
  if (checkOnly) {
    console.log(`would change: ${file}`);
  } else {
    writeFileSync(file, text, 'utf8');
    console.log(`redacted: ${file}`);
  }
}
console.log(`${changed} file(s) ${checkOnly ? 'need' : 'were'} redacted`);
process.exitCode = 0;
