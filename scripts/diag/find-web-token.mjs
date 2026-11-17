// Find the DSH web token in Electron's Local Storage.
//
// The web GUI refuses requests without a per-launch token, and the token is deliberately not written to any
// file. But the desktop shell does hold it in the renderer's origin storage so a refresh keeps working — which
// means it is in the LevelDB file on disk. Scanning those bytes is the only way to drive the real GUI from a
// script; if it is not there, the honest answer is that the capture needs a human to bring the window forward.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.env.APPDATA ?? '', '@deepseek-ai', 'dsh-desktop', 'Local Storage', 'leveldb');
let files;
try {
  files = readdirSync(dir).filter((name) => name.endsWith('.ldb') || name.endsWith('.log'));
} catch (error) {
  console.error(`no leveldb at ${dir}: ${error.message}`);
  process.exit(1);
}

// 32-byte random, base64url → 43 chars of [A-Za-z0-9_-]; hex → 64 chars. Both are worth matching.
const patterns = [
  { name: 'base64url-43', re: /[A-Za-z0-9_-]{43}/g },
  { name: 'hex-64', re: /[0-9a-f]{64}/g },
];
const hits = new Map();
for (const file of files) {
  const path = join(dir, file);
  if (statSync(path).size > 8 * 1024 * 1024) continue;
  const text = readFileSync(path).toString('latin1');
  for (const { name, re } of patterns) {
    for (const match of text.matchAll(re)) {
      const key = `${name}:${match[0]}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
  }
}

// Keys that appear near the word "token" are far more likely to be the one.
let best = [];
for (const file of files) {
  const path = join(dir, file);
  if (statSync(path).size > 8 * 1024 * 1024) continue;
  const text = readFileSync(path).toString('latin1');
  for (const match of text.matchAll(/token[^A-Za-z0-9]{0,12}([A-Za-z0-9_-]{20,})/gi)) {
    best.push(match[1]);
  }
  for (const match of text.matchAll(/([A-Za-z0-9_-]{32,})[^A-Za-z0-9]{0,12}token/gi)) {
    best.push(match[1]);
  }
}

console.log(`scanned ${files.length} files, ${hits.size} candidate strings`);
console.log(`near the word "token": ${best.length}`);
for (const value of [...new Set(best)].slice(0, 6)) {
  console.log(`  ${value}  (${value.length} chars)`);
}
if (best.length === 0) {
  console.log('\nnothing near "token" — the GUI cannot be driven from a script without a human opening it.');
}
