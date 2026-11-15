/**
 * `/loci` — the human-facing surface for the store.
 *
 * Commands run against the Host without creating a model message, which is the
 * point: checking what is remembered should cost no tokens.
 * @module dsh-loci/commands
 */
import { runDoctor, formatDoctor } from './doctor.js';
import { exportMarkdown } from './store/export.js';
import { search } from './store/search.js';
import { resolveScopes, readScopeKeys } from './scope.js';
import { formatDate } from './inject/index-section.js';

/** Help text shown by `/loci` and `/loci help`. */
const HELP = [
  'loci <command>',
  '  stats            counts, budget use, channel health',
  '  doctor           health checks with a three-state verdict',
  '  search <query>   search the store (verified entries)',
  '  review           entries waiting for verification',
  '  export           write the Markdown projection',
  '  maintenance      run one maintenance pass now',
].join('\n');

/**
 * Register the command.
 * @param ctx - plugin context.
 * @param deps - `store`, `paths`, `config`, `log`.
 * @returns disposer.
 */
export function registerCommands(ctx, deps) {
  const commands = ctx.get('commands');
  if (commands?.register === undefined) {
    deps.log?.info?.('loci: no commands service; /loci is not mounted (tools still work)');
    return () => {};
  }
  const { store, paths, config } = deps;

  return commands.register({
    name: 'loci',
    description: 'Inspect, search, export, or maintain the Loci memory store',
    input: { hint: 'stats | doctor | search <query> | review | export | maintenance' },
    handler: async ({ rawInput, agent } = {}) => {
      const input = String(rawInput ?? '').trim();
      const [verb, ...rest] = input.split(/\s+/);
      const session = agent?.session;
      const scopes = resolveScopes({ sessionId: session?.id, cwd: session?.header?.cwd });
      const scopeKeys = readScopeKeys(scopes, { includeGlobal: true });
      try {
        switch ((verb ?? 'help').toLowerCase()) {
          case 'stats': {
            const stats = store.stats({ scopeKeys });
            const statuses = Object.entries(stats.byStatus).map(([key, count]) => `${key}=${count}`).join(' ');
            const kinds = Object.entries(stats.byKind).map(([key, count]) => `${key}=${count}`).join(' ');
            return {
              kind: 'success',
              text: [
                `store: ${stats.memoryRoot}`,
                `schema v${stats.schemaVersion} · index rev ${stats.indexRev} · ${stats.revisions} revisions · ${stats.dbBytes} bytes`,
                `status: ${statuses || 'empty'}`,
                `kind: ${kinds || 'empty'}`,
                `pending: ${stats.pendingCandidates} · disputed: ${stats.disputed}`,
                `last injection: ${stats.lastInjection === null ? 'none yet' : `${stats.lastInjection.bytes} bytes (${stats.lastInjection.listed} listed, ${stats.lastInjection.hidden} hidden)`}`,
              ].join('\n'),
            };
          }
          case 'doctor':
            return { kind: runDoctor({ store, paths, config }).status === 'fail' ? 'error' : 'success', text: formatDoctor(runDoctor({ store, paths, config })) };
          case 'search': {
            const query = rest.join(' ').trim();
            if (query.length === 0) return { kind: 'error', text: 'usage: /loci search <query>' };
            const result = await search(store, {
              query,
              scopeKeys,
              statuses: ['verified'],
              limit: 10,
              detail: 'snippet',
              channel: store.embedding,
              sessionId: session?.id,
              scopeKey: scopes.workspace,
            });
            const lines = [`total=${result.total} returned=${result.returned} hasMore=${result.hasMore}`];
            for (const hit of result.hits) {
              lines.push(`${hit.id} · ${hit.kind} · ${formatDate(hit.validFrom)} · ${hit.title}`);
            }
            if (result.total === 0) lines.push('no match');
            return { kind: 'success', text: lines.join('\n') };
          }
          case 'review': {
            const pending = store.list({ scopeKeys, statuses: ['candidate'], limit: 50, offset: 0 });
            const disputed = store.list({ scopeKeys, statuses: ['disputed'], limit: 50, offset: 0 });
            const lines = [`candidates: ${pending.total}`, `disputed: ${disputed.total}`];
            for (const item of pending.items.slice(0, 15)) lines.push(`  candidate ${item.id} · ${item.title}`);
            for (const item of disputed.items.slice(0, 15)) lines.push(`  disputed  ${item.id} · ${item.title}`);
            // Point at things that exist. This used to say `loci_write op:"verify"`,
            // an operation the tool has never had and must not have — the model is not
            // allowed to grant trust. A person approves in the panel, or from a
            // terminal with the CLI, which is where the authority actually lives.
            lines.push('');
            lines.push('approve in the panel: Memory → Review');
            lines.push('or from a terminal:   dsh-loci verify --id <id> [--status disputed]');
            return { kind: 'success', text: lines.join('\n') };
          }
          case 'export': {
            const result = exportMarkdown(store, paths);
            return { kind: 'success', text: `wrote ${result.files} files (${result.bytes} bytes) · ${result.exportFile}` };
          }
          case 'maintenance': {
            const result = store.maintenance();
            return { kind: 'success', text: `maintenance: ${JSON.stringify(result)}` };
          }
          case 'help':
          default:
            return { kind: 'success', text: HELP };
        }
      } catch (error) {
        return { kind: 'error', text: `loci: ${String(error?.message ?? error)}` };
      }
    },
  });
}
