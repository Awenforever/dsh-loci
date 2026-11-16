#!/usr/bin/env node
/** Is the curation listener present in the installed bundle, and are both listeners identical? */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mods = join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-loci');
const index = readFileSync(join(mods, 'src', 'host', 'index.js'), 'utf8');
const capture = readFileSync(join(mods, 'src', 'host', 'capture', 'capture.js'), 'utf8');

console.log('version                  ', JSON.parse(readFileSync(join(mods, 'package.json'), 'utf8')).version);
console.log('curation holder          ', /const curation = \{ trigger: undefined \}/.test(index));
console.log('main-context listener    ', /ctx\.on\('agent\/disposed'/.test(index));
console.log('curate audit append      ', /audit\.append\('curate'/.test(index));
console.log('capture listener         ', /ctx\.on\('agent\/disposed'/.test(capture));

const at = index.indexOf("ctx.on('agent/disposed'");
console.log('\n=== main-context listener ===');
console.log(index.slice(Math.max(0, at - 600), at + 800));
