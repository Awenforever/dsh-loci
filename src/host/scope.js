/**
 * Scope resolution: which keys a session may read and write.
 *
 * Four scopes, each with its own key namespace, and a search never uses a
 * wildcard. `workspace` is the default write scope; `global` must be asked for
 * explicitly; the read set for a session is the union of its own session key,
 * its workspace and project keys, and (optionally) global.
 * @module dsh-loci/scope
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** All four scope kinds, most specific first. */
export const SCOPE_KINDS = Object.freeze(['session', 'workspace', 'project', 'global']);

/** How far up the tree the project-root search walks. */
const MAX_ROOT_DEPTH = 12;

/** Cache of directory -> canonical path, so hot tool calls do not stat. */
const realpathCache = new Map();

/** Cache of directory -> project root. */
const projectRootCache = new Map();

/**
 * Canonicalize a directory, falling back to `resolve` when it does not exist.
 * @param dir - absolute directory.
 * @returns the canonical path.
 */
export function canonicalDir(dir) {
  const abs = resolve(dir);
  const cached = realpathCache.get(abs);
  if (cached !== undefined) return cached;
  let canonical = abs;
  try {
    canonical = realpathSync.native(abs);
  } catch {
    canonical = abs;
  }
  if (realpathCache.size > 512) realpathCache.clear();
  realpathCache.set(abs, canonical);
  return canonical;
}

/**
 * Find the project root: the nearest ancestor holding a `.git` entry, else the
 * canonical directory itself. Worktrees therefore share one project scope.
 * @param cwd - session working directory.
 * @returns the canonical project root.
 */
export function findProjectRoot(cwd) {
  const start = canonicalDir(cwd);
  const cached = projectRootCache.get(start);
  if (cached !== undefined) return cached;
  let current = start;
  for (let depth = 0; depth < MAX_ROOT_DEPTH; depth += 1) {
    if (existsSync(join(current, '.git'))) {
      projectRootCache.set(start, current);
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  projectRootCache.set(start, start);
  return start;
}

/**
 * Short, stable key for a path: `sha256` over the canonical form, 16 hex chars.
 * @param prefix - key kind (`workspace`/`project`).
 * @param path - canonical path.
 * @returns the scope key.
 */
function pathKey(prefix, path) {
  const digest = createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 16);
  return `${prefix}:${digest}`;
}

/**
 * Build the scope identity of one session.
 * @param options - `sessionId`, `cwd`.
 * @returns `{session, workspace, project, global, labels, cwd, projectRoot}`.
 */
export function resolveScopes({ sessionId, cwd }) {
  const dir = typeof cwd === 'string' && cwd.length > 0 ? canonicalDir(cwd) : canonicalDir(process.cwd());
  const projectRoot = findProjectRoot(dir);
  return {
    session: `session:${sessionId ?? 'unknown'}`,
    workspace: pathKey('workspace', dir),
    project: pathKey('project', projectRoot),
    global: 'global:',
    labels: {
      session: sessionId ? `session ${sessionId}` : 'session',
      workspace: basename(dir) || dir,
      project: basename(projectRoot) || projectRoot,
      global: 'global',
    },
    cwd: dir,
    projectRoot,
  };
}

/**
 * The key and label for one explicit write scope.
 * @param scopes - identity from {@link resolveScopes}.
 * @param scope - one of {@link SCOPE_KINDS}.
 * @returns `{scope, key, label}`.
 */
export function selectScope(scopes, scope) {
  const kind = SCOPE_KINDS.includes(scope) ? scope : 'workspace';
  return { scope: kind, key: scopes[kind], label: scopes.labels[kind] };
}

/**
 * The read set for one search.
 * @param scopes - identity from {@link resolveScopes}.
 * @param options - `scope` (restrict to one kind), `includeGlobal` (default true).
 * @returns the explicit key list, most specific first.
 */
export function readScopeKeys(scopes, options = {}) {
  const includeGlobal = options.includeGlobal !== false;
  if (typeof options.scope === 'string' && SCOPE_KINDS.includes(options.scope)) {
    return options.scope === 'global' || includeGlobal ? [scopes[options.scope]] : [scopes[options.scope]];
  }
  const keys = [scopes.session, scopes.workspace, scopes.project];
  if (includeGlobal) keys.push(scopes.global);
  return keys;
}

/**
 * Whether a path is a directory (used to ignore a bogus session cwd).
 * @param path - candidate.
 * @returns true when it exists and is a directory.
 */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
