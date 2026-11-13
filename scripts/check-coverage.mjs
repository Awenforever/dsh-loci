#!/usr/bin/env node
/**
 * Coverage gate: run the test suite with Node's built-in coverage and fail when
 * the loaded host sources fall below the threshold.
 *
 * Scope is expressed as an **include** list (`src/host/**`), not an exclude
 * list: a path-exclude was silently ignored on Linux and quietly counted the
 * browser bundle and the MCP transport, so the same commit measured 86% on
 * Windows and 78% on Ubuntu. An include list behaves the same everywhere.
 *
 * The browser bundle has its own test (slot registration) and the MCP facade has
 * a protocol integration test that spawns it; neither reaches lines by being
 * imported in-process, so neither is counted here.
 */
import { spawnSync } from 'node:child_process';

const THRESHOLD = 80;

const result = spawnSync(
  process.execPath,
  [
    '--disable-warning=ExperimentalWarning',
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-include=src/host/**',
    'test/unit/*.test.mjs',
    'test/integration/*.test.mjs',
  ],
  { encoding: 'utf8', cwd: process.cwd() },
);

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
// The spec reporter prefixes with `ℹ`, the TAP reporter (Linux CI) with `#`.
const match = output.match(/^[ℹ#]\s+all files\s+\|\s+([\d.]+)/m);
if (result.status !== 0) {
  console.error(output.slice(-4000));
  console.error('tests failed; coverage gate cannot pass');
  process.exit(1);
}
if (match === null) {
  console.error(output.slice(-4000));
  console.error('coverage table not found');
  process.exit(1);
}
const lines = Number(match[1]);
console.log(`line coverage ${lines}% over src/host (threshold ${THRESHOLD}%)`);
if (lines < THRESHOLD) {
  console.error(`coverage below threshold: ${lines}% < ${THRESHOLD}%`);
  process.exit(1);
}
