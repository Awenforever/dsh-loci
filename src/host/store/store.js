/**
 * The memory store: one SQLite database, immutable revision rows, and the
 * lifecycle operations every surface (tools, panel, MCP, CLI) shares.
 *
 * Invariants this class owns:
 * - a fact is a chain of `(id, revision)` rows; an edit closes the old row and
 *   opens a new one, so history is never rewritten;
 * - `memory_head` always points at the newest row of each chain;
 * - `index_rev` changes only when the injected index could change, so a
 *   read-only turn never invalidates the prompt prefix;
 * - an injection gate of `status = 'verified'` is enforced here, not by
 *   callers, so no surface can inject an unverified fact by accident.
 * @module dsh-loci/store
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog } from './audit.js';
import { backupTo, closeDatabase, integrityCheck, openDatabase, quickCheck, tableCounts, withTransaction } from './db.js';
import { newEntityId, newMemoryId } from './ids.js';
import { migrate } from './migrate.js';
import { EmbeddingChannel, vectorToBlob } from './embedding.js';
import { META_KEYS, SCHEMA_VERSION, databaseVersion, readMeta, writeMeta } from './schema.js';
import { normalizeText, tokenStream, tokenize, buildQueryPlan } from './tokenize.js';
import { normalizeTitle, prepareForStorage } from '../inject/sanitize.js';

/** Ids that were revoked or never existed. */
export class MemoryNotFoundError extends Error {
  code = 'MEMORY_NOT_FOUND';
  constructor(id) {
    super(`memory not found: ${id}`);
    this.name = 'MemoryNotFoundError';
  }
}

/** Optimistic concurrency: the caller edited a revision that is no longer the head. */
export class RevisionConflictError extends Error {
  code = 'REVISION_CONFLICT';
  constructor(id, expected, actual) {
    super(`memory ${id} is at revision ${actual}, not ${expected}; re-read it and retry`);
    this.name = 'RevisionConflictError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** A caller input the store refuses to persist. */
export class MemoryRejectedError extends Error {
  code = 'MEMORY_REJECTED';
  constructor(message) {
    super(message);
    this.name = 'MemoryRejectedError';
  }
}

/** Fields an entry exposes to callers, without the internal `ord`. */
function mapRow(row) {
  if (row === undefined) return undefined;
  return {
    id: row.id,
    revision: Number(row.revision),
    kind: row.kind,
    scope: row.scope,
    scopeKey: row.scope_key,
    scopeLabel: row.scope_label,
    title: row.title,
    body: row.body,
    tags: JSON.parse(row.tags ?? '[]'),
    entities: JSON.parse(row.entities ?? '[]'),
    status: row.status,
    trustSource: row.trust_source,
    flags: JSON.parse(row.flags ?? '[]'),
    validFrom: Number(row.valid_from),
    validTo: row.valid_to === null || row.valid_to === undefined ? null : Number(row.valid_to),
    recordedAt: Number(row.recorded_at),
    supersedes: row.supersedes ?? null,
    supersededBy: row.superseded_by ?? null,
    evidence: JSON.parse(row.evidence ?? '{}'),
    sourceSession: row.source_session ?? null,
    sourceEvent: row.source_event === null || row.source_event === undefined ? null : Number(row.source_event),
    verifiedAt: row.verified_at === null || row.verified_at === undefined ? null : Number(row.verified_at),
    verifiedBy: row.verified_by ?? null,
    pinned: Number(row.pinned) === 1,
    importance: Number(row.importance),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
  };
}

/** The tier an entry occupies in the injected index; rules first, then pinned. */
function tierOf(kind, pinned) {
  if (kind === 'rule') return 0;
  if (pinned === 1 || pinned === true) return 1;
  if (kind === 'semantic') return 2;
  if (kind === 'procedural') return 3;
  return 4;
}

/** Statuses that may be injected or returned by default. */
export const INJECTABLE_STATUSES = Object.freeze(['verified']);

/**
 * Open (and, when needed, create or migrate) the database behind one plugin
 * activation.
 */
export class Store {
  /**
   * @param options - `memoryRoot`, `paths`, `config`, `log`, `pluginVersion`,
   *   `now`, `quoteVerifier`.
   */
  constructor(options) {
    this.memoryRoot = options.memoryRoot;
    this.paths = options.paths;
    this.config = options.config ?? {};
    this.live = options.live ?? ((key) => this.config[key]);
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
    this.quoteVerifier = options.quoteVerifier ?? (() => false);
    this.pluginVersion = options.pluginVersion ?? '0.0.0';
    this.readOnly = options.readOnly === true;
    this.db = openDatabase({ file: this.paths.db, readOnly: this.readOnly });
    this.audit = this.readOnly
      ? { append() {}, flush() {}, tail() { return []; }, close() {} }
      : new AuditLog({
          file: this.paths.audit,
          maxBytes: this.config.auditMaxBytes,
          keep: this.config.auditKeep,
          log: this.log,
        });
    this.migration = this.readOnly
      ? { from: databaseVersion(this.db), to: SCHEMA_VERSION, steps: [], backup: undefined }
      : migrate(this.db, {
          backupDir: this.paths.backups,
          pluginVersion: this.pluginVersion,
          log: this.log,
          now: this.now(),
        });
    this.vector = { mode: this.config.vectorMode ?? 'off', healthy: false, lastError: null, lastCheckedAt: null };
    this.embedding = new EmbeddingChannel({
      mode: this.config.vectorMode,
      endpoint: this.config.vectorEndpoint,
      model: this.config.vectorModel,
      timeoutMs: this.config.vectorTimeoutMs,
      minScore: this.config.vectorMinScore,
      log: this.log,
    });
    this.quoteChecked = 0;
  }

  /** Refuse a mutation on a read-only (MCP facade) handle. */
  #assertWritable() {
    if (this.readOnly === true) throw new MemoryRejectedError('this handle is read-only');
  }
  /** Close the database and flush the audit buffer. */
  close() {
    this.audit?.close();
    closeDatabase(this.db);
    this.db = undefined;
  }

  /** Current schema version of the open database. */
  schemaVersion() {
    return databaseVersion(this.db);
  }

  /** Monotonic index revision; changes only when the injected set may change. */
  indexRev() {
    return Number(readMeta(this.db, META_KEYS.indexRev) ?? '0');
  }

  /** Bump the index revision inside the caller's transaction. */
  bumpIndexRev() {
    writeMeta(this.db, META_KEYS.indexRev, String(this.indexRev() + 1));
  }

  /**
   * Persist one memory, applying the trust gate, dedupe, and revision rules.
   *
   * @param input - see {@link writeShape}.
   * @returns `{entry, created, updated, deduplicated, possibleDuplicates, warnings}`.
   */
  write(input) {
    this.#assertWritable();
    const now = this.now();
    const prepared = prepareForStorage(input, { secretPolicy: this.live('secretPolicy') });
    if (prepared.rejected) {
      throw new MemoryRejectedError(
        `memory contains a high-confidence secret (${prepared.redactions.join(', ')}) and secretPolicy is "reject"`,
      );
    }
    if (prepared.title.length === 0) throw new MemoryRejectedError('memory title must not be empty');
    if (prepared.body.length === 0) throw new MemoryRejectedError('memory body must not be empty');

    const kind = ['working', 'episodic', 'semantic', 'procedural', 'rule'].includes(input.kind)
      ? input.kind
      : 'semantic';
    const scope = input.scope ?? 'workspace';
    const scopeKey = input.scopeKey;
    if (typeof scopeKey !== 'string' || scopeKey.length === 0) {
      throw new MemoryRejectedError('scopeKey is required');
    }
    const trustSource = input.trustSource ?? 'tool';
    const evidence = prepared.evidence ?? {};
    const status = this.#resolveStatus({ input, prepared, evidence, trustSource });

    const contentHash = createHash('sha256')
      .update(`${normalizeTitle(prepared.title)}\n${normalizeText(prepared.body)}`, 'utf8')
      .digest('hex');
    const titleNorm = normalizeTitle(prepared.title);

    const existing = this.#findByHash(scopeKey, contentHash);
    if (existing !== undefined && input.force !== true) {
      return {
        entry: this.get(existing.id).entry,
        created: false,
        updated: false,
        deduplicated: true,
        possibleDuplicates: [],
        warnings: [],
      };
    }

    const sameTitle = this.#findByTitle(scopeKey, titleNorm);
    if ((input.op ?? 'create') === 'create' && sameTitle !== undefined && input.allowUpdateByTitle !== false) {
      return this.update(sameTitle.id, {
        ...input,
        expectedRevision: sameTitle.revision,
        status,
        kind,
        preparedOverride: prepared,
      });
    }

    const warnings = [];
    const possibleDuplicates = [];
    if (input.force !== true) {
      const similar = this.#findSimilar(scopeKey, prepared, contentHash);
      possibleDuplicates.push(...similar);
      if (similar.length > 0) {
        warnings.push(
          `similar memory already exists (${similar.map((hit) => hit.id).join(', ')}); pass force:true to keep both`,
        );
        if (input.requireUnique === true) {
          return { entry: null, created: false, updated: false, deduplicated: false, possibleDuplicates, warnings };
        }
      }
    }

    const id = input.id ?? newMemoryId(now);
    const ord = withTransaction(this.db, () => {
      const inserted = this.#insertRevision({
        id,
        revision: 1,
        kind,
        scope,
        scopeKey,
        scopeLabel: input.scopeLabel ?? '',
        title: prepared.title,
        titleNorm,
        body: prepared.body,
        tags: prepared.tags,
        entities: prepared.entities,
        status,
        trustSource,
        flags: prepared.flags,
        validFrom: Number.isFinite(input.validFrom) ? input.validFrom : now,
        validTo: Number.isFinite(input.validTo) ? input.validTo : null,
        supersedes: null,
        evidence,
        sourceSession: input.sourceSession ?? null,
        sourceEvent: Number.isSafeInteger(input.sourceEvent) ? input.sourceEvent : null,
        pinned: input.pinned === true ? 1 : 0,
        importance: Number.isInteger(input.importance) ? input.importance : 3,
        contentHash,
        createdAt: now,
        now,
        verifiedBy: status === 'verified' ? (input.verifiedBy ?? trustSource) : null,
        verifiedAt: status === 'verified' ? now : null,
      });
      this.bumpIndexRev();
      return inserted;
    });

    this.audit.append(
      'write',
      {
        id,
        rev: 1,
        op: 'create',
        kind,
        scope,
        scopeKey,
        status,
        bytes: Buffer.byteLength(prepared.title) + Buffer.byteLength(prepared.body),
        redactions: prepared.redactions.length,
        flags: prepared.flags,
      },
      { sync: true },
    );
    return {
      entry: this.get(id, { ord }).entry,
      created: true,
      updated: false,
      deduplicated: false,
      possibleDuplicates,
      warnings,
    };
  }

  /**
   * Write a new revision of an existing memory.
   * @param id - memory id.
   * @param input - the same shape as {@link Store.write} plus `expectedRevision`.
   */
  update(id, input) {
    this.#assertWritable();
    const now = this.now();
    const head = this.#headRow(id);
    if (head === undefined || head.status === 'deleted') throw new MemoryNotFoundError(id);
    if (Number.isSafeInteger(input.expectedRevision) && input.expectedRevision !== Number(head.row.revision)) {
      throw new RevisionConflictError(id, input.expectedRevision, Number(head.row.revision));
    }
    const prepared = input.preparedOverride ?? prepareForStorage(input, { secretPolicy: this.live('secretPolicy') });
    if (prepared.rejected) {
      throw new MemoryRejectedError(`memory contains a high-confidence secret (${prepared.redactions.join(', ')})`);
    }
    const evidence = prepared.evidence ?? {};
    const status =
      input.status ?? (prepared.instructionLike ? 'disputed' : head.row.status === 'verified' ? 'verified' : 'candidate');
    const revision = Number(head.row.revision) + 1;
    const contentHash = createHash('sha256')
      .update(`${normalizeTitle(prepared.title)}\n${normalizeText(prepared.body)}`, 'utf8')
      .digest('hex');

    const ord = withTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE memory SET valid_to = ?, status = 'superseded', superseded_by = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(now, `${id}@${revision}`, now, id, Number(head.row.revision));
      const inserted = this.#insertRevision({
        id,
        revision,
        kind: input.kind ?? head.row.kind,
        scope: input.scope ?? head.row.scope,
        scopeKey: input.scopeKey ?? head.row.scope_key,
        scopeLabel: input.scopeLabel ?? head.row.scope_label,
        title: prepared.title,
        titleNorm: normalizeTitle(prepared.title),
        body: prepared.body,
        tags: prepared.tags,
        entities: prepared.entities,
        status,
        trustSource: input.trustSource ?? head.row.trust_source,
        flags: prepared.flags,
        validFrom: Number.isFinite(input.validFrom) ? input.validFrom : now,
        validTo: Number.isFinite(input.validTo) ? input.validTo : null,
        supersedes: `${id}@${Number(head.row.revision)}`,
        evidence,
        sourceSession: input.sourceSession ?? null,
        sourceEvent: Number.isSafeInteger(input.sourceEvent) ? input.sourceEvent : null,
        pinned: input.pinned === true ? 1 : Number(head.row.pinned),
        importance: Number.isInteger(input.importance) ? input.importance : Number(head.row.importance),
        contentHash,
        createdAt: Number(head.row.created_at),
        now,
        verifiedBy: status === 'verified' ? (input.verifiedBy ?? 'tool') : null,
        verifiedAt: status === 'verified' ? now : null,
      });
      this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_edge (src_id, src_rev, dst_id, dst_rev, relation, created_at)
           VALUES (?, ?, ?, ?, 'supersedes', ?)`,
        )
        .run(id, revision, id, Number(head.row.revision), now);
      this.bumpIndexRev();
      return inserted;
    });

    this.audit.append(
      'write',
      {
        id,
        rev: revision,
        op: 'update',
        status,
        scopeKey: input.scopeKey ?? head.row.scope_key,
        bytes: Buffer.byteLength(prepared.title) + Buffer.byteLength(prepared.body),
        redactions: prepared.redactions.length,
        flags: prepared.flags,
      },
      { sync: true },
    );
    return {
      entry: this.get(id, { ord }).entry,
      created: false,
      updated: true,
      deduplicated: false,
      possibleDuplicates: [],
      warnings: [],
    };
  }

  /**
   * Insert many entries in one transaction, skipping the per-write duplicate
   * search. This is the import and benchmark path: the caller owns dedupe
   * (imports are all candidates, and a benchmark seeds synthetic rows).
   *
   * Why it exists: a bulk import of a thousand files otherwise pays a
   * similarity query and a commit per row; at 10k rows the real write path
   * costs about 22 ms per row, which turns a routine import into a minute-long
   * tool call.
   *
   * @param entries - `{kind, scope, scopeKey, scopeLabel, title, body, tags,
   *   entities, status, trustSource, evidence, sourceSession, sourceEvent}`.
   * @param options - `source` for the audit line.
   * @returns the new ids, in order.
   */
  writeMany(entries, options = {}) {
    this.#assertWritable();
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const now = this.now();
    const ids = [];
    withTransaction(this.db, () => {
      for (const input of entries) {
        const prepared = prepareForStorage(input, { secretPolicy: this.live('secretPolicy') });
        if (prepared.rejected) {
          throw new MemoryRejectedError(
            `memory contains a high-confidence secret (${prepared.redactions.join(', ')}) and secretPolicy is "reject"`,
          );
        }
        if (prepared.title.length === 0 || prepared.body.length === 0) {
          throw new MemoryRejectedError('memory title and body must not be empty');
        }
        const id = input.id ?? newMemoryId(now);
        const kind = ['working', 'episodic', 'semantic', 'procedural', 'rule'].includes(input.kind)
          ? input.kind
          : 'semantic';
        const status = ['candidate', 'verified', 'disputed'].includes(input.status) ? input.status : 'candidate';
        const trustSource = input.trustSource ?? 'import';
        this.#insertRevision({
          id,
          revision: 1,
          kind,
          scope: input.scope ?? 'workspace',
          scopeKey: input.scopeKey,
          scopeLabel: input.scopeLabel ?? '',
          title: prepared.title,
          titleNorm: normalizeTitle(prepared.title),
          body: prepared.body,
          tags: prepared.tags,
          entities: prepared.entities,
          status,
          trustSource,
          flags: prepared.flags,
          validFrom: Number.isFinite(input.validFrom) ? input.validFrom : now,
          validTo: Number.isFinite(input.validTo) ? input.validTo : null,
          supersedes: null,
          evidence: prepared.evidence ?? {},
          sourceSession: input.sourceSession ?? null,
          sourceEvent: Number.isSafeInteger(input.sourceEvent) ? input.sourceEvent : null,
          pinned: input.pinned === true ? 1 : 0,
          importance: Number.isInteger(input.importance) ? input.importance : 3,
          contentHash: createHash('sha256')
            .update(`${normalizeTitle(prepared.title)}\n${normalizeText(prepared.body)}`, 'utf8')
            .digest('hex'),
          createdAt: now,
          now,
          verifiedBy: status === 'verified' ? trustSource : null,
          verifiedAt: status === 'verified' ? now : null,
        });
        ids.push(id);
      }
      this.bumpIndexRev();
    });
    this.audit.append('import', { count: ids.length, source: options.source ?? 'bulk' }, { sync: true });
    return ids;
  }

  /**
   * Read one memory: the current revision plus, optionally, every revision and
   * its edges.
   * @param id - memory id.
   * @param options - `revision`, `includeHistory` (default true), `ord` (internal).
   * @returns `{entry, history, edges}`.
   */
  get(id, options = {}) {
    let row;
    if (Number.isSafeInteger(options.revision)) {
      row = this.db.prepare('SELECT * FROM memory WHERE id = ? AND revision = ?').get(id, options.revision);
    } else if (Number.isSafeInteger(options.ord)) {
      row = this.db.prepare('SELECT * FROM memory WHERE ord = ?').get(options.ord);
    } else {
      const head = this.#headRow(id);
      row = head?.row;
    }
    if (row === undefined) throw new MemoryNotFoundError(id);
    const includeHistory = options.includeHistory !== false;
    const history = includeHistory
      ? this.db
          .prepare('SELECT * FROM memory WHERE id = ? ORDER BY revision ASC')
          .all(id)
          .map((entry) => {
            const mapped = mapRow(entry);
            delete mapped.body;
            return mapped;
          })
      : [];
    const edges = this.db
      .prepare('SELECT relation, src_id, src_rev, dst_id, dst_rev, created_at FROM memory_edge WHERE src_id = ? OR dst_id = ?')
      .all(id, id)
      .map((edge) => ({ ...edge }));
    return { entry: mapRow(row), history, edges };
  }

  /**
   * Change only the trust state of the head revision.
   * @param id - memory id.
   * @param status - `verified` | `disputed` | `candidate`.
   * @param options - `actor`, `evidence`.
   */
  setTrust(id, status, options = {}) {
    this.#assertWritable();
    if (!['verified', 'disputed', 'candidate'].includes(status)) {
      throw new MemoryRejectedError(`unsupported trust status: ${status}`);
    }
    const head = this.#headRow(id);
    if (head === undefined) throw new MemoryNotFoundError(id);
    const now = this.now();
    const evidence = options.evidence === undefined ? head.row.evidence : JSON.stringify(options.evidence);
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE memory SET status = ?, evidence = ?, verified_at = ?, verified_by = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          status,
          evidence,
          status === 'verified' ? now : null,
          status === 'verified' ? (options.actor ?? 'panel') : null,
          now,
          id,
          Number(head.row.revision),
        );
      this.db.prepare('UPDATE memory_head SET status = ? WHERE id = ?').run(status, id);
      this.bumpIndexRev();
    });
    this.audit.append('verify', { id, rev: Number(head.row.revision), status, actor: options.actor ?? 'panel' }, { sync: true });
    return this.get(id).entry;
  }

  /**
   * Pin or unpin the head revision.
   * @param id - memory id.
   * @param pinned - target state.
   * @param actor - who asked.
   */
  setPinned(id, pinned, actor = 'panel') {
    this.#assertWritable();
    const head = this.#headRow(id);
    if (head === undefined) throw new MemoryNotFoundError(id);
    withTransaction(this.db, () => {
      this.db
        .prepare('UPDATE memory SET pinned = ?, tier = ?, updated_at = ? WHERE id = ? AND revision = ?')
        .run(pinned ? 1 : 0, tierOf(head.row.kind, pinned === true), this.now(), id, Number(head.row.revision));
      this.bumpIndexRev();
    });
    this.audit.append('verify', { id, rev: Number(head.row.revision), pinned: pinned === true, actor }, { sync: true });
    return this.get(id).entry;
  }

  /**
   * Soft-delete, restore, or purge one memory.
   * @param id - memory id.
   * @param options - `mode` (`soft`|`restore`|`purge`), `reason`, `confirm`, `actor`.
   */
  forget(id, options = {}) {
    this.#assertWritable();
    const mode = options.mode ?? 'soft';
    const head = this.#headRow(id);
    if (head === undefined) throw new MemoryNotFoundError(id);
    const now = this.now();

    if (mode === 'purge') {
      if (this.live('allowHardDelete') !== true) {
        throw new MemoryRejectedError('hard delete is disabled; set allowHardDelete:true to permit it');
      }
      if (options.confirm !== id) throw new MemoryRejectedError(`purge requires confirm: "${id}"`);
      const ords = this.db.prepare('SELECT ord FROM memory WHERE id = ?').all(id).map((row) => Number(row.ord));
      withTransaction(this.db, () => {
        for (const ord of ords) {
          this.db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(ord);
          this.db.prepare('DELETE FROM memory_entity WHERE ord = ?').run(ord);
          this.db.prepare('DELETE FROM embedding WHERE ord = ?').run(ord);
        }
        this.db.prepare('DELETE FROM memory WHERE id = ?').run(id);
        this.db.prepare('DELETE FROM memory_head WHERE id = ?').run(id);
        this.db.prepare('DELETE FROM memory_edge WHERE src_id = ? OR dst_id = ?').run(id, id);
        this.#recomputeTokenStats();
        this.bumpIndexRev();
      });
      this.audit.append('delete', { id, mode, actor: options.actor ?? 'panel', reason: options.reason ?? null }, { sync: true });
      return { id, mode, deleted: true };
    }

    if (mode === 'restore') {
      withTransaction(this.db, () => {
        this.db
          .prepare('UPDATE memory SET status = ?, deleted_at = NULL, updated_at = ? WHERE id = ? AND revision = ?')
          .run('candidate', now, id, Number(head.row.revision));
        this.db.prepare('UPDATE memory_head SET status = ? WHERE id = ?').run('candidate', id);
        this.bumpIndexRev();
      });
      this.audit.append('delete', { id, mode, actor: options.actor ?? 'panel' }, { sync: true });
      return { id, mode, deleted: false };
    }

    withTransaction(this.db, () => {
      this.db
        .prepare('UPDATE memory SET status = ?, deleted_at = ? WHERE id = ? AND revision = ?')
        .run('deleted', now, id, Number(head.row.revision));
      this.db.prepare('UPDATE memory_head SET status = ? WHERE id = ?').run('deleted', id);
      this.bumpIndexRev();
    });
    this.audit.append('delete', { id, mode: 'soft', actor: options.actor ?? 'panel', reason: options.reason ?? null }, { sync: true });
    return { id, mode: 'soft', deleted: true };
  }

  /**
   * The entries the injected index may show, in stable order.
   * @param options - `scopeKeys`, `now`, `limit`.
   * @returns rows ordered by tier then creation time.
   */
  indexEntries(options) {
    const keys = options.scopeKeys ?? [];
    if (keys.length === 0) return [];
    const now = options.now ?? this.now();
    const limit = Math.max(1, Math.min(5000, options.limit ?? 500));
    const placeholders = keys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT m.id, m.revision, m.kind, m.scope, m.title, m.valid_from, m.updated_at, m.pinned, m.created_at, m.tier
         FROM memory m
         WHERE m.status = 'verified'
           AND m.deleted_at IS NULL
           AND (m.valid_to IS NULL OR m.valid_to > ?)
           AND m.scope_key IN (${placeholders})
         ORDER BY m.tier ASC, m.created_at ASC, m.ord ASC
         LIMIT ?`,
      )
      .all(now, ...keys, limit);
    return rows.map((row) => ({
      id: row.id,
      revision: Number(row.revision),
      kind: row.kind,
      scope: row.scope,
      title: row.title,
      validFrom: Number(row.valid_from),
      updatedAt: Number(row.updated_at),
      pinned: Number(row.pinned) === 1,
    }));
  }

  /**
   * How many entries the injected index would show without a limit. Used for
   * the honest "N shown of M" footer.
   * @param scopeKeys - read scope keys.
   * @param now - reference time.
   */
  countIndex(scopeKeys, now = this.now()) {
    if (scopeKeys.length === 0) return 0;
    const marks = scopeKeys.map(() => '?').join(', ');
    return Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory m
           WHERE m.status = 'verified' AND m.deleted_at IS NULL
             AND (m.valid_to IS NULL OR m.valid_to > ?) AND m.scope_key IN (${marks})`,
        )
        .get(now, ...scopeKeys)?.n ?? 0,
    );
  }

  /**
   * Verified rules for the rules block, newest last.
   * @param options - `scopeKeys`, `now`, `limit`.
   */
  ruleEntries(options) {
    const keys = options.scopeKeys ?? [];
    if (keys.length === 0) return [];
    const now = options.now ?? this.now();
    const placeholders = keys.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT m.id, m.title, m.updated_at
         FROM memory m
         WHERE m.status = 'verified' AND m.tier = 0 AND m.kind = 'rule' AND m.deleted_at IS NULL
           AND (m.valid_to IS NULL OR m.valid_to > ?)
           AND m.scope_key IN (${placeholders})
         ORDER BY m.pinned DESC, m.created_at ASC
         LIMIT ?`,
      )
      .all(now, ...keys, options.limit ?? 40)
      .map((row) => ({ id: row.id, title: row.title, updatedAt: Number(row.updated_at) }));
  }

  /**
   * Every scope key the database knows. Used by the owner-only panel and the
   * Markdown export, which are administrative views rather than session reads.
   * @returns distinct scope keys.
   */
  allScopeKeys() {
    return this.db
      .prepare('SELECT DISTINCT m.scope_key AS key FROM memory m JOIN memory_head h ON h.ord = m.ord')
      .all()
      .map((row) => row.key);
  }

  /**
   * Every head id, newest first. Export iterates this rather than a page.
   * @returns memory ids.
   */
  allHeadIds() {
    return this.db
      .prepare('SELECT id FROM memory_head ORDER BY revision DESC, id ASC')
      .all()
      .map((row) => row.id);
  }

  /**
   * Page over head rows for the panel.
   * @param options - `scopeKeys`, `statuses`, `kinds`, `limit`, `offset`.
   * @returns `{items, total}`.
   */
  list(options = {}) {
    const keys = options.scopeKeys ?? [];
    if (keys.length === 0) return { items: [], total: 0 };
    const statuses = options.statuses ?? ['verified'];
    const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? options.kinds : null;
    const keyMarks = keys.map(() => '?').join(', ');
    const statusMarks = statuses.map(() => '?').join(', ');
    const kindClause = kinds === null ? '' : ` AND m.kind IN (${kinds.map(() => '?').join(', ')})`;
    const params = [nowOrMax(options.now), ...keys, ...statuses, ...(kinds ?? [])];
    const total = Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory m
           WHERE (m.valid_to IS NULL OR m.valid_to > ?) AND m.scope_key IN (${keyMarks})
             AND m.status IN (${statusMarks})${kindClause}`,
        )
        .get(...params)?.n ?? 0,
    );
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const offset = Math.max(0, options.offset ?? 0);
    const items = this.db
      .prepare(
        `SELECT m.id, m.revision, m.kind, m.scope, m.scope_label, m.title, m.status, m.pinned, m.tags,
                m.valid_from, m.valid_to, m.updated_at, m.created_at,
                substr(m.body, 1, 240) AS snippet
         FROM memory m
         WHERE (m.valid_to IS NULL OR m.valid_to > ?) AND m.scope_key IN (${keyMarks})
           AND m.status IN (${statusMarks})${kindClause}
         ORDER BY m.pinned DESC, m.updated_at DESC, m.ord DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset)
      .map((row) => ({
        id: row.id,
        revision: Number(row.revision),
        kind: row.kind,
        scope: row.scope,
        scopeLabel: row.scope_label,
        title: row.title,
        status: row.status,
        pinned: Number(row.pinned) === 1,
        tags: JSON.parse(row.tags ?? '[]'),
        validFrom: Number(row.valid_from),
        validTo: row.valid_to === null ? null : Number(row.valid_to),
        updatedAt: Number(row.updated_at),
        createdAt: Number(row.created_at),
        snippet: row.snippet ?? '',
      }));
    return { items, total };
  }

  /**
   * Aggregate counters for `loci_stats`, the panel, and doctor.
   * @param options - `scopeKeys` (omit for the whole database).
   */
  stats(options = {}) {
    const keys = options.scopeKeys ?? [];
    const filtered = keys.length > 0;
    const marks = filtered ? ` AND m.scope_key IN (${keys.map(() => '?').join(', ')})` : '';
    const byStatus = {};
    for (const row of this.db
      .prepare(
        `SELECT h.status AS status, COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE 1=1${marks} GROUP BY h.status`,
      )
      .all(...keys)) {
      byStatus[row.status] = Number(row.n);
    }
    const byKind = {};
    for (const row of this.db
      .prepare(
        `SELECT m.kind AS kind, COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE 1=1${marks} GROUP BY m.kind`,
      )
      .all(...keys)) {
      byKind[row.kind] = Number(row.n);
    }
    const byScope = {};
    for (const row of this.db
      .prepare(
        `SELECT m.scope AS scope, COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE 1=1${marks} GROUP BY m.scope`,
      )
      .all(...keys)) {
      byScope[row.scope] = Number(row.n);
    }
    const pending = Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord
           WHERE h.status = 'candidate' AND m.deleted_at IS NULL${marks}`,
        )
        .get(...keys)?.n ?? 0,
    );
    const disputed = Number(
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE h.status = 'disputed'${marks}`)
        .get(...keys)?.n ?? 0,
    );
    const lastInjection = this.db
      .prepare('SELECT ts, session_id, scope_key, section_bytes, entries_listed, entries_hidden FROM request_stat ORDER BY id DESC LIMIT 1')
      .get();
    const revisions = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory').get()?.n ?? 0);
    return {
      schemaVersion: this.schemaVersion(),
      indexRev: this.indexRev(),
      revisions,
      heads: Object.values(byStatus).reduce((total, n) => total + n, 0),
      byStatus,
      byKind,
      byScope,
      pendingCandidates: pending,
      disputed,
      lastInjection:
        lastInjection === undefined
          ? null
          : {
              ts: Number(lastInjection.ts),
              sessionId: lastInjection.session_id,
              scopeKey: lastInjection.scope_key,
              bytes: Number(lastInjection.section_bytes),
              listed: Number(lastInjection.entries_listed),
              hidden: Number(lastInjection.entries_hidden),
            },
      dbBytes: existsSync(this.paths.db) ? statSync(this.paths.db).size : 0,
      vector: { ...this.vector, ...this.embedding.health() },
      memoryRoot: this.memoryRoot,
    };
  }

  /**
   * Record one injected section, so the cost of each request is queryable.
   * @param row - `sessionId`, `scopeKey`, `bytes`, `listed`, `hidden`.
   */
  recordInjection(row) {
    this.db
      .prepare(
        'INSERT INTO request_stat (ts, session_id, scope_key, section_bytes, entries_listed, entries_hidden) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(this.now(), row.sessionId ?? null, row.scopeKey ?? null, row.bytes, row.listed, row.hidden);
    this.db.prepare('DELETE FROM request_stat WHERE ts < ?').run(this.now() - 90 * 86_400_000);
    this.audit.append('inject', {
      sessionId: row.sessionId ?? null,
      scopeKey: row.scopeKey ?? null,
      bytes: row.bytes,
      listed: row.listed,
      hidden: row.hidden,
    });
  }

  /**
   * Record one recall.
   * @param row - `query` length, counts, timing, channels.
   */
  recordRecall(row) {
    this.audit.append('recall', {
      sessionId: row.sessionId ?? null,
      scopeKey: row.scopeKey ?? null,
      queryChars: typeof row.query === 'string' ? row.query.length : 0,
      total: row.total,
      returned: row.returned,
      tookMs: row.tookMs,
      channels: row.channels,
    });
  }

  /** The audit ring, for the panel and stats. */
  auditTail(limit = 100) {
    return this.audit.tail(limit);
  }

  /**
   * The most recent injected sections, newest first.
   * @param limit - how many rows.
   * @returns `[{ts, sessionId, bytes, listed, hidden}]`.
   */
  recentInjections(limit = 50) {
    return this.db
      .prepare(
        'SELECT ts, session_id, scope_key, section_bytes, entries_listed, entries_hidden FROM request_stat ORDER BY id DESC LIMIT ?',
      )
      .all(Math.max(1, Math.min(500, limit)))
      .map((row) => ({
        ts: Number(row.ts),
        sessionId: row.session_id,
        scopeKey: row.scope_key,
        sectionBytes: Number(row.section_bytes),
        listed: Number(row.entries_listed),
        hidden: Number(row.entries_hidden),
      }));
  }

  /**
   * A predicate that marks tokens too common to count as evidence.
   *
   * A term present in more than 15% of the scope's memories is a hub word
   * ("project", "插件"); letting it drive a query recalls everything and ranks
   * nothing. The token counts are maintained on write, so this stays a couple
   * of indexed lookups per query.
   * @returns `(token) => boolean`.
   */
  hubPredicate() {
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_head').get()?.n ?? 0);
    if (total < 20) return () => false;
    const statement = this.db.prepare('SELECT df FROM token_stat WHERE token = ?');
    return (token) => Number(statement.get(token)?.df ?? 0) / total > 0.15;
  }

  /**
   * Rebuild the FTS index and token statistics from `memory`.
   * Used after an interrupted write, by doctor, and by the reindex command.
   * @returns `{rows, tokens}`.
   */
  reindex() {
    this.#assertWritable();
    return withTransaction(this.db, () => {
      this.db.exec('DELETE FROM memory_fts');
      this.db.exec('DELETE FROM token_stat');
      const rows = this.db.prepare('SELECT ord, title, body, tags FROM memory').all();
      const insert = this.db.prepare('INSERT INTO memory_fts (rowid, tokens) VALUES (?, ?)');
      const counts = new Map();
      for (const row of rows) {
        const tags = JSON.parse(row.tags ?? '[]').join(' ');
        const stream = tokenStream(`${row.title} ${row.body} ${tags}`);
        insert.run(Number(row.ord), stream);
        for (const token of new Set(tokenize(`${row.title} ${row.body} ${tags}`))) {
          counts.set(token, (counts.get(token) ?? 0) + 1);
        }
      }
      const stat = this.db.prepare('INSERT INTO token_stat (token, df) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET df = excluded.df');
      for (const [token, df] of counts) stat.run(token, df);
      return { rows: rows.length, tokens: counts.size };
    });
  }

  /**
   * Fill missing embeddings for verified entries. No-op when the channel is
   * off or unavailable; a failure leaves the entry lexically searchable.
   * @param limit - most entries to embed in one pass.
   * @returns `{added, skipped}`.
   */
  async backfillEmbeddings(limit = 200) {
    if (this.embedding === undefined || !this.embedding.available()) return { added: 0, skipped: true };
    const rows = this.db
      .prepare(
        `SELECT m.ord, m.title, m.body FROM memory m
         JOIN memory_head h ON h.ord = m.ord
         LEFT JOIN embedding e ON e.ord = m.ord
         WHERE e.ord IS NULL AND h.status = 'verified' AND m.deleted_at IS NULL
         LIMIT ?`,
      )
      .all(limit);
    if (rows.length === 0) return { added: 0, skipped: false };
    let added = 0;
    const complete = await this.embedding.embedAll(
      rows.map((row) => `${row.title}\n${row.body}`),
      (start, vectors) => {
        withTransaction(this.db, () => {
          const insert = this.db.prepare(
            'INSERT OR REPLACE INTO embedding (ord, model, dim, vec, created_at) VALUES (?, ?, ?, ?, ?)',
          );
          vectors.forEach((vector, index) => {
            insert.run(
              Number(rows[start + index].ord),
              this.embedding.model,
              vector.length,
              vectorToBlob(vector),
              this.now(),
            );
          });
        });
        added += vectors.length;
      },
    );
    return { added, skipped: !complete };
  }

  /**
   * Whether the FTS index covers every stored revision.
   * @returns `{memory, fts, missing}`.
   */
  indexCoverage() {
    const memory = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory').get()?.n ?? 0);
    const fts = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_fts').get()?.n ?? 0);
    return { memory, fts, missing: Math.max(0, memory - fts) };
  }

  /**
   * One maintenance pass: expire working memory, close stale candidates,
   * rebuild a drifted index, and refresh query-planner statistics.
   * @param options - `now`.
   * @returns a summary of what changed.
   */
  maintenance(options = {}) {
    this.#assertWritable();
    const now = options.now ?? this.now();
    const summary = { expiredWorking: 0, closedCandidates: 0, reindexed: false, optimized: false };
    const workingTtlDays = Number(this.live('workingTtlDays') ?? 7);
    if (workingTtlDays > 0) {
      const cutoff = now - workingTtlDays * 86_400_000;
      const result = this.db
        .prepare(
          `UPDATE memory SET valid_to = ?, updated_at = ?
           WHERE kind = 'working' AND valid_to IS NULL AND created_at < ? AND status <> 'deleted'`,
        )
        .run(now, now, cutoff);
      summary.expiredWorking = Number(result.changes ?? 0);
    }
    const candidateTtlDays = Number(this.live('candidateTtlDays') ?? 30);
    if (candidateTtlDays > 0) {
      const cutoff = now - candidateTtlDays * 86_400_000;
      const result = this.db
        .prepare(
          `UPDATE memory SET valid_to = ?, updated_at = ?
           WHERE status = 'candidate' AND valid_to IS NULL AND created_at < ?`,
        )
        .run(now, now, cutoff);
      summary.closedCandidates = Number(result.changes ?? 0);
    }
    const coverage = this.indexCoverage();
    if (coverage.missing > 0) {
      this.reindex();
      summary.reindexed = true;
      this.bumpIndexRev();
    }
    try {
      this.db.exec('PRAGMA optimize');
      summary.optimized = true;
    } catch {
      summary.optimized = false;
    }
    writeMeta(this.db, META_KEYS.lastMaintenance, String(now));
    this.audit.append('maintenance', summary, { sync: true });
    return summary;
  }

  /**
   * Take a consistent snapshot next to the database.
   * @param label - file label (`manual`, `pre-import`).
   * @returns the snapshot path.
   */
  snapshot(label = 'manual') {
    this.#assertWritable();
    return backupTo(this.db, join(this.paths.backups, `${label}-${this.now()}.db`));
  }

  /** Health checks used by `doctor`. */
  health() {
    return {
      quickCheck: quickCheck(this.db),
      integrity: integrityCheck(this.db),
      coverage: this.indexCoverage(),
      counts: tableCounts(this.db),
      schemaVersion: this.schemaVersion(),
      expectedSchemaVersion: SCHEMA_VERSION,
      migration: this.migration,
      dbBytes: existsSync(this.paths.db) ? statSync(this.paths.db).size : 0,
    };
  }

  // ---------------------------------------------------------------- internals

  #headRow(id) {
    const row = this.db
      .prepare(
        `SELECT m.* FROM memory m JOIN memory_head h ON h.ord = m.ord WHERE m.id = ? LIMIT 1`,
      )
      .get(id);
    if (row === undefined) return undefined;
    return { row };
  }

  #findByHash(scopeKey, contentHash) {
    return this.db
      .prepare(
        `SELECT m.id, m.revision FROM memory m JOIN memory_head h ON h.ord = m.ord
         WHERE m.scope_key = ? AND m.content_hash = ? AND m.deleted_at IS NULL
         ORDER BY m.revision DESC LIMIT 1`,
      )
      .get(scopeKey, contentHash);
  }

  #findByTitle(scopeKey, titleNorm) {
    return this.db
      .prepare(
        `SELECT m.id, m.revision FROM memory m JOIN memory_head h ON h.ord = m.ord
         WHERE m.scope_key = ? AND m.title_norm = ? AND m.deleted_at IS NULL
         ORDER BY m.revision DESC LIMIT 1`,
      )
      .get(scopeKey, titleNorm);
  }

  #findSimilar(scopeKey, prepared) {
    // A duplicate is signalled by a *rare* shared term. Anchoring the check on
    // the rarest title token keeps the cost proportional to that term's posting
    // list instead of the whole scope, and a title made only of hub words
    // ("发布流程约定") cannot be a meaningful duplicate signal anyway.
    const tokens = tokenize(prepared.title).filter((token) => token.length >= 2);
    if (tokens.length === 0) return [];
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_head').get()?.n ?? 0);
    if (total < 2) return [];
    const dfStatement = this.db.prepare('SELECT df FROM token_stat WHERE token = ?');
    const ranked = tokens
      .map((token) => ({ token, df: Number(dfStatement.get(token)?.df ?? 0) }))
      .sort((a, b) => a.df - b.df);
    const anchor = ranked[0];
    if (anchor.df === 0 || anchor.df / total > 0.15) return [];
    const candidates = this.db
      .prepare(
        `SELECT m.id, m.revision, m.title, m.body
         FROM memory_fts
         JOIN memory m ON m.ord = memory_fts.rowid
         JOIN memory_head h ON h.ord = m.ord
         WHERE memory_fts MATCH ? AND m.scope_key = ? AND h.status <> 'deleted'
         LIMIT 16`,
      )
      .all(`"${anchor.token}"`, scopeKey);
    const threshold = Number(this.live('dedupeSimilarity') ?? 0.8);
    const hits = [];
    for (const row of candidates) {
      const score = jaccard(`${prepared.title}\n${prepared.body}`, `${row.title}\n${row.body}`);
      if (score >= threshold) {
        hits.push({ id: row.id, revision: Number(row.revision), title: row.title, similarity: Number(score.toFixed(3)) });
      }
    }
    return hits.slice(0, 5);
  }

  #resolveStatus({ input, prepared, evidence, trustSource }) {
    // working memory is scratch for this session; it is never injected, so it
    // never needs verifying.
    if (input.kind === 'working') return 'candidate';
    if (['candidate', 'verified', 'disputed'].includes(input.status)) return input.status;
    if (prepared.instructionLike) return 'disputed';
    if (trustSource === 'import' || trustSource === 'summary' || trustSource === 'rule') return 'candidate';
    if (trustSource === 'user') return 'verified';
    const quote = typeof evidence.quote === 'string' ? evidence.quote.trim() : '';
    if (quote.length < 8) return 'candidate';
    let verified = false;
    try {
      verified = this.quoteVerifier(quote, {
        sessionId: evidence.sessionId ?? input.sourceSession ?? undefined,
        eventSeq: Number.isSafeInteger(evidence.eventSeq) ? evidence.eventSeq : input.sourceEvent,
      }) === true;
    } catch {
      verified = false;
    }
    this.quoteChecked += 1;
    return verified ? 'verified' : 'candidate';
  }

  #insertRevision(row) {
    const result = this.db
      .prepare(
        `INSERT INTO memory (
           id, revision, kind, scope, scope_key, scope_label, title, title_norm, body, tags, entities,
           status, trust_source, flags, valid_from, valid_to, recorded_at, supersedes, superseded_by,
           evidence, source_session, source_event, verified_at, verified_by, pinned, importance, tier,
           content_hash, created_at, updated_at, deleted_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      )
      .run(
        row.id,
        row.revision,
        row.kind,
        row.scope,
        row.scopeKey,
        row.scopeLabel,
        row.title,
        row.titleNorm,
        row.body,
        JSON.stringify(row.tags ?? []),
        JSON.stringify(row.entities ?? []),
        row.status,
        row.trustSource,
        JSON.stringify(row.flags ?? []),
        row.validFrom,
        row.validTo,
        row.now,
        row.supersedes,
        null,
        JSON.stringify(row.evidence ?? {}),
        row.sourceSession,
        row.sourceEvent,
        row.verifiedAt,
        row.verifiedBy,
        row.pinned,
        row.importance,
        tierOf(row.kind, row.pinned),
        row.contentHash,
        row.createdAt,
        row.now,
      );
    const ord = Number(result.lastInsertRowid);
    const text = `${row.title} ${row.body} ${(row.tags ?? []).join(' ')}`;
    this.db.prepare('INSERT INTO memory_fts (rowid, tokens) VALUES (?, ?)').run(ord, tokenStream(text));
    const tokens = new Set(tokenize(text));
    const stat = this.db.prepare('INSERT INTO token_stat (token, df) VALUES (?, 1) ON CONFLICT(token) DO UPDATE SET df = df + 1');
    for (const token of tokens) stat.run(token);
    this.#linkEntities(ord, row.entities ?? [], row.scopeKey, row.now);
    this.db
      .prepare(
        'INSERT INTO memory_head (id, ord, revision, status) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ord = excluded.ord, revision = excluded.revision, status = excluded.status',
      )
      .run(row.id, ord, row.revision, row.status);
    return ord;
  }

  #linkEntities(ord, entities, scopeKey, now) {
    if (!Array.isArray(entities) || entities.length === 0) return;
    const upsert = this.db.prepare(
      `INSERT INTO entity (id, scope_key, norm_name, name, kind, aliases, created_at) VALUES (?, ?, ?, ?, ?, '[]', ?)
       ON CONFLICT(scope_key, norm_name) DO UPDATE SET name = excluded.name, kind = excluded.kind`,
    );
    const find = this.db.prepare('SELECT id FROM entity WHERE scope_key = ? AND norm_name = ?');
    const link = this.db.prepare('INSERT OR IGNORE INTO memory_entity (ord, entity_id, role) VALUES (?, ?, ?)');
    const bump = this.db.prepare('UPDATE entity SET link_count = link_count + 1 WHERE id = ?');
    for (const entity of entities) {
      const norm = normalizeText(entity.name).replace(/\s+/g, '');
      if (norm.length === 0) continue;
      upsert.run(newEntityId(), scopeKey, norm, entity.name, entity.kind ?? 'thing', now);
      const found = find.get(scopeKey, norm);
      if (found === undefined) continue;
      const linked = link.run(ord, found.id, 'mention');
      if (Number(linked.changes ?? 0) > 0) bump.run(found.id);
    }
  }

  #recomputeTokenStats() {
    this.db.exec('DELETE FROM token_stat');
    const counts = new Map();
    const rows = this.db.prepare('SELECT title, body, tags FROM memory').all();
    for (const row of rows) {
      const text = `${row.title} ${row.body} ${JSON.parse(row.tags ?? '[]').join(' ')}`;
      for (const token of new Set(tokenize(text))) counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    const stat = this.db.prepare('INSERT INTO token_stat (token, df) VALUES (?, ?)');
    for (const [token, df] of counts) stat.run(token, df);
  }
}

/** `now` or the largest safe timestamp, for filters that must not exclude open rows. */
function nowOrMax(value) {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** Jaccard over whitespace-collapsed character bigrams (duplicate heuristic). */
function jaccard(a, b) {
  const grams = (text) => {
    const value = normalizeText(text).replace(/\s+/g, '');
    const set = new Set();
    if (value.length === 1) set.add(value);
    for (let i = 0; i + 1 < value.length; i += 1) set.add(value.slice(i, i + 2));
    return set;
  };
  const left = grams(a);
  const right = grams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}
