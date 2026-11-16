#!/usr/bin/env node
/** Is the question tracker present in the installed bundle, and in a live scope? */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mods = join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-loci');
const text = readFileSync(join(mods, 'src', 'host', 'index.js'), 'utf8');
const version = JSON.parse(readFileSync(join(mods, 'package.json'), 'utf8')).version;

const checks = {
  version,
  'Map defined': /const lastUserText = new Map\(\)/.test(text),
  'tracker registered': /ctx\.on\('session\/event'/.test(text),
  'firstTextOf defined': /function firstTextOf/.test(text),
  'resolveContext reads the Map': /lastUserText\.get\(session\.id\)/.test(text),
};
for (const [name, value] of Object.entries(checks)) console.log(`${name.padEnd(28)} ${value}`);

const mapAt = text.indexOf('const lastUserText = new Map');
const sectionAt = text.indexOf('const indexSection = createIndexSection');
const trackerAt = text.indexOf("ctx.on('session/event'");
console.log('\noffsets:');
console.log(`  Map               ${mapAt}`);
console.log(`  createIndexSection ${sectionAt}`);
console.log(`  tracker listener   ${trackerAt}`);
console.log(`  Map before section: ${mapAt > 0 && mapAt < sectionAt}`);

// Print the tracker block so its scope is visible.
const from = Math.max(0, trackerAt - 700);
console.log('\n=== tracker block context ===');
console.log(text.slice(from, trackerAt + 700));
