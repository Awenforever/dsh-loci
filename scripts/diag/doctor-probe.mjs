#!/usr/bin/env node
/** Print the doctor report for a fresh test store so the new rows can be inspected. */
import { runDoctor } from '../../src/host/doctor.js';
import { DEFAULTS } from '../../src/host/config.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ensureMemoryRoot, layout } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const home = mkdtempSync(join(tmpdir(), 'loci-doctor-'));
const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
const paths = layout(root);
const store = new Store({ memoryRoot: root, paths, config: DEFAULTS, pluginVersion: '3.9.0' });

const report = runDoctor({
  store,
  paths,
  config: (key) => DEFAULTS[key],
  engines: undefined,
  hostVersion: undefined,
  pluginVersion: '3.9.0',
});
for (const check of report.checks) console.log(`[${check.level}] ${check.name}: ${check.detail}`);
store.close();
rmSync(home, { recursive: true, force: true });
