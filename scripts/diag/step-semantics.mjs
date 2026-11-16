#!/usr/bin/env node
/**
 * Does `phase.step` reset per turn, or grow monotonically across the whole session?
 *
 * This decides whether `payload.step === 1` means "first step of this turn" or "first step of the
 * session". The recall assist depends on the latter reading; the rewrite rescue needs the former.
 * Getting it wrong would make the rescue fire once, ever.
 */
import { readFileSync } from 'node:fs';

const asar = 'D:/Programs/DeepseekHarness/resources/app.asar';
const buf = readFileSync(asar);
const jsonSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.slice(16, 16 + jsonSize).toString('utf8'));
const baseOffset = 16 + jsonSize;
const dataStart = baseOffset + (4 - (baseOffset % 4)) % 4;

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (entry.files !== undefined) walk(entry, path, out);
    else out.push({ path, size: Number(entry.size ?? 0), offset: Number(entry.offset ?? 0) });
  }
  return out;
}

const file = walk(header.files.dsh, 'dsh', []).find((f) => f.path.endsWith('dsh-agent-loop/lib/index.js'));
const text = buf.slice(dataStart + file.offset, dataStart + file.offset + file.size).toString('utf8');
const lines = text.split('\n');

// Find the turn() method and print it, looking for where step is reset.
const turnStart = lines.findIndex((line) => /async turn\(\)/.test(line));
console.log(`turn() at line ${turnStart + 1}`);
for (let i = turnStart; i < Math.min(turnStart + 40, lines.length); i += 1) {
  console.log(`${i + 1}: ${lines[i]}`);
}

console.log('\n=== every assignment to phase.step ===');
lines.forEach((line, index) => {
  if (/phase\.step\s*=/.test(line)) console.log(`${index + 1}: ${line.trim()}`);
});
