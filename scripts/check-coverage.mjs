#!/usr/bin/env node
/**
 * Coverage gate: run the test suite with Node's built-in coverage and fail when
 * the loaded host sources fall below the thresholds.
 *
 * Scope is expressed as an **include** list (`src/host/**`), not an exclude
 * list: a path-exclude was silently ignored on Linux and quietly counted the
 * browser bundle and the MCP transport, so the same commit measured 86% on
 * Windows and 78% on Ubuntu. An include list behaves the same everywhere.
 *
 * Node reports four numbers — lines, branches, functions, and (since v22) a
 * combined "lines covered / total lines" figure. Gating only on lines let the
 * suite drift to 62% branch coverage while the headline still read "86%"; the
 * branch and function floors exist so the number in the README means what a
 * reader assumes it means.
 *
 * The browser bundle has its own test (slot registration) and the MCP facade has
 * a protocol integration test that spawns it; neither reaches lines by being
 * imported in-process, so neither is counted here.
 */
import { spawnSync } from 'node:child_process';

const THRESHOLD = Object.freeze({
  lines: 80,
  // Branch coverage is lower by nature: many guards exist for states a unit test
  // cannot reach (retry exhaustion, permission errors, SQLite fault paths).
  branches: 55,
  functions: 70,
});

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
if (result.status !== 0) {
  console.error(output.slice(-4000));
  console.error('tests failed; coverage gate cannot pass');
  process.exit(1);
}

// The spec reporter prefixes with `ℹ`, the TAP reporter (Linux CI) with `#`.
// Columns: all files | line % | branch % | function %
const match = output.match(/^[ℹ#]\s+all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/m);
if (match === null) {
  console.error(output.slice(-4000));
  console.error('coverage table not found');
  process.exit(1);
}
const measured = {
  lines: Number(match[1]),
  branches: Number(match[2]),
  functions: Number(match[3]),
};

const failures = Object.entries(THRESHOLD).filter(([metric, floor]) => measured[metric] < floor);

console.log(
  `coverage over src/host — lines ${measured.lines}% (>=${THRESHOLD.lines}) · ` +
    `branches ${measured.branches}% (>=${THRESHOLD.branches}) · ` +
    `functions ${measured.functions}% (>=${THRESHOLD.functions})`,
);

if (failures.length > 0) {
  for (const [metric, floor] of failures) {
    console.error(`${metric} coverage below threshold: ${measured[metric]}% < ${floor}%`);
  }
  process.exit(1);
}
