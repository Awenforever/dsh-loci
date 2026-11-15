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
 * Find the project root: the nearest ancestor holding a `.git` entry.
 *
 * Returns the directory itself when nothing is found, which keeps `project` equal to
 * `workspace` for a plain directory. That collapse is why {@link findProjectRootInfo} exists:
 * a caller deciding *where to write* needs to know whether a real project boundary was found,
 * and "the path we started from" is not one.
 *
 * @param cwd - session working directory.
 * @returns the canonical project root.
 */
export function findProjectRoot(cwd) {
  return findProjectRootInfo(cwd).root;
}

/**
 * Find the project root and say whether a `.git` entry was actually found.
 * @param cwd - session working directory.
 * @returns `{root, found}`.
 */
export function findProjectRootInfo(cwd) {
  const start = canonicalDir(cwd);
  const cached = projectRootCache.get(start);
  if (cached !== undefined) return cached;
  let current = start;
  for (let depth = 0; depth < MAX_ROOT_DEPTH; depth += 1) {
    if (existsSync(join(current, '.git'))) {
      const answer = { root: current, found: true };
      projectRootCache.set(start, answer);
      return answer;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const answer = { root: start, found: false };
  projectRootCache.set(start, answer);
  return answer;
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
 *
 * When the host does not supply a cwd, the identity is **explicitly unresolved** rather
 * than borrowed from `process.cwd()`. Borrowing it meant every cwd-less session and every
 * panel request shared one scope keyed to wherever the Host process happened to be
 * installed — a silent cross-project bucket, and the opposite of what the explicit-scope
 * invariant promises. An unresolved key appears in no other session's read set, so the
 * failure is visible (the panel labels it "unresolved workspace") instead of a quiet leak.
 *
 * @param options - `sessionId`, `cwd`.
 * @returns `{session, workspace, project, global, labels, cwd, projectRoot}`.
 */
export function resolveScopes({ sessionId, cwd }) {
  const requested = typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
  const dir = requested === undefined ? undefined : canonicalDir(requested);
  const info = dir === undefined ? undefined : findProjectRootInfo(dir);
  const projectRoot = info?.root;
  const unresolved = dir === undefined;
  return {
    session: `session:${sessionId ?? 'unknown'}`,
    workspace: unresolved ? 'workspace:unresolved' : pathKey('workspace', dir),
    project: unresolved ? 'project:unresolved' : pathKey('project', projectRoot),
    global: 'global:',
    labels: {
      session: sessionId ? `session ${sessionId}` : 'session',
      workspace: unresolved ? 'unresolved workspace' : basename(dir) || dir,
      project: unresolved ? 'unresolved project' : basename(projectRoot) || projectRoot,
      global: 'global',
    },
    cwd: dir,
    projectRoot,
    projectRootFound: info?.found === true,
  };
}

/**
 * Where a write lands when the caller did not name a scope.
 *
 * `auto` means "the project if this directory is really inside one, otherwise this
 * conversation". The old rule was always `workspace`, which is right only when a workspace
 * holds one project — on a machine where one directory carries several independent
 * repositories, it merges every product's facts into one bucket and puts a release rule in
 * front of an unrelated session. Falling back to `session` keeps an unresolvable directory
 * from silently leaking across conversations; sharing is then an explicit choice.
 *
 * @param scopes - identity from {@link resolveScopes}.
 * @param options - `override` (a per-session choice) and `configured` (`config.defaultScope`).
 * @returns `{mode, scope, key, label, reason}`.
 */
export function effectiveWriteScope(scopes, options = {}) {
  const requested = [options.override, options.configured].find(
    (value) => typeof value === 'string' && value.length > 0,
  );
  const mode =
    requested === undefined || requested === 'auto'
      ? scopes.projectRootFound
        ? 'project'
        : 'session'
      : SCOPE_KINDS.includes(requested)
        ? requested
        : 'auto';
  const scope = mode === 'auto' ? (scopes.projectRootFound ? 'project' : 'session') : mode;
  // A caller may hand in a partial identity (tests, older wiring). Landing on a scope with no
  // key would write with `undefined` and vanish without an error, so fall back to the one key
  // that has always existed.
  const resolvedScope = typeof scopes[scope] === 'string' ? scope : 'workspace';
  const reason =
    requested === undefined || requested === 'auto'
      ? scopes.projectRootFound
        ? 'auto: this directory is inside a project'
        : 'auto: no project found, so this stays in this conversation'
      : `chosen for this conversation: ${resolvedScope}`;
  return {
    mode: requested ?? 'auto',
    scope: resolvedScope,
    key: scopes[resolvedScope],
    label: scopes.labels?.[resolvedScope],
    reason,
  };
}

/**
 * The modes a person can choose for one conversation, with the labels the panel shows.
 * @returns ordered `{value, label}` pairs.
 */
export function scopeChoices() {
  return [
    { value: 'auto', label: 'Automatic' },
    { value: 'project', label: 'This project' },
    { value: 'session', label: 'This conversation only' },
    { value: 'workspace', label: 'Whole workspace' },
    { value: 'global', label: 'Everywhere (global)' },
  ];
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
    // One explicit kind means exactly that key. `includeGlobal` used to be a
    // no-op here (both branches were identical), which made the option a lie.
    const keys = [scopes[options.scope]];
    if (includeGlobal && options.scope !== 'global') keys.push(scopes.global);
    return keys;
  }
  // Deduplicated: a directory that is not inside a repository maps `project` to the same key
  // as `workspace`, and a repeated key makes every count downstream report double.
  const keys = [...new Set([scopes.session, scopes.workspace, scopes.project])];
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
