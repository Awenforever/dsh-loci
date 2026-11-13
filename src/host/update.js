/**
 * Version and update checking, behind the small `v1.0.0` badge.
 *
 * Three rules, learned from the plugins already in this ecosystem:
 * 1. **No network unless the user asks.** The badge renders the installed
 *    version immediately; a registry lookup happens only when the card is opened
 *    or the user presses "check for updates", and the answer is cached for six
 *    hours.
 * 2. **A failed check is not an error state.** Offline, a proxy, a private
 *    registry — all report "unknown", never a warning in the card.
 * 3. **Nothing auto-installs.** The endpoint reports that a newer version
 *    exists; upgrading stays a human decision made through the plugin manager.
 * @module dsh-loci/update
 */

/** How long one registry answer is trusted. */
const CACHE_MS = 6 * 60 * 60 * 1000;

/**
 * A registry call must not hang the panel. Eight seconds is long enough for a
 * slow international route and short enough that the card never looks stuck.
 */
const TIMEOUT_MS = 8000;

/**
 * The registry is a setting, not a constant: users behind a slow or blocked route
 * point it at a mirror (for example https://registry.npmmirror.com). The value
 * comes from the plugin's own config row, never from a project file.
 */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * Compare two semver strings well enough for an update hint.
 *
 * This is deliberately small: it answers "is B newer than A", which is all the
 * badge needs. Pre-release ordering follows semver §11 closely enough that a
 * `-rc.1` never looks newer than its final release.
 * @param a - installed version.
 * @param b - candidate version.
 * @returns positive when `b` is newer.
 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre] = String(value).split('-', 2);
    const numbers = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
    return { numbers, pre: pre ?? '' };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (right.numbers[i] ?? 0) - (left.numbers[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === '') return -1; // a release is newer than its prereleases
  if (right.pre === '') return 1;
  return right.pre > left.pre ? 1 : -1;
}

/**
 * Cached registry lookup.
 */
export class UpdateChecker {
  /**
   * @param options - `currentVersion`, `fetchImpl`, `log`, `now`, `registry`.
   */
  constructor(options) {
    this.currentVersion = options.currentVersion ?? '0.0.0';
    // `null` means "never touch the network" and must not fall back to the global.
    this.fetchImpl = options.fetchImpl === null ? null : (options.fetchImpl ?? globalThis.fetch);
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
    this.registry =
      typeof options.registry === 'string' && options.registry.length > 0
        ? options.registry.replace(/\/+$/, '')
        : DEFAULT_REGISTRY;
    this.cached = null;
    this.cachedAt = 0;
    this.inFlight = null;
    this.lastError = null;
    this.unpublished = false;
  }

  /** The installed version, with no I/O. */
  installed() {
    return { version: this.currentVersion, checkedAt: null, latestVersion: null, updateAvailable: false, status: 'idle' };
  }

  /**
   * The last answer, without any I/O — the default for a panel that must never
   * surprise the user with a network call.
   * @returns the cached answer, or the installed-only shape when none exists.
   */
  cachedOrInstalled() {
    return this.cached ?? this.installed();
  }

  /**
   * The current answer, refreshing at most once per cache window.
   * @param options - `force` bypasses the cache.
   * @returns `{version, latestVersion, updateAvailable, checkedAt, status, error?}`.
   */
  async check(options = {}) {
    const now = this.now();
    if (options.force !== true && this.cached !== null && now - this.cachedAt < CACHE_MS) return this.cached;
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.#fetchLatest()
      .then((latestVersion) => {
        const updateAvailable = latestVersion !== null && compareVersions(this.currentVersion, latestVersion) > 0;
        this.cached = {
          version: this.currentVersion,
          latestVersion,
          updateAvailable,
          checkedAt: this.now(),
          status: latestVersion === null ? (this.unpublished === true ? 'unpublished' : 'unavailable') : 'ok',
          ...(this.lastError === null ? {} : { error: this.lastError }),
        };
        this.cachedAt = this.now();
        return this.cached;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** One registry GET, with a timeout and no thrown errors. */
  async #fetchLatest() {
    if (typeof this.fetchImpl !== 'function') {
      this.lastError = 'no fetch implementation';
      return null;
    }
    try {
      const response = await this.fetchImpl(`${this.registry}/dsh-loci/latest`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 404) {
        // Not on the registry (yet): a fact to show, not a network failure.
        this.unpublished = true;
        this.lastError = 'not published';
        return null;
      }
      if (!response.ok) {
        this.lastError = `registry HTTP ${response.status}`;
        return null;
      }
      const payload = await response.json();
      const version = typeof payload?.version === 'string' ? payload.version : null;
      this.unpublished = false;
      if (version === null) {
        this.lastError = 'registry answer has no version';
        return null;
      }
      this.lastError = null;
      return version;
    } catch (error) {
      this.lastError = String(error?.message ?? error).slice(0, 120);
      this.log?.debug?.(`loci: update check failed: ${this.lastError}`);
      return null;
    }
  }
}
