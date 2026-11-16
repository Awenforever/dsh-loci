/**
 * The Loci schema, in one place, with the version that guards it.
 *
 * Revision rows are immutable: an edit writes a new `(id, revision)` row and
 * closes the old one with `valid_to` / `superseded_by`. That is what makes
 * "what did we believe last month" answerable without a second history table.
 * @module dsh-loci/store/schema
 */

/** Schema version this build writes and expects. */
export const SCHEMA_VERSION = 7;

/**
 * DDL for the v2 per-entry usage table.
 *
 * Kept as its own constant because two paths must agree on it: a fresh database
 * (via {@link SCHEMA_SQL}) and an existing one (via the v1→v2 migration). A table
 * that only exists on new installs is the classic way a feature "works on my
 * machine".
 */
/**
 * DDL for the v3 lesson fields.
 *
 * A lesson stored as free text is unreadable six months later: you remember the rule
 * but not why it exists. `prevents` is the field that answer lives in, `pattern` and
 * `fix` split the problem from the remedy, and `when_condition` records the situation
 * the lesson was written for — stored, shown, never used to decide injection.
 */
export const MEMORY_LESSON_DDL = `
ALTER TABLE memory ADD COLUMN pattern TEXT;
ALTER TABLE memory ADD COLUMN fix TEXT;
ALTER TABLE memory ADD COLUMN prevents TEXT;
ALTER TABLE memory ADD COLUMN when_condition TEXT;
`;

export const MEMORY_USAGE_DDL = `
CREATE TABLE IF NOT EXISTS memory_usage (
  id               TEXT PRIMARY KEY,
  inject_count     INTEGER NOT NULL DEFAULT 0,
  read_count       INTEGER NOT NULL DEFAULT 0,
  last_injected_at INTEGER,
  last_read_at     INTEGER,
  mu_touched       REAL
);
CREATE INDEX IF NOT EXISTS ix_memory_usage_inject ON memory_usage (inject_count DESC);
CREATE INDEX IF NOT EXISTS ix_memory_usage_read ON memory_usage (read_count DESC);
`;

/** DDL for a fresh database. Order matters: FTS and the head table follow `memory`. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- v7: the trail behind the memory-unit counter. The counter lives in meta; this table only exists so
-- "why did the clock move" has an answer. The at column is wall clock, for a human reading the log,
-- and is never a criterion: no code path in this product decides anything from it.
CREATE TABLE IF NOT EXISTS mu_event (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  mu     REAL NOT NULL,
  add_n  INTEGER NOT NULL,
  use_n  INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  ord            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('working','episodic','semantic','procedural','rule')),
  scope          TEXT NOT NULL CHECK (scope IN ('session','workspace','project','global')),
  scope_key      TEXT NOT NULL,
  scope_label    TEXT NOT NULL DEFAULT '',
  title          TEXT NOT NULL,
  title_norm     TEXT NOT NULL DEFAULT '',
  body           TEXT NOT NULL,
  tags           TEXT NOT NULL DEFAULT '[]',
  entities       TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL CHECK (status IN ('candidate','verified','disputed','superseded','deleted')),
  trust_source   TEXT NOT NULL DEFAULT 'tool',
  flags          TEXT NOT NULL DEFAULT '[]',
  valid_from     INTEGER NOT NULL,
  valid_to       INTEGER,
  recorded_at    INTEGER NOT NULL,
  supersedes     TEXT,
  superseded_by  TEXT,
  evidence       TEXT NOT NULL DEFAULT '{}',
  source_session TEXT,
  source_event   INTEGER,
  verified_at    INTEGER,
  verified_by    TEXT,
  pinned         INTEGER NOT NULL DEFAULT 0,
  tier           INTEGER NOT NULL DEFAULT 2,
  importance     INTEGER NOT NULL DEFAULT 3,
  content_hash   TEXT NOT NULL,
  -- v3: a lesson's shape. All nullable; ordinary facts leave them empty.
  pattern        TEXT,
  fix            TEXT,
  prevents       TEXT,
  when_condition TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  -- v7: the memory unit this entry was born at. The store's only clock.
  mu_born        REAL,
  UNIQUE (id, revision)
);

CREATE INDEX IF NOT EXISTS ix_memory_head  ON memory (id, revision DESC);
CREATE INDEX IF NOT EXISTS ix_memory_scope ON memory (scope_key, status, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_memory_hash  ON memory (scope_key, content_hash);
CREATE INDEX IF NOT EXISTS ix_memory_title ON memory (scope_key, title_norm);
CREATE INDEX IF NOT EXISTS ix_memory_valid ON memory (valid_from, valid_to);
CREATE INDEX IF NOT EXISTS ix_memory_tier   ON memory (scope_key, status, tier, created_at);
CREATE INDEX IF NOT EXISTS ix_memory_recent ON memory (scope_key, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_memory_source ON memory (source_session);

CREATE TABLE IF NOT EXISTS memory_head (
  id       TEXT PRIMARY KEY,
  ord      INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  status   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entity (
  id         TEXT PRIMARY KEY,
  scope_key  TEXT NOT NULL,
  norm_name  TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'thing',
  aliases    TEXT NOT NULL DEFAULT '[]',
  link_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (scope_key, norm_name)
);
CREATE INDEX IF NOT EXISTS ix_entity_links ON entity (scope_key, link_count);

CREATE TABLE IF NOT EXISTS memory_entity (
  ord       INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'mention',
  PRIMARY KEY (ord, entity_id)
);
CREATE INDEX IF NOT EXISTS ix_memory_entity_entity ON memory_entity (entity_id);

CREATE TABLE IF NOT EXISTS memory_edge (
  src_id     TEXT NOT NULL,
  src_rev    INTEGER NOT NULL,
  dst_id     TEXT NOT NULL,
  dst_rev    INTEGER NOT NULL,
  relation   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src_id, src_rev, dst_id, dst_rev, relation)
);

CREATE TABLE IF NOT EXISTS embedding (
  ord        INTEGER PRIMARY KEY,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS token_stat (
  token TEXT PRIMARY KEY,
  df    INTEGER NOT NULL DEFAULT 0
);

${MEMORY_USAGE_DDL}


-- request_stat.source (v4) records which surface produced an injection: 'section' is the
-- per-request system-prompt index, 'assist' is the optional once-per-session recall block.
-- Without it the two were indistinguishable, so recallAssist injections left no trace
-- anywhere and "why did this entry appear" could not be answered for them.
-- Kept outside the CREATE TABLE body on purpose: SQLite's ALTER TABLE ... DROP COLUMN
-- re-parses the stored statement and fails with "incomplete input" when it holds comments.
CREATE TABLE IF NOT EXISTS request_stat (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  session_id     TEXT,
  scope_key      TEXT,
  section_bytes  INTEGER NOT NULL,
  entries_listed INTEGER NOT NULL,
  entries_hidden INTEGER NOT NULL,
  source         TEXT,
  cwd            TEXT
);
CREATE INDEX IF NOT EXISTS ix_request_stat_ts ON request_stat (ts DESC);
CREATE INDEX IF NOT EXISTS ix_request_stat_source ON request_stat (source);

-- session_scope (v5) remembers the memory boundary a person chose for one conversation.
-- The default cannot be inferred well: one workspace directory may hold several independent
-- repositories, and every session opened there reports the same cwd, so "the directory" is
-- neither the project nor the conversation. When a person picks a boundary, it has to survive
-- the next turn, which means it lives in the database rather than in the panel's state.
CREATE TABLE IF NOT EXISTS session_scope (
  session_id TEXT PRIMARY KEY,
  mode       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- injection_exempt (v6) lists the conversations that must never receive a memory section.
--
-- The memory manager is the reason it exists: a session that curates, merges and deletes
-- memories must not have those same memories injected into its own prompt, or it judges the
-- content with a prompt the content already shaped. Its access to memory is the tools
-- (loci_search, loci_get), which is reading — not being written into.
--
-- Before this table the property held only as a side effect of delegationDepth > 0, which is
-- a fact about delegation, not about being a manager. An exemption that is a coincidence is not
-- a guarantee, and the failure would be silent.
CREATE TABLE IF NOT EXISTS injection_exempt (
  session_id TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5 (
  tokens,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

/** Keys written into `meta` on first creation. */
export const META_KEYS = Object.freeze({
  schemaVersion: 'schema_version',
  pluginVersion: 'plugin_version',
  createdAt: 'created_at',
  indexRev: 'index_rev',
  lastMaintenance: 'last_maintenance',
  /**
   * The Memory Unit counter — the only clock this store has.
   *
   * There is no independent notion of time in dsh-loci: MU *is* time. A wall-clock timestamp may appear
   * in a row, but never as a criterion — only as a note for a person reading the log.
   */
  muNow: 'mu_now',
  /** The Harness version this store has been used with, recorded at activation. */
  hostVersion: 'host_version',
});

/**
 * Create every table on a fresh database.
 * @param db - open handle with no schema yet.
 * @param options - `pluginVersion`, `now`.
 */
export function applySchema(db, options = {}) {
  const now = options.now ?? Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SCHEMA_SQL);
    const set = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    set.run(META_KEYS.schemaVersion, String(SCHEMA_VERSION));
    set.run(META_KEYS.pluginVersion, String(options.pluginVersion ?? '0.0.0'));
    set.run(META_KEYS.createdAt, String(now));
    set.run(META_KEYS.indexRev, '1');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* keep the original failure */
    }
    throw error;
  }
}

/**
 * Read one meta value.
 * @param db - open handle.
 * @param key - meta key.
 * @returns the value, or `undefined`.
 */
export function readMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value;
}

/**
 * Write one meta value.
 * @param db - open handle.
 * @param key - meta key.
 * @param value - value to store.
 */
export function writeMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  );
}

/**
 * The schema version the database itself reports, falling back to
 * `PRAGMA user_version` for a database written before `meta` existed.
 * @param db - open handle.
 * @returns 0 for a brand-new file.
 */
export function databaseVersion(db) {
  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (hasMeta) {
    const value = readMeta(db, META_KEYS.schemaVersion);
    if (value !== undefined) return Number(value);
  }
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}
