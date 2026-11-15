/**
 * Which Harness version are we actually running on?
 *
 * `engines.dsh` is a range; a range is a promise nobody tested. This module resolves
 * the *installed* host package at activation time and records it, so the panel and
 * `doctor` can say "running on 0.2.2-rc.3" instead of leaving the user to guess
 * which point release the plugin met. It is best-effort by design: a plugin that
 * refuses to boot because it cannot read someone else's package.json is worse than
 * one that says "unknown".
 *
 * @module dsh-loci/host-version
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CANDIDATE_PATHS = [
  // The Host normally resolves as a peer dependency of the profile.
  '@deepseek-ai/dsh/package.json',
  // Desktop bundles keep it one level down.
  'dsh/package.json',
];

/**
 * Resolve the installed host version.
 *
 * @param from - module URL to resolve relative to (defaults to this module).
 * @returns `{version, path}` when found, `undefined` otherwise.
 */
export function detectHostVersion(from = import.meta.url) {
  // The Host sets this to its own package directory, and the plugin runs inside the
  // Host process, where reading an `app.asar/...` path works.
  const installDir = process.env.DSH_INSTALL_DIR;
  if (typeof installDir === 'string' && installDir.length > 0) {
    try {
      const manifest = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8'));
      if (typeof manifest?.version === 'string' && manifest.version.length > 0) {
        return { version: manifest.version, path: join(installDir, 'package.json') };
      }
    } catch {
      /* fall through to resolution */
    }
  }

  let require;
  try {
    require = createRequire(from);
  } catch {
    return undefined;
  }
  for (const candidate of CANDIDATE_PATHS) {
    try {
      const resolved = require.resolve(candidate);
      const manifest = JSON.parse(readFileSync(resolved, 'utf8'));
      if (typeof manifest?.version === 'string' && manifest.version.length > 0) {
        return { version: manifest.version, path: resolved };
      }
    } catch {
      /* try the next candidate */
    }
  }
  // Last resort: a sibling directory named `dsh` next to a cordis install.
  try {
    const resolved = require.resolve('@deepseek-ai/cordis/package.json');
    const sibling = join(dirname(dirname(resolved)), 'dsh', 'package.json');
    const manifest = JSON.parse(readFileSync(sibling, 'utf8'));
    if (typeof manifest?.version === 'string') return { version: manifest.version, path: sibling };
  } catch {
    /* nothing else to try */
  }
  return undefined;
}

/**
 * Compare a version against the `engines.dsh` range in one coarse way: does the
 * major/minor line match what this build declares it supports?
 *
 * Deliberately not a semver implementation — the plugin has no dependency on one.
 * It answers the only question that matters for a support message: "is this an
 * untested point release inside our declared range, or a different line entirely?"
 *
 * @param version - the detected host version.
 * @returns 'same-line' | 'other-line' | 'unknown'.
 */
export function hostLineOf(version) {
  const match = /^(\d+)\.(\d+)\./.exec(String(version ?? ''));
  if (match === null) return 'unknown';
  return `${match[1]}.${match[2]}` === '0.2' ? 'same-line' : 'other-line';
}
