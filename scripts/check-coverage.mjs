#!/usr/bin/env node
/**
 * Coverage gate: run the test suite with Node's built-in coverage and fail when
 * the loaded host sources fall below the threshold.
 *
 * The threshold applies to the files the suite actually loads. Files outside
 * the model (the client bundle, the MCP transport) are excluded explicitly,
 * because counting them would reward importing code no test exercises.
 */
import { spawnSync } from 'node:child_process';

const THRESHOLD = 80;
const result = spawnSync(
  process.execPath,
  [
    '--disable-warning=ExperimentalWarning',
    '--test',
    '--experimental-test-coverage',
    // Excluded on purpose: the browser bundle is DOM code verified by its slot
    // registration test (and, on demand, CDP), and the MCP transport is a
    // separate process verified by a protocol integration test. Counting them
    // here would measure lines no in-process test can reach.
    '--test-coverage-exclude=client.js',
    '--test-coverage-exclude=src/mcp/**',
    'test/unit/*.test.mjs',
    'test/integration/*.test.mjs',
  ],
  { encoding: 'utf8', cwd: process.cwd() },
);

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const match = output.match(/^ℹ all files\s+\|\s+([\d.]+)/m);
if (result.status !== 0) {
  console.error(output);
  console.error('tests failed; coverage gate cannot pass');
  process.exit(1);
}
if (match === null) {
  console.error(output);
  console.error('coverage table not found');
  process.exit(1);
}
const lines = Number(match[1]);
console.log(`line coverage ${lines}% (threshold ${THRESHOLD}%)`);
if (lines < THRESHOLD) {
  console.error(`coverage below threshold: ${lines}% < ${THRESHOLD}%`);
  process.exit(1);
}
