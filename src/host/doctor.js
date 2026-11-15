/**
 * Health checks behind `dsh-loci doctor` and `/loci doctor`.
 *
 * Doctor answers one question — "is this store healthy enough to trust" — with
 * three states and concrete numbers, never prose. It never repairs anything:
 * repairs are explicit commands (`reindex`, `maintenance`, `restore`).
 * @module dsh-loci/doctor
 */
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findDuplicateGroups } from './store/duplicates.js';

/** One check result. */
function check(name, status, detail) {
  return { name, status, detail };
}

/**
 * Run every check.
 * @param options - `store`, `paths`, `config` (object).
 * @returns `{status, checks, summary}` where status is the worst check status.
 */
export function runDoctor(options) {
  const { store, paths, config, engines } = options;
  const checks = [];

  const health = (() => {
    try {
      return store.health();
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  })();
  if (health.error !== undefined) {
    return { status: 'fail', checks: [check('database', 'fail', health.error)], summary: 'database is not readable' };
  }

  checks.push(
    health.quickCheck === 'ok'
      ? check('database', 'ok', `quick_check ok · ${health.dbBytes} bytes`)
      : check('database', 'fail', `quick_check: ${health.quickCheck}`),
  );
  checks.push(
    health.schemaVersion === health.expectedSchemaVersion
      ? check('schema', 'ok', `v${health.schemaVersion}`)
      : check(
          'schema',
          health.schemaVersion < health.expectedSchemaVersion ? 'warn' : 'fail',
          `database v${health.schemaVersion}, build expects v${health.expectedSchemaVersion}`,
        ),
  );
  checks.push(
    health.coverage.missing === 0
      ? check('full-text index', 'ok', `${health.coverage.fts}/${health.coverage.memory} revisions indexed`)
      : check('full-text index', 'warn', `${health.coverage.missing} revisions are not indexed; run reindex`),
  );
  checks.push(
    health.integrity === 'ok'
      ? check('integrity', 'ok', 'integrity_check ok')
      : check('integrity', 'fail', health.integrity),
  );

  const lastMaintenance = Number(health.migration?.to === undefined ? 0 : 0);
  checks.push(check('rows', 'ok', `${health.counts.memory} revisions · ${health.counts.memory_head} entries · ${health.counts.entity} entities`));

  // Which Harness opened this store. A range in engines.dsh is a promise; this row
  // is what actually happened, and it is the first thing to ask for in a bug report.
  try {
    const hostVersion = store.hostVersion ?? null;
    checks.push(
      hostVersion === null
        ? check('host', 'warn', `not recorded yet; this build declares engines.dsh ${engines?.dsh ?? 'unknown'}`)
        : check('host', 'ok', `last opened by DeepSeek Harness ${hostVersion}`),
    );
  } catch (error) {
    checks.push(check('host', 'warn', `could not read: ${String(error?.message ?? error)}`));
  }

  try {
    accessSync(paths.root, constants.W_OK);
    checks.push(check('data directory', 'ok', paths.root));
  } catch (error) {
    checks.push(check('data directory', 'fail', String(error?.message ?? error)));
  }

  try {
    accessSync(paths.exports, constants.W_OK);
    checks.push(check('export directory', 'ok', paths.exports));
  } catch (error) {
    checks.push(check('export directory', 'warn', String(error?.message ?? error)));
  }

  const wal = `${paths.db}-wal`;
  if (existsSync(wal)) {
    const bytes = statSync(wal).size;
    checks.push(bytes > 64 * 1024 * 1024
      ? check('wal', 'warn', `${bytes} bytes; a checkpoint is overdue`)
      : check('wal', 'ok', `${bytes} bytes`));
  } else {
    checks.push(check('wal', 'ok', 'checkpointed'));
  }

  if (existsSync(paths.lock)) {
    checks.push(check('lock', 'warn', 'a maintenance lock file exists; it is stale if no maintenance is running'));
  } else {
    checks.push(check('lock', 'ok', 'none'));
  }

  const backups = existsSync(paths.backups) ? readdirSync(paths.backups).filter((name) => name.endsWith('.db')) : [];
  checks.push(
    backups.length > 0
      ? check('backups', 'ok', `${backups.length} snapshot(s), newest ${backups.sort().at(-1)}`)
      : check('backups', 'warn', 'no snapshot yet; the next migration will create one'),
  );

  if (config?.vectorMode === 'http') {
    if (typeof config.vectorEndpoint !== 'string' || config.vectorEndpoint.length === 0) {
      checks.push(check('vector channel', 'warn', 'vectorMode is http but vectorEndpoint is empty; retrieval stays lexical'));
    } else {
      checks.push(check('vector channel', 'ok', config.vectorEndpoint));
    }
  } else {
    checks.push(check('vector channel', 'ok', 'off (lexical retrieval only)'));
  }

  const auditSize = existsSync(paths.audit) ? statSync(paths.audit).size : 0;
  checks.push(check('audit', auditSize > 0 ? 'ok' : 'warn', `${auditSize} bytes at ${paths.audit}`));

  // Near-duplicates: two entries that say the same thing split the ranking, each
  // take an index line, and force a correction to be applied twice. The store can
  // merge them (`loci_write op:'merge'`), so the doctor's job is only to point at
  // them — it never repairs this itself.
  try {
    const duplicates = findDuplicateGroups(store, { limit: 5 });
    if (duplicates.groups.length === 0) {
      checks.push(check('duplicates', 'ok', `${duplicates.scanned} entries scanned, none close enough to merge`));
    } else {
      const summary = duplicates.groups
        .map((group) => group.ids.slice(0, 3).join(' ≈ '))
        .join('; ');
      checks.push(
        check(
          'duplicates',
          'warn',
          `${duplicates.groups.length} near-duplicate group(s): ${summary} — review with \`loci review\`, then merge`,
        ),
      );
    }
  } catch (error) {
    // A diagnostic that fails must not turn the whole report into a failure.
    checks.push(check('duplicates', 'warn', `could not scan: ${String(error?.message ?? error)}`));
  }

  const worst = checks.some((entry) => entry.status === 'fail')
    ? 'fail'
    : checks.some((entry) => entry.status === 'warn')
      ? 'warn'
      : 'ok';
  const summary =
    worst === 'ok'
      ? `healthy · ${health.counts.memory_head} entries · ${health.dbBytes} bytes`
      : worst === 'warn'
        ? 'usable with warnings (see checks)'
        : 'not healthy (see checks)';
  return { status: worst, checks, summary };
}

/**
 * Render a doctor result as plain text.
 * @param result - from {@link runDoctor}.
 * @returns multi-line text.
 */
export function formatDoctor(result) {
  const lines = [`loci doctor: ${result.status} — ${result.summary}`];
  for (const entry of result.checks) lines.push(`  [${entry.status}] ${entry.name}: ${entry.detail}`);
  return lines.join('\n');
}
