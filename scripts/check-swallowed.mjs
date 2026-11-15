#!/usr/bin/env node
/**
 * Find statements that a fabricated newline swallowed into a `//` comment.
 *
 * The signature is exact: a patch that meant to insert a newline wrote the two characters
 * backslash-n instead, so a comment and the statement after it became one physical line and
 * everything past the marker is comment. It compiles, every gate passes, and the statement is
 * silently missing — which is how the panel's detail view came to render blank: the entry
 * lookup vanished, so the component threw on the first reference.
 *
 * Detection is deliberately narrow (literal `\n` followed by indentation and a keyword) so
 * ordinary prose that happens to contain "return" or "let" is not flagged.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === '.git' ? [] : walk(path);
    }
    return /\.(js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

const files = [...new Set([...walk('src'), ...walk('scripts'), ...walk('test'), 'client.js', 'index.js'])].filter(
  (file) => existsSync(file),
);

// A literal backslash-n, then indentation, then a statement keyword.
const SWALLOWED = /\\n\s*(const|let|var|return|await|if|for|while|import|export|function|class)\s/;
const offenders = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, index) => {
    if (!line.includes('\\n')) return;
    if (!SWALLOWED.test(line)) return;
    offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 160)}`);
  });
}

if (offenders.length === 0) {
  console.log(`scanned ${files.length} files: no statement is swallowed by a comment`);
} else {
  console.log(`scanned ${files.length} files: ${offenders.length} swallowed statement(s)`);
  for (const line of offenders) console.log('  ' + line);
  process.exitCode = 1;
}
