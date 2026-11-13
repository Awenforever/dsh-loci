/**
 * Plugin configuration: defaults, the Schemastery schema the Loader validates,
 * and the one reader every consumer uses.
 *
 * Two shapes reach `apply`:
 * - an ordinary value, for a field that may only change on restart;
 * - a live `{ get() }` reference, for a field declared `.volatile()`.
 * `cfgValue()` answers both, so a field may be promoted to volatile later
 * without touching a single read site.
 * @module dsh-loci/config
 */

/**
 * Resolve Schemastery without making it a hard activation dependency: a host
 * that cannot resolve the peer still boots the plugin with our defaults and
 * no Config schema (the Loader then passes the raw row config through).
 */
let z = null;
try {
  const mod = await import('@deepseek-ai/schemastery');
  z = mod?.default ?? mod;
} catch {
  z = null;
}

/** Marker so the loader/diagnostics can tell "no schema" from "empty schema". */
export const HAS_CONFIG_SCHEMA = z !== null && typeof z?.object === 'function';

/** Every tunable, with the value used when a row (or a broken row) omits it. */
export const DEFAULTS = Object.freeze({
  /** Explicit Harness home override; empty means `$DSH_HOME` then `~/.dsh`. */
  home: '',
  /** Scope a `loci_write` without an explicit scope lands in. */
  defaultScope: 'workspace',
  /**
   * Hard byte budget for the whole injected section (header + rules + index).
   * Calibrated on a real Host: a 5,039-byte mixed-CJK section measured ~2,100
   * input tokens, so 3,584 bytes lands under the 1.5k-token steady-state budget
   * while the 16,384-byte ceiling stays under the 4k hard cap.
   */
  sectionMaxBytes: 3584,
  /** Byte ceiling for the rules block inside that budget. */
  rulesMaxBytes: 1024,
  /** Most index lines rendered, independent of the byte budget. */
  indexMaxEntries: 200,
  /** Longest single index line (title is clipped to fit). */
  indexLineMaxChars: 120,
  /** 'off' | 'session-start' — one bounded assist block on the first step. */
  recallAssist: 'off',
  /** Byte ceiling for that assist block. */
  recallAssistBytes: 512,
  /** 'rules' | 'off' — deterministic durable-fact capture at turn end. */
  captureMode: 'rules',
  /** Most capture passes per session. */
  captureMaxPerSession: 3,
  /** How long after a completed turn the capture pass runs. */
  captureDebounceMs: 30000,
  /** Longest sentence the statement extractor will keep. */
  captureMaxPerStatementChars: 200,
  /** Write one episodic session summary when a root agent is disposed. */
  summaryOnDispose: true,
  /** 'sweep' | 'off' — periodic TTL/merge/reindex maintenance. */
  maintenanceMode: 'sweep',
  /** Hours between maintenance sweeps. */
  maintenanceIntervalHours: 6,
  /** Rotate audit.jsonl at this size. */
  auditMaxBytes: 8388608,
  /** Retained audit generations. */
  auditKeep: 5,
  /** Bigram Jaccard at which a write reports a possible duplicate. */
  dedupeSimilarity: 0.8,
  /** 'redact' | 'reject' — what a high-confidence secret pattern does on write. */
  secretPolicy: 'redact',
  /** 'off' | 'http' — optional embedding channel. */
  vectorMode: 'off',
  vectorEndpoint: '',
  vectorModel: '',
  vectorTimeoutMs: 3000,
  /** Cosine floor for a vector-only hit. */
  vectorMinScore: 0.55,
  /** Default page size for `loci_search`. */
  searchLimitDefault: 10,
  /** Largest accepted page size. */
  searchLimitMax: 50,
  /** Include `global` scope in a search whose scope is not explicit. */
  includeGlobal: true,
  /** Days an unreviewed candidate survives before maintenance archives it. */
  candidateTtlDays: 30,
  /** Days a `working` entry survives. */
  workingTtlDays: 7,
  /** Allow `op:'purge'` to physically delete revisions. */
  allowHardDelete: false,
  /** Ask the registry for a newer version when the card is opened. */
  updateCheck: true,
  /** Registry used by that check; point it at a mirror when npmjs.org is slow. */
  updateRegistry: 'https://registry.npmjs.org',
  /** 'error' | 'info' | 'debug'. */
  logLevel: 'info',
});

/**
 * Allowed values, kept next to the defaults so the schema and the runtime
 * guards cannot drift apart.
 */
export const ENUMS = Object.freeze({
  defaultScope: ['workspace', 'project', 'global'],
  recallAssist: ['off', 'session-start'],
  captureMode: ['rules', 'off'],
  maintenanceMode: ['sweep', 'off'],
  secretPolicy: ['redact', 'reject'],
  vectorMode: ['off', 'http'],
  logLevel: ['error', 'info', 'debug'],
});

function buildSchema() {
  return z.object({
    home: z.string().default(DEFAULTS.home),
    defaultScope: z.union(ENUMS.defaultScope).default(DEFAULTS.defaultScope).volatile(),
    sectionMaxBytes: z.number().step(1).min(1024).max(16384).default(DEFAULTS.sectionMaxBytes).volatile(),
    rulesMaxBytes: z.number().step(1).min(0).max(8192).default(DEFAULTS.rulesMaxBytes).volatile(),
    indexMaxEntries: z.number().step(1).min(1).max(2000).default(DEFAULTS.indexMaxEntries).volatile(),
    indexLineMaxChars: z.number().step(1).min(40).max(400).default(DEFAULTS.indexLineMaxChars).volatile(),
    recallAssist: z.union(ENUMS.recallAssist).default(DEFAULTS.recallAssist).volatile(),
    recallAssistBytes: z.number().step(1).min(128).max(2048).default(DEFAULTS.recallAssistBytes).volatile(),
    captureMode: z.union(ENUMS.captureMode).default(DEFAULTS.captureMode).volatile(),
    captureMaxPerSession: z.number().step(1).min(0).max(20).default(DEFAULTS.captureMaxPerSession).volatile(),
    captureDebounceMs: z.number().step(500).min(0).max(600000).default(DEFAULTS.captureDebounceMs).volatile(),
    captureMaxPerStatementChars: z.number().step(1).min(40).max(400).default(DEFAULTS.captureMaxPerStatementChars).volatile(),
    summaryOnDispose: z.boolean().default(DEFAULTS.summaryOnDispose).volatile(),
    maintenanceMode: z.union(ENUMS.maintenanceMode).default(DEFAULTS.maintenanceMode).volatile(),
    maintenanceIntervalHours: z.number().step(0.5).min(0.5).max(168).default(DEFAULTS.maintenanceIntervalHours).volatile(),
    auditMaxBytes: z.number().step(1024).min(65536).max(268435456).default(DEFAULTS.auditMaxBytes),
    auditKeep: z.number().step(1).min(1).max(20).default(DEFAULTS.auditKeep),
    dedupeSimilarity: z.number().min(0.5).max(1).default(DEFAULTS.dedupeSimilarity).volatile(),
    secretPolicy: z.union(ENUMS.secretPolicy).default(DEFAULTS.secretPolicy).volatile(),
    vectorMode: z.union(ENUMS.vectorMode).default(DEFAULTS.vectorMode).volatile(),
    vectorEndpoint: z.string().default(DEFAULTS.vectorEndpoint).volatile(),
    vectorModel: z.string().default(DEFAULTS.vectorModel).volatile(),
    vectorTimeoutMs: z.number().step(100).min(500).max(30000).default(DEFAULTS.vectorTimeoutMs).volatile(),
    vectorMinScore: z.number().min(0).max(1).default(DEFAULTS.vectorMinScore).volatile(),
    searchLimitDefault: z.number().step(1).min(1).max(50).default(DEFAULTS.searchLimitDefault).volatile(),
    searchLimitMax: z.number().step(1).min(1).max(50).default(DEFAULTS.searchLimitMax).volatile(),
    includeGlobal: z.boolean().default(DEFAULTS.includeGlobal).volatile(),
    candidateTtlDays: z.number().step(1).min(0).max(3650).default(DEFAULTS.candidateTtlDays).volatile(),
    workingTtlDays: z.number().step(1).min(0).max(3650).default(DEFAULTS.workingTtlDays).volatile(),
    allowHardDelete: z.boolean().default(DEFAULTS.allowHardDelete),
    updateCheck: z.boolean().default(DEFAULTS.updateCheck).volatile(),
    updateRegistry: z.string().default(DEFAULTS.updateRegistry).volatile(),
    logLevel: z.union(ENUMS.logLevel).default(DEFAULTS.logLevel).volatile(),
  });
}

/**
 * The schema exported to the Loader. `undefined` means this host cannot
 * resolve Schemastery; the row config is then used as-is over {@link DEFAULTS}.
 */
export const Config = HAS_CONFIG_SCHEMA ? buildSchema() : undefined;

/**
 * Read one config field in either shape.
 * @param config - plugin config from `apply`, possibly holding live refs.
 * @param key - field name.
 * @returns the current value, or `undefined` when absent.
 */
export function cfgValue(config, key) {
  const value = config?.[key];
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/**
 * Read one field and coerce it to its declared type, falling back to the
 * default on absence or a bad value. This is the only config reader used by
 * the rest of the plugin.
 * @param config - plugin config from `apply`.
 * @param key - field name.
 * @returns a value of the default's type.
 */
export function cfg(config, key) {
  const fallback = DEFAULTS[key];
  const raw = cfgValue(config, key);
  if (raw === undefined || raw === null) return fallback;
  if (typeof fallback === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof fallback === 'boolean') return raw === true || raw === 'true';
  if (typeof fallback === 'string') {
    const s = String(raw);
    if (ENUMS[key] !== undefined && !ENUMS[key].includes(s)) return fallback;
    return s;
  }
  return raw;
}

/**
 * Project the live config into a plain object of effective values, used by
 * paths, the store, and diagnostics.
 * @param config - plugin config from `apply`.
 * @returns a frozen plain object with every key in {@link DEFAULTS}.
 */
export function effectiveConfig(config) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = cfg(config, key);
  return Object.freeze(out);
}
