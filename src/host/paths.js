/**
 * Where Loci keeps its data, and the guards that keep every write inside it.
 *
 * The Harness keeps all user data under one root. Loci resolves that root the
 * same way `@deepseek-ai/dsh-home-paths` does — an explicit override, then
 * `$DSH_HOME`, then `~/.dsh` — and never writes anywhere else in the home
 * directory. Its own directory is `$DSH_HOME/memory/loci/`: under the
 * documented `memory` root, namespaced so another memory plugin can share it.
 * @module dsh-loci/paths
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Expand the tilde forms the Harness accepts in user-supplied paths.
 * @param path - configured path.
 * @returns the expanded path (unchanged when it has no supported prefix).
 */
export function expandHomePath(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Resolve the Harness home. Precedence mirrors the official resolver:
 * explicit config, then `$DSH_HOME`, then `~/.dsh`; blank values are unset.
 * @param configured - plugin `home` config.
 * @param env - environment mapping (tests pass a fake one).
 * @returns an absolute home path.
 */
export function resolveDshHome(configured, env = process.env) {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return resolve(expandHomePath(configured.trim()));
  }
  const fromEnv = env?.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
  return join(homedir(), '.dsh');
}

/**
 * The plugin's data directory.
 * @param dshHome - absolute Harness home.
 * @returns `$DSH_HOME/memory/loci`.
 */
export function resolveMemoryRoot(dshHome) {
  return join(dshHome, 'memory', 'loci');
}

/**
 * Assert that `target` is `root` or lives beneath it. Used before every
 * destructive file operation and by the export/import endpoints.
 * @param root - absolute directory that bounds the operation.
 * @param target - absolute candidate path.
 * @returns the resolved target.
 * @throws when the target escapes the root or either path is not absolute.
 */
export function assertInside(root, target) {
  const absRoot = realpathSyncSafe(resolve(root));
  const absTarget = resolve(target);
  const lexical =
    absTarget === absRoot || absTarget.startsWith(absRoot.endsWith(sep) ? absRoot : absRoot + sep);
  if (!lexical) throw new Error(`refusing path outside ${absRoot}: ${absTarget}`);
  // A lexical check alone is not enough: a symlink created inside the data
  // directory would pass it and then write outside. Resolve the deepest part of
  // the path that exists and require that to stay inside the root too.
  const probe = deepestExisting(absTarget);
  if (probe !== undefined) {
    const realProbe = realpathSyncSafe(probe);
    if (realProbe !== absRoot && !realProbe.startsWith(absRoot.endsWith(sep) ? absRoot : absRoot + sep)) {
      throw new Error(`refusing path outside ${absRoot}: ${absTarget} resolves to ${realProbe}`);
    }
  }
  return absTarget;
}

/** `realpathSync` that treats a missing path as "use it as given". */
function realpathSyncSafe(value) {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * The longest prefix of `target` that exists on disk.
 * @param target - an absolute path that may not exist yet.
 * @returns the existing prefix, or undefined when nothing does.
 */
function deepestExisting(target) {
  let current = target;
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * Create the data directories once. Missing directories are the plugin's
 * business; anything else surfaces.
 * @param memoryRoot - `$DSH_HOME/memory/loci`.
 * @returns the same root.
 */
export function ensureMemoryRoot(memoryRoot) {
  const root = resolve(memoryRoot);
  for (const dir of [root, join(root, 'backups'), join(root, 'exports'), join(root, 'markdown')]) {
    mkdirSync(dir, { recursive: true });
  }
  return root;
}

/** Where each artefact lives inside the data directory. */
export function layout(memoryRoot) {
  const root = resolve(memoryRoot);
  return Object.freeze({
    root,
    db: join(root, 'memory.db'),
    audit: join(root, 'audit.jsonl'),
    stats: join(root, 'stats.json'),
    lock: join(root, 'lock'),
    backups: join(root, 'backups'),
    exports: join(root, 'exports'),
    markdown: join(root, 'markdown'),
  });
}
