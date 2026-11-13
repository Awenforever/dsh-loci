/**
 * The Loci schema, in one place, with the version that guards it.
 *
 * Revision rows are immutable: an edit writes a new `(id, revision)` row and
 * closes the old one with `valid_to` / `superseded_by`. That is what makes
 * "what did we believe last month" answerable without a second history table.
 * @module dsh-loci/store/schema
 */

/** Schema version this build writes and expects. */
export const SCHEMA_VERSION = 1;

/** DDL for a fresh database. Order matters: FTS and the head table follow `memory`. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
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

CREATE TABLE IF NOT EXISTS request_stat (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  session_id     TEXT,
  scope_key      TEXT,
  section_bytes  INTEGER NOT NULL,
  entries_listed INTEGER NOT NULL,
  entries_hidden INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_request_stat_ts ON request_stat (ts DESC);

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
