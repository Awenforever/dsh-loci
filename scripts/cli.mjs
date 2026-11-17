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
 *   exempt                 sessions that never receive a memory section (--session, --allow)
 *   export                 write the Markdown projection
 *   import --dir <path> [--from auto-memory|claude] [--scope-key <key>] [--dry-run]    import Markdown as candidates
 *   reindex                rebuild the full-text index
 *   maintenance            run one maintenance pass
 *   migrate --target <n>   run available migrations
 *   snapshot [--label <name>]   write a consistent VACUUM INTO backup
 *   rollback --from <file> restore a snapshot (database must be idle)
 *   purge --id <id> --confirm <id>   hard-delete one entry
 *
 * Common options: --home <path> (default $DSH_HOME), --json
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveConfig } from '../src/host/config.js';
import { formatDoctor, runDoctor } from '../src/host/doctor.js';
import { ensureMemoryRoot, layout, resolveDshHome, resolveMemoryRoot } from '../src/host/paths.js';
import { resolveScopes, readScopeKeys } from '../src/host/scope.js';
import { closeDatabase, openDatabase } from '../src/host/store/db.js';
import { exportMarkdown, importMarkdown } from '../src/host/store/export.js';
import { importPeer } from '../src/host/store/importers.js';
import { migrate, newestBackup, restoreDatabaseFile } from '../src/host/store/migrate.js';
import { search } from '../src/host/store/search.js';
import { Store } from '../src/host/store/store.js';
import { formatDate } from '../src/host/inject/index-section.js';

// One source of truth for the version: the manifest that actually ships.
const PLUGIN_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** The shipped manifest, read once: version for reports, engines for the host check. */
const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const rawArgv = process.argv.slice(2);

/**
 * Find the subcommand wherever it sits.
 *
 * `--json doctor` used to print the help text and exit 2 because the first token
 * was taken as the command. Flags are position-independent now, which is what
 * everyone expects from a CLI.
 */
const COMMANDS = new Set([
  'doctor',
  'journal',
  'stats',
  'search',
  'review',
  'exempt',
  'export',
  'import',
  'reindex',
  'maintenance',
  'migrate',
  'rollback',
  'purge',
  'verify',
  'snapshot',
  'snapshots',
  'help',
]);
const command = rawArgv.find((token) => COMMANDS.has(token)) ?? 'help';
// Keep the original token order for the flag readers below.
const argv = [command, ...rawArgv.filter((token) => token !== command)];

// `dsh-loci --version` is the first thing anyone types. It used to fall through
// to the help text, which looks like the version flag is unsupported rather than
// like the value was never wired up.
if (rawArgv.some((token) => token === '--version' || token === '-v' || token === 'version')) {
  console.log(PLUGIN_VERSION);
  process.exit(0);
}
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
  const store = new Store({ memoryRoot, paths, config: effectiveConfig({ home }), pluginVersion: PLUGIN_VERSION });
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

/**
 * The scope set a diagnostic command should look at.
 *
 * `stats` and `doctor` answer "what is in my store", so they default to the whole
 * database; narrowing happens only when the caller passes `--scope` or asks for a
 * session view. Reporting zero entries because the shell's cwd happened to be a
 * different directory is a diagnostic that lies.
 */
const diagnosticScope = () => {
  if (has('session')) {
    const { scopeKeys } = sessionsScope();
    return { scopeKeys };
  }
  const kind = flag('scope');
  if (kind !== undefined && kind !== '') return { scopeKeys: [], kind };
  return { scopeKeys: undefined };
};

switch (command) {
  case 'doctor': {
    const result = await withStore((store) =>
        runDoctor({ store, paths, config: effectiveConfig({ home }), engines: MANIFEST.engines }),
      );
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatDoctor(result));
    process.exitCode = result.status === 'fail' ? 1 : 0;
    break;
  }
  case 'stats': {
    const result = await withStore((store) => {
      const { scopeKeys } = diagnosticScope();
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
  case 'journal': {
    // The human-facing view: what was remembered lately, what keeps appearing, what has sunk.
    //
    // It lives in the CLI rather than in a standalone script because only `scripts/cli.mjs` ships in the
    // published package — a script in `scripts/diag/` is useful to whoever has the checkout and invisible to
    // everyone who installed the plugin. A view nobody can reach is not a feature.
    const daysFlag = argv.find((item) => item.startsWith('--days='));
    const days = daysFlag === undefined ? 7 : Math.max(1, Number(daysFlag.slice('--days='.length)));
    const report = await withStore((store) => {
      const { scopeKeys } = diagnosticScope();
      const rows = store.db
        .prepare(
          `SELECT m.id, m.kind, m.title, m.applies, m.created_at,
                  COALESCE(u.inject_count, 0) AS injections,
                  COALESCE(u.mu_touched, 0)    AS touched,
                  h.status
             FROM memory m JOIN memory_head h ON h.ord = m.ord
             LEFT JOIN memory_usage u ON u.id = m.id
            WHERE m.valid_to IS NULL AND h.status <> 'deleted'
              -- The answer-eval fixture writes invented facts into a scope of its own. They are test data,
              -- not memories, and must never appear in a view a person reads.
              AND m.scope_key NOT LIKE 'session:answer-eval%'
            ORDER BY m.created_at DESC`,
        )
        .all();
      return {
        rows: rows.map((row) => ({ ...row })),
        muNow: store.muNow(),
        pending: store.db.prepare("SELECT COUNT(*) AS n FROM memory_head WHERE status = 'candidate'").get().n,
        disputed: store.db.prepare("SELECT COUNT(*) AS n FROM memory_head WHERE status = 'disputed'").get().n,
        scopeKeys,
      };
    });

    if (json) {
      console.log(JSON.stringify(report, null, 2));
      break;
    }

    const since = Date.now() - days * 86_400_000;
    const mark = (row) => (row.applies === 'always' ? '常驻' : '相关时才出现');
    const cut = (text, n) => {
      const value = String(text ?? '');
      return value.length > n ? `${value.slice(0, n)}…` : value;
    };
    const clock = (ms) => new Date(Number(ms)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const day = (ms) => new Date(Number(ms)).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });

    const fresh = report.rows.filter((row) => Number(row.created_at) >= since && row.status !== 'disputed');
    console.log(`\n最近 ${days} 天记了什么  ·  共 ${fresh.length} 条（隔离中的不计入）`);
    for (const row of fresh.slice(0, 15)) {
      const badge = row.status === 'verified' ? '' : `  [${row.status === 'candidate' ? '待审' : row.status}]`;
      console.log(`  ${clock(row.created_at)}  ${mark(row).padEnd(9)}  ${cut(row.title, 56)}${badge}`);
    }
    if (fresh.length === 0) console.log('  （这段时间没有新记忆）');
    if (fresh.length > 15) console.log(`  …还有 ${fresh.length - 15} 条`);

    const shown = report.rows.filter((row) => Number(row.injections) > 0).sort((a, b) => Number(b.injections) - Number(a.injections));
    console.log('\n一直在用的  ·  被放进提示词的次数');
    for (const row of shown.slice(0, 8)) {
      console.log(`  ${String(row.injections).padStart(5)} 次  ${mark(row).padEnd(9)}  ${cut(row.title, 52)}`);
    }
    if (shown.length === 0) console.log('  （还没有任何条目被注入过）');

    const SINK_AFTER_MS = 3 * 86_400_000;
    const sunk = report.rows.filter(
      (row) => Number(row.injections) === 0 && row.status === 'verified' && Date.now() - Number(row.created_at) >= SINK_AFTER_MS,
    );
    console.log('\n沉底的  ·  写入并 verified 超过 3 天，却一次都没进过提示词');
    for (const row of sunk.slice(0, 10)) {
      const flag = row.applies === 'always' ? '  ← 标了常驻却从未出现，scope 可能标错了' : '';
      console.log(`  ${day(row.created_at)}  ${mark(row).padEnd(9)}  ${cut(row.title, 46)}${flag}`);
    }
    if (sunk.length === 0) console.log('  （没有沉底的条目）');

    console.log('\n需要你处理的  ·  这些永远不会进入提示词，直到有人处理');
    console.log(`  待审 ${report.pending} 条 · 隔离 ${report.disputed} 条`);

    console.log('\n怎么读');
    console.log('  · 常驻 = 每轮都在提示词里；相关时才出现 = 只在问题匹配时被检索到。两种都正常。');
    console.log('  · 次数为 0 不等于没用；只有「从未被注入」是硬事实。');
    console.log('  · 这个库不记录「模型是否照做了」——那要观测任务结果，系统看不到。');
    console.log('  · 详细说明：docs/HOW-TO-LOOK.md');
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
  case 'exempt': {
    // The memory manager must never be shown memory. This command is how an operator declares
    // or lifts that, because the exemption has to be a stored fact: a manager that has already
    // been injected once has already been shaped.
    await withStore((store) => {
      const sessionId = flag('session');
      if (sessionId === undefined) {
        const rows = store.listInjectionExempt();
        if (json) console.log(JSON.stringify(rows, null, 2));
        else if (rows.length === 0) console.log('no session is exempt from injection');
        else for (const row of rows) console.log(`  ${row.session_id} · ${row.reason}`);
        return;
      }
      if (argv.includes('--allow')) {
        const removed = store.allowInjection(sessionId);
        console.log(removed ? `${sessionId} may be injected again` : `${sessionId} was not exempt`);
        return;
      }
      store.exemptFromInjection(sessionId, flag('reason') ?? 'memory manager');
      console.log(`${sessionId} will never receive a memory section`);
      console.log('use --allow to lift it; the section is empty for this session either way,');
      console.log('but the tools (loci_search, loci_get) still work — reading is not being shaped.');
    });
    break;
  }

  case 'review': {
    await withStore((store) => {
      // A terminal command describes the directory it runs in, so say which one. Otherwise
      // "0 candidates" cannot be told apart from "wrong directory".
      const { scopes, scopeKeys } = argv.includes('--all')
        ? { scopes: { labels: { workspace: '(all scopes)' } }, scopeKeys: store.allScopeKeys() }
        : sessionsScope();
      const candidates = store.list({ scopeKeys, statuses: ['candidate'], limit: 50, offset: 0 });
      const disputed = store.list({ scopeKeys, statuses: ['disputed'], limit: 50, offset: 0 });
      if (json) console.log(JSON.stringify({ candidates, disputed }, null, 2));
      else {
        console.log(`scope ${scopes.labels.workspace}`);
        console.log(`candidates ${candidates.total} · disputed ${disputed.total}`);
        for (const item of candidates.items) console.log(`  candidate ${item.id} · ${item.title}`);
        for (const item of disputed.items) console.log(`  disputed  ${item.id} · ${item.title}`);
        if (candidates.total > 0 || disputed.total > 0) {
          console.log('');
          console.log('approve with: dsh-loci verify --id <id>            (or in the panel: Memory → Review)');
          console.log('reject  with: dsh-loci verify --id <id> --status disputed');
        }
      }
    });
    break;
  }
  // A person approving a candidate. The tool surface deliberately has no equivalent —
  // the model must never be able to grant trust — so before this command a terminal-only
  // or MCP user could create candidates forever and never promote one. The panel is the
  // GUI door; this is the other one, and both are human-typed.
  case 'verify': {
    const id = flag('id');
    if (id === undefined || id === '') {
      console.error('verify needs --id <memory id>');
      process.exitCode = 2;
      break;
    }
    const status = flag('status') ?? 'verified';
    if (!['verified', 'disputed', 'candidate'].includes(status)) {
      console.error(`unknown status: ${status}; expected verified, disputed or candidate`);
      process.exitCode = 2;
      break;
    }
    await withStore((store) => {
      const result = store.setTrust(id, status, { actor: 'cli' });
      emit(result, `${id} → ${status}`);
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
      const from = flag('from');
      // `--from` selects a foreign format; without it the directory is read as
      // Loci's own Markdown projection.
      if (from !== undefined && from !== '') {
        const result = importPeer(store, {
          from,
          dir,
          scopeKey: flag('scope-key'),
          scopeLabel: flag('scope-label'),
          dryRun: has('dry-run'),
        });
        emit(result, `imported ${result.imported} from ${result.from} · read ${result.read}`);
        return result;
      }
      const result = importMarkdown(store, paths, dir === undefined ? {} : { dir });
      emit(result, `imported ${result.imported} · skipped ${result.skipped} · errors ${result.errors.length}`);
      for (const error of result.errors.slice(0, 10)) console.error(`  ${error.file}: ${error.error}`);
      return result;
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
  case 'snapshots': {
    // Previously unreachable: the block sat after the switch, so it printed help
    // and exited 2 before ever listing anything.
    const dir = paths.backups;
    const files = existsSync(dir) ? readdirSync(dir) : [];
    emit({ dir, files }, files.length === 0 ? 'no snapshots' : files.join('\\n'));
    break;
  }
  case 'snapshot': {
    // The backup path that actually works before an upgrade: one consistent file
    // produced by SQLite itself (VACUUM INTO), not a Markdown projection.
    const label = flag('label') ?? 'manual';
    ensureMemoryRoot(memoryRoot);
    const store = new Store({ memoryRoot, paths, config: effectiveConfig({ home }), pluginVersion: PLUGIN_VERSION });
    try {
      const file = store.snapshot(label);
      emit({ file, label }, `snapshot ${file}`);
    } finally {
      store.close();
    }
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
        pluginVersion: PLUGIN_VERSION,
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
    // The config decides whether hard delete is permitted; the CLI must not grant
    // itself a permission the user turned off. `--allow-hard-delete` is the
    // explicit opt-in for exactly this invocation.
    const config = effectiveConfig({
      home,
      ...(argv.includes('--allow-hard-delete') ? { allowHardDelete: true } : {}),
    });
    ensureMemoryRoot(memoryRoot);
    // No `live` override here: the store's default reader is `(key) => config[key]`,
    // which is exactly what this command decided above. Passing `() => true` made
    // every gate that reads a live value — hard delete included — evaluate to open,
    // so `--allow-hard-delete` was decorative and a config that forbade purging did
    // not stop it. The comment above this block was right; the code underneath it was
    // not.
    const store = new Store({ memoryRoot, paths, config, pluginVersion: PLUGIN_VERSION });
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

  journal [--days=N]   人类的视图：最近记了什么 / 什么在反复出现 / 什么沉了
  doctor | stats | review | export | export-import | reindex | maintenance | snapshots
  search <query>
  import --dir <path> [--from auto-memory|claude] [--scope-key <key>] [--dry-run]
  snapshot [--label <name>]
  migrate [--target <n>]
  rollback [--from <snapshot>]
  verify --id <id> [--status verified|disputed|candidate]
  purge --id <id> --confirm <id> [--allow-hard-delete]

options: --home <path>  --json   (either may come before or after the command)

store: ${memoryRoot}`);
    if (command !== 'help') process.exitCode = 2;
  }
}
