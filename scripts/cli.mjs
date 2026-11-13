#!/usr/bin/env node
/**
 * dsh-loci command line: the same store, without a Harness.
 *
 * Every command opens the database directly, so it works while the Harness is
 * running (WAL) and on a machine where the plugin is installed but idle.
 *
 * Usage: dsh-loci <command> [options]
 *   doctor                 health checks, exit code 1 when failing
 *   stats                  counters and budget use
 *   search <query>         print ranked hits
 *   review                 candidates and disputed entries
 *   export                 write the Markdown projection
 *   import --dir <path>    import Markdown as candidates
 *   reindex                rebuild the full-text index
 *   maintenance            run one maintenance pass
 *   migrate --target <n>   run available migrations
 *   rollback --from <file> restore a snapshot (database must be idle)
 *   purge --id <id> --confirm <id>   hard-delete one entry
 *
 * Common options: --home <path> (default $DSH_HOME), --json
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveConfig } from '../src/host/config.js';
import { formatDoctor, runDoctor } from '../src/host/doctor.js';
import { ensureMemoryRoot, layout, resolveDshHome, resolveMemoryRoot } from '../src/host/paths.js';
import { resolveScopes, readScopeKeys } from '../src/host/scope.js';
import { closeDatabase, openDatabase } from '../src/host/store/db.js';
import { exportMarkdown, importMarkdown } from '../src/host/store/export.js';
import { migrate, newestBackup, restoreDatabaseFile } from '../src/host/store/migrate.js';
import { search } from '../src/host/store/search.js';
import { Store } from '../src/host/store/store.js';
import { formatDate } from '../src/host/inject/index-section.js';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? '' : value;
};
const has = (name) => argv.includes(`--${name}`);
const json = has('json');
const home = resolveDshHome(flag('home'));
const memoryRoot = resolveMemoryRoot(home);
const paths = layout(memoryRoot);

/** Print a value as JSON or human text. */
function emit(value, text) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(text);
}

/** Open the store for a command that needs it, and close it after the work settles. */
async function withStore(fn) {
  ensureMemoryRoot(memoryRoot);
  const store = new Store({ memoryRoot, paths, config: effectiveConfig({ home }), pluginVersion: '1.0.0' });
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

const sessionsScope = () => {
  const scopes = resolveScopes({ sessionId: 'cli', cwd: process.cwd() });
  return { scopes, scopeKeys: readScopeKeys(scopes, { includeGlobal: true }) };
};

switch (command) {
  case 'doctor': {
    const result = await withStore((store) => runDoctor({ store, paths, config: effectiveConfig({ home }) }));
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatDoctor(result));
    process.exitCode = result.status === 'fail' ? 1 : 0;
    break;
  }
  case 'stats': {
    const result = await withStore((store) => {
      const { scopeKeys } = sessionsScope();
      return { ...store.stats({ scopeKeys }), injections: store.recentInjections(10) };
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      const statuses = Object.entries(result.byStatus).map(([key, count]) => `${key}=${count}`).join(' ') || 'empty';
      const kinds = Object.entries(result.byKind).map(([key, count]) => `${key}=${count}`).join(' ') || 'empty';
      console.log(`store       ${result.memoryRoot}`);
      console.log(`schema      v${result.schemaVersion} · index rev ${result.indexRev}`);
      console.log(`rows        ${result.revisions} revisions · ${result.heads} entries · ${result.dbBytes} bytes`);
      console.log(`status      ${statuses}`);
      console.log(`kind        ${kinds}`);
      console.log(`pending     ${result.pendingCandidates} candidates · ${result.disputed} disputed`);
      console.log(
        `injection   ${result.lastInjection === null ? 'none yet' : `${result.lastInjection.bytes} bytes (${result.lastInjection.listed} listed, ${result.lastInjection.hidden} hidden)`}`,
      );
    }
    break;
  }
  case 'search': {
    const query = argv.slice(1).filter((item) => !item.startsWith('--') && item !== flag('home')).join(' ').trim();
    if (query.length === 0) {
      console.error('usage: dsh-loci search <query>');
      process.exitCode = 2;
      break;
    }
    const result = await withStore(async (store) => {
      const { scopeKeys, scopes } = sessionsScope();
      return search(store, {
        query,
        scopeKeys,
        statuses: ['verified', 'candidate'],
        limit: 20,
        detail: 'snippet',
        channel: store.embedding,
        sessionId: 'cli',
        scopeKey: scopes.workspace,
      });
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`total=${result.total} matched=${result.matchedTotal} partial=${result.partial} took=${result.tookMs}ms`);
      for (const hit of result.hits) {
        console.log(`${hit.id} · ${hit.kind} · ${formatDate(hit.validFrom)} · ${hit.title}`);
        if (hit.snippet) console.log(`   ${hit.snippet.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
    }
    break;
  }
  case 'review': {
    await withStore((store) => {
      const { scopeKeys } = sessionsScope();
      const candidates = store.list({ scopeKeys, statuses: ['candidate'], limit: 50, offset: 0 });
      const disputed = store.list({ scopeKeys, statuses: ['disputed'], limit: 50, offset: 0 });
      if (json) console.log(JSON.stringify({ candidates, disputed }, null, 2));
      else {
        console.log(`candidates ${candidates.total} · disputed ${disputed.total}`);
        for (const item of candidates.items) console.log(`  candidate ${item.id} · ${item.title}`);
        for (const item of disputed.items) console.log(`  disputed  ${item.id} · ${item.title}`);
      }
    });
    break;
  }
  case 'export': {
    await withStore((store) => {
      const result = exportMarkdown(store, paths);
      emit(result, `wrote ${result.files} files (${result.bytes} bytes) · ${result.exportFile}`);
    });
    break;
  }
  case 'import': {
    await withStore((store) => {
      const dir = flag('dir');
      const result = importMarkdown(store, paths, dir === undefined ? {} : { dir });
      emit(result, `imported ${result.imported} · skipped ${result.skipped} · errors ${result.errors.length}`);
      for (const error of result.errors.slice(0, 10)) console.error(`  ${error.file}: ${error.error}`);
    });
    break;
  }
  case 'reindex': {
    await withStore((store) => {
      const result = store.reindex();
      emit(result, `reindexed ${result.rows} revisions · ${result.tokens} tokens`);
    });
    break;
  }
  case 'maintenance': {
    await withStore((store) => {
      const result = store.maintenance();
      emit(result, `maintenance ${JSON.stringify(result)}`);
    });
    break;
  }
  case 'migrate': {
    const target = flag('target');
    ensureMemoryRoot(memoryRoot);
    const db = openDatabase({ file: paths.db });
    try {
      const result = migrate(db, {
        target: target === undefined ? undefined : Number(target),
        backupDir: paths.backups,
        pluginVersion: '1.0.0',
      });
      emit(result, `migrated ${result.from} -> ${result.to} (${result.steps.join(', ') || 'no steps'}), snapshot ${result.backup ?? 'none'}`);
    } finally {
      closeDatabase(db);
    }
    break;
  }
  case 'rollback': {
    const from = flag('from') ?? newestBackup(paths.backups);
    if (from === undefined) {
      console.error('no snapshot found');
      process.exitCode = 1;
      break;
    }
    if (existsSync(`${paths.db}-wal`)) {
      console.error('refusing to restore while a WAL exists; stop every Harness instance first');
      process.exitCode = 1;
      break;
    }
    const restored = restoreDatabaseFile(paths.db, from);
    emit({ restored, from }, `restored ${restored} from ${from}`);
    break;
  }
  case 'purge': {
    const id = flag('id');
    const confirm = flag('confirm');
    const config = effectiveConfig({ home, allowHardDelete: true });
    ensureMemoryRoot(memoryRoot);
    const store = new Store({ memoryRoot, paths, config, live: () => true, pluginVersion: '1.0.0' });
    try {
      const result = store.forget(id, { mode: 'purge', confirm, actor: 'cli' });
      emit(result, `purged ${result.id}`);
    } finally {
      store.close();
    }
    break;
  }
  case 'help':
  default: {
    console.log(`dsh-loci <command> [options]

  doctor | stats | review | export | reindex | maintenance
  search <query>
  import --dir <path>
  migrate [--target <n>]
  rollback [--from <snapshot>]
  purge --id <id> --confirm <id>

options: --home <path>  --json

store: ${memoryRoot}`);
    if (command !== 'help') process.exitCode = 2;
  }
}

if (command === 'snapshots') {
  // Listed after the switch on purpose: this command is diagnostic only.
  const dir = paths.backups;
  if (!existsSync(dir)) console.log('no snapshots');
  else console.log(readdirSync(join(dir)).join('\n'));
}
