/**
 * dsh-loci — Client half.
 *
 * Two surfaces over the Host's owner-only API:
 *
 * - a **sidebar mirror** (`sidebar.footer.action`): a flat, dense card that
 *   shows what memory changed today and last week, with the last few changes
 *   as one-liners. It is the sidebar mirror — glanceable, never modal;
 * - a **panel** (`sidebar.panellist` + `main`): the full view, with a feed,
 *   the exact injected index, search, the review queue and statistics.
 *
 * Styling follows the shell: `--dsw-alias-*` tokens only, 1px borders, no
 * shadows or gradients, 12–13px type, square-ish 6–8px radii. Version text is
 * small and quiet, like the other sidebar cards in this ecosystem.
 *
 * Hand-authored in the module-loader format (`window.__ModuleLoader__.load`),
 * which is what the Host serves for `dsh.client` packages.
 */
window.__ModuleLoader__.load({
  id: 'dsh-loci',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const NS = 'loci';
    const API = '/api/loci';
    const ENTRY_ID = 'dsh-loci';
    const PANEL_ID = 'loci';

    const EN = {
      'meta.title': 'Loci memory palace',
      'meta.description':
        'Layered long-term memory: the prompt holds a stable index, full text is one lookup away, and only verified facts are injected.',

      'card.title': 'Memory',
      'card.empty': 'Nothing saved yet',
      'card.metrics': 'Memory at a glance',
      'card.emptyHint': 'Ask the agent to remember something, then confirm it here.',
      'card.verified': 'Verified',
      'card.pending': 'Pending',
      'card.disputed': 'Disputed',
      'card.injected': 'Injected',
      'card.opened': 'Opened',
      'card.dead': 'Dead',
      'card.pendingHint': '{n} item(s) waiting for you in Review.',
      'card.updated': 'updated',
      'card.pendingSentence': '{n} still need your review',
      'card.pinned': 'pinned',
      'card.open': 'Open memory',
      'card.check': 'Check for updates',
      'card.upToDate': 'Up to date',
      'card.updateTo': 'Update available',
      'card.checkOff': 'Update check off',
      'card.checking': 'Checking…',
      'card.unknown': 'Version check unavailable',
      'card.unpublished': 'Not on npm yet',

      'prose.agreed': 'we agreed ',
      'prose.lesson': 'lesson — ',

      'kind.rule': 'agreed',
      'kind.procedural': 'lesson',
      'kind.semantic': 'fact',
      'kind.episodic': 'event',
      'kind.working': 'draft',

      'since.now': 'just now',
      'since.minutes': '{n}m ago',
      'since.hours': '{n}h ago',
      'since.yesterday': 'yesterday',
      'since.days': '{n}d ago',

      'action.added': 'added',
      'action.revised': 'revised',
      'action.verified': 'verified',
      'action.disputed': 'disputed',
      'action.pinned': 'pinned',
      'action.unpinned': 'unpinned',
      'action.deleted': 'deleted',
      'action.purged': 'purged',
      'action.restored': 'restored',
      'action.imported': 'imported',
      'action.maintained': 'maintenance',

      'settings.title': 'Loci',
      'settings.intro': 'Long-term memory for this agent. Fields marked live apply immediately.',
      'settings.unavailable': 'Live editing needs the settings service; these are the effective values.',
      'settings.saved': 'saved',
      'settings.rejected': 'rejected by the host',
      'settings.failed': 'write failed',
      'settings.budget': 'Index budget',
      'settings.budgetHint': 'bytes for the whole injected section',
      'settings.scope': 'Default scope for new facts',
      'settings.capture': 'Session capture',
      'settings.assist': 'First-turn recall assist',
      'settings.maintenance': 'Background maintenance',
      'settings.secret': 'Secrets in memory',
      'settings.vector': 'Embedding channel',
      'settings.diagnostics': 'Diagnostics',
      'settings.danger': 'Delete everything',
      'settings.dangerHint': 'Type the phrase to confirm. Entries are soft-deleted: history stays readable and exportable.',
      'settings.dangerPhrase': 'forget everything',
      'settings.dangerRun': 'Delete all memory',
      'settings.dangerBusy': 'Deleting…',
      'settings.dangerDone': 'Deleted {n} entries.',
      'off': 'off',
      'captureRules': 'rules only',
      'secretRedact': 'redact',
      'secretReject': 'refuse the write',
      'vectorOff': 'off (lexical only)',
      'vectorHttp': 'HTTP endpoint',

      'panel.title': 'Memory',
      'panel.feed': 'Feed',
      'panel.index': 'Index',
      'panel.search': 'Search',
      'panel.review': 'Review',
      'panel.stats': 'Stats',
      'panel.refresh': 'Refresh',
      'panel.loading': 'Loading…',
      'panel.empty': 'Nothing here yet.',
      'panel.feedHint': 'What was remembered, revised, verified or removed. Newest first.',
      'panel.indexHint': 'Exactly what the model sees in its system prompt, with its byte cost.',
      'panel.bytes': 'bytes',
      'panel.listed': 'listed',
      'panel.hidden': 'hidden',
      'panel.searchPlaceholder': 'Search titles and bodies…',
      'panel.searchEmpty': 'No match.',
      'panel.more': 'Load more',
      'panel.total': 'total',
      'panel.verify': 'Verify',
      'panel.dispute': 'Dispute',
      'panel.delete': 'Delete',
      'panel.restore': 'Restore',
      'panel.pin': 'Pin',
      'panel.unpin': 'Unpin',
      'panel.back': 'Back',
      'panel.history': 'History',
      'panel.evidence': 'Evidence',
      'panel.source': 'Source',
      'panel.lesson': 'Lesson',
      'panel.lesson.pattern': 'pattern',
      'panel.lesson.fix': 'fix',
      'panel.lesson.prevents': 'prevents',
      'panel.lesson.when': 'when',
      'panel.relations': 'Relations',
      'panel.candidates': 'Candidates',
      'panel.disputed': 'Disputed',
      'panel.noCandidates': 'Nothing waiting for review.',
      'panel.reviewHint': 'Only entries that could be injected are listed. A summary of a past session is history, not a claim.',
      'panel.reject': 'Reject',
      'panel.digestOf': '{n} proposed together',
      'panel.verifyGroup': 'Verify these {n}',
      'panel.verifyAll': 'Verify all {n}',
      'panel.actionFailed': 'Action failed',
      'panel.injections': 'Recent injections',
      'panel.deadWeight': 'Injected but never opened',
      'panel.injected': 'injected',
      'panel.opened': 'opened',
      'panel.store': 'Store',
      'panel.confirmDelete': 'Soft-delete this entry?',
      'panel.error': 'Request failed',
      'panel.updated': 'Updated',
      'panel.version': 'version',
    };

    const CSS = `
.loci-root { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); font-size: 13px; }
.loci-card-root { display: flex; flex-direction: column; gap: 5px; flex: 0 0 100%; order: 1; grid-column: 1 / -1; width: 100%; min-width: 0; box-sizing: border-box; margin: 0 0 6px; padding: 10px 9px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 3px 12px rgba(0, 0, 0, .16); cursor: pointer; text-align: left; font: inherit; color: var(--dsw-alias-label-primary); font-size: 11px; line-height: 1.3; font-variant-numeric: tabular-nums; }
.loci-card-root:hover { background: var(--dsw-alias-bg-layer-2); }
.loci-card-root.is-rail { flex: 0 0 auto; padding: 6px; align-items: center; justify-content: center; }
.loci-card-head { display: flex; align-items: center; gap: 6px; min-width: 0; width: 100%; }
.loci-card-title { font-size: 13px; font-weight: 700; letter-spacing: -.01em; white-space: nowrap; }
.loci-card-ver { flex: 0 0 auto; margin: 0; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 9px; line-height: 1.2; font-family: inherit; font-variant-numeric: tabular-nums; cursor: pointer; white-space: nowrap; }
.loci-card-ver:hover { color: var(--dsw-alias-label-primary); }
.loci-card-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-brand-primary); flex: 0 0 auto; }
.loci-card-dot.is-warn { background: var(--dsw-alias-state-warn-primary); }
.loci-card-dot.is-error { background: var(--dsw-alias-state-error-primary); }
.loci-card-meta { flex: 1 1 auto; min-width: 0; font-size: 8.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }
.loci-card-mark { display: flex; align-items: center; color: var(--dsw-alias-brand-primary); flex: 0 0 auto; }
.loci-card-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px 8px; width: 100%; }
.loci-card-metric { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.loci-card-metric-label { font-size: 8px; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.loci-card-metric-value { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.loci-card-metric-value.is-warn { color: var(--dsw-alias-state-warn-primary); }
.loci-card-metric-value.is-error { color: var(--dsw-alias-state-error-primary); }
.loci-card-barline { display: flex; align-items: center; gap: 6px; width: 100%; }
.loci-card-bar { flex: 1 1 auto; min-width: 20px; height: 4px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.loci-card-bar-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); }
.loci-card-bar-fill.is-warn { background: var(--dsw-alias-state-warn-primary); }
.loci-card-bar-label { font-size: 8.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.loci-card-foot { display: flex; align-items: center; gap: 6px; width: 100%; font-size: 8.5px; color: var(--dsw-alias-label-secondary); }
.loci-card-foot-grow { flex: 1 1 auto; }
.loci-card-empty { font-size: 9.5px; color: var(--dsw-alias-label-secondary); }
.loci-card-hint { font-size: 9px; color: var(--dsw-alias-label-secondary); }
.loci-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary); flex: 0 0 auto; }

.loci-bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.loci-title { font-size: 14px; font-weight: 600; }
.loci-tabs { display: flex; gap: 2px; }
.loci-tab { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); padding: 5px 10px; border-radius: 6px; cursor: pointer; font: inherit; }
.loci-tab:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.loci-tab.is-active { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.loci-grow { flex: 1 1 auto; }
.loci-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 12px 16px 24px; }
.loci-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 9px; font: inherit; cursor: pointer; }
.loci-btn:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.loci-btn:disabled { opacity: .5; cursor: default; }
.loci-btn.is-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.loci-btn.is-danger { color: var(--dsw-alias-state-error-primary); }
.loci-btn.is-quiet { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); padding: 1px 6px; font-size: 11px; }
.loci-btn.is-quiet:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.loci-input { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 6px 9px; font: inherit; }
.loci-row { display: flex; gap: 10px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.loci-row:last-child { border-bottom: 0; }
.loci-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); flex: 0 0 auto; }
.loci-main { min-width: 0; flex: 1 1 auto; }
.loci-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.loci-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.loci-snippet { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 3px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.loci-actions { display: flex; gap: 6px; flex: 0 0 auto; align-items: center; }
.loci-pill { font-size: 11px; border-radius: 999px; padding: 1px 7px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.loci-pill.is-verified { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.loci-pill.is-candidate { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.loci-pill.is-disputed { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.loci-pill.is-deleted { color: var(--dsw-alias-state-idle-primary); }
.loci-tag { font-size: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; padding: 0 5px; color: var(--dsw-alias-label-secondary); }
.loci-tag.is-added { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.loci-tag.is-revised { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.loci-tag.is-verified { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.loci-tag.is-deleted, .loci-tag.is-purged { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.loci-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.loci-cell { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 8px; padding: 10px 12px; }
.loci-cell b { display: block; font-size: 18px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.loci-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.loci-pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px 12px; margin: 0; }
.loci-section { margin: 18px 0 8px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: .06em; }
.loci-field { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 9px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.loci-field:last-child { border-bottom: 0; }
.loci-field select, .loci-field input[type="number"] { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 4px 8px; font: inherit; }
.loci-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; margin: 6px 0; }
.loci-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.loci-kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; font-size: 12px; }
.loci-kv dt { color: var(--dsw-alias-label-secondary); }
.loci-kv dd { margin: 0; }
.loci-detail-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.loci-evidence { border-left: 2px solid var(--dsw-alias-brand-primary); padding-left: 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: pre-wrap; }
`;

    /** Locale binding that never throws on a missing key. */
    function tOf(bind) {
      return (key) => {
        try {
          const value = bind(key);
          return typeof value === 'string' && value.length > 0 ? value : key;
        } catch {
          return key;
        }
      };
    }

    /** Fetch JSON with the session cookie; throws a readable error. */
    async function apiFetch(path, options = {}) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
        ...options,
      });
      const text = await response.text();
      let payload;
      try {
        payload = text.length === 0 ? {} : JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
      }
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      return payload;
    }

    /** Subscribe to one GET endpoint with an optional poll interval. */
    function useJson(path, options = {}) {
      const { intervalMs, enabled = true } = options;
      const [state, setState] = useState({ loading: true, data: undefined, error: undefined });
      const [nonce, setNonce] = useState(0);
      const reload = useCallback(() => setNonce((value) => value + 1), []);
      useEffect(() => {
        if (path === undefined || enabled !== true) return undefined;
        const controller = new AbortController();
        setState((previous) => ({ ...previous, loading: true }));
        apiFetch(path, { signal: controller.signal })
          .then((data) => setState({ loading: false, data, error: undefined }))
          .catch((error) => {
            if (controller.signal.aborted) return;
            setState({ loading: false, data: undefined, error: String(error?.message ?? error) });
          });
        return () => controller.abort();
      }, [path, nonce, enabled]);
      useEffect(() => {
        if (intervalMs === undefined || enabled !== true) return undefined;
        const timer = setInterval(reload, intervalMs);
        return () => clearInterval(timer);
      }, [intervalMs, reload, enabled]);
      return { ...state, reload };
    }

    const fmtDate = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '—');
    const fmtBytes = (n) => `${Math.round(Number(n) || 0)} B`;

    /**
     * Turn the few things currently understood into one paragraph.
     *
     * The card is a page of notes, so this reads as prose rather than a list: one
     * clause per entry, joined with 。or ， and cut when it stops fitting. Consensus
     * items lead with the agreement verb and a fact leads with its own subject, because "we
     * agreed" and "it happens to be true" are different kinds of knowing.
     */
    function proseOf(notes, t) {
      const clauses = [];
      for (const note of notes) {
        const title = String(note.title ?? '').trim().replace(/[。.]$/, '');
        if (title.length === 0) continue;
        const gist = typeof note.gist === 'string' && note.gist !== title ? note.gist : null;
        const body = gist === null ? title : `${title}，${gist}`;
        if (note.kind === 'rule') clauses.push(`${t('prose.agreed')}${body}`);
        else if (note.kind === 'procedural') clauses.push(`${t('prose.lesson')}${body}`);
        else clauses.push(body);
        // The card is narrow; three clauses already fill it. A fourth only shows
        // up when the first ones are unusually short.
        if (clauses.join('；').length > 90) break;
      }
      return `${clauses.join('；')}。`;
    }

    /** `2026-11-13 21:11`, matching the note style of the other sidebars. */
    function stampOf(ms) {
      if (!Number.isFinite(ms)) return '';
      const date = new Date(ms);
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }


    /**
     * How long ago something was understood, in words rather than numbers.
     *
     * "yesterday" and "just now" are the whole point of the card: they are what makes a
     * reader believe the memory is alive. A bare timestamp makes them do the
     * arithmetic instead.
     */
    function fmtSince(ms, t, now = Date.now()) {
      if (!Number.isFinite(ms)) return '';
      const delta = Math.max(0, now - ms);
      const minute = 60_000;
      if (delta < minute) return t('since.now');
      if (delta < 60 * minute) return t('since.minutes').replace('{n}', String(Math.floor(delta / minute)));
      if (delta < 24 * 60 * minute) return t('since.hours').replace('{n}', String(Math.floor(delta / (60 * minute))));
      if (delta < 48 * 60 * minute) return t('since.yesterday');
      if (delta < 30 * 24 * 60 * minute) {
        return t('since.days').replace('{n}', String(Math.floor(delta / (24 * 60 * minute))));
      }
      return new Date(ms).toISOString().slice(0, 10);
    }

    const ACTION_KEY = (action) => `action.${action}`;

    function StatusPill({ status, t }) {
      return h('span', { className: `loci-pill is-${status}` }, status);
    }

    function ErrorLine({ error, t }) {
      if (error === undefined) return null;
      return h('div', { className: 'loci-error' }, `${t('panel.error')}: ${error}`);
    }

    function Tabs({ value, onChange, tabs }) {
      return h(
        'div',
        { className: 'loci-tabs', role: 'tablist' },
        tabs.map((tab) =>
          h(
            'button',
            {
              key: tab.id,
              type: 'button',
              role: 'tab',
              'aria-selected': value === tab.id,
              className: `loci-tab${value === tab.id ? ' is-active' : ''}`,
              onClick: () => onChange(tab.id),
            },
            tab.label,
          ),
        ),
      );
    }

    /** The small version line shared by the card and the panel footer. */
    function VersionLabel({ t, update, onCheck, checking }) {
      // A chip, not a sentence. The old label said "update check is off" inline, which
      // is why the card header read like body copy; the state now lives in the tooltip.
      const version = update?.version;
      const hasUpdate = update?.updateAvailable === true;
      const note = checking
        ? t('card.checking')
        : update === undefined || update === null
          ? t('card.unknown')
          : hasUpdate
            ? t('card.updateTo')
            : update.status === 'disabled'
              ? t('card.checkOff')
              : t('card.upToDate');
      return h(
        'button',
        {
          type: 'button',
          className: 'loci-card-ver',
          title: note,
          'aria-label': note,
          disabled: checking,
          onClick: (event) => {
            event.stopPropagation();
            onCheck?.();
          },
        },
        version ? `v${version}` : t('card.unpublished'),
        hasUpdate ? h('span', { className: 'loci-card-dot is-error', 'aria-hidden': true }) : null,
      );
    }

    // ------------------------------------------------------------ sidebar card

    function MemoryCard(props) {
      const t = props?.t ?? ((key) => key);
      const wide = props?.wide !== false;
      const open = props?.openPanel;
      // A compact readout, not a note: the counts are the reason a person looks at this
      // strip at all. The earlier version showed one prose sentence and no numbers, which
      // read as bare text inside the sidebar rather than as a card — and the audit's own
      // "no dashboard" objection was about refusing to interrupt, not about hiding data.
      const stats = useJson('/stats', { intervalMs: 30_000 });
      const config = useJson('/config');
      const update = useJson('/update');
      const [checking, setChecking] = useState(false);
      const [fresh, setFresh] = useState(undefined);

      const check = useCallback(async () => {
        setChecking(true);
        try {
          const answer = await apiFetch('/update?refresh=1');
          setFresh(answer);
        } catch {
          setFresh({ version: undefined, status: 'unavailable', updateAvailable: false });
        } finally {
          setChecking(false);
        }
      }, []);

      const data = stats.data;
      const byStatus = data?.byStatus ?? {};
      const verified = Number(byStatus.verified ?? 0);
      const pending = Number(data?.pendingCandidates ?? byStatus.candidate ?? 0);
      const disputed = Number(data?.disputed ?? byStatus.disputed ?? 0);
      const entries = Number(data?.heads ?? 0);
      const injection = data?.lastInjection ?? null;
      const indexBytes = Number(injection?.bytes ?? 0);
      const budget = Number(config.data?.config?.sectionMaxBytes ?? 0);
      const usage = Array.isArray(data?.usage) ? data.usage : [];
      const injected = usage.reduce((total, row) => total + Number(row.injections ?? 0), 0);
      const opened = usage.reduce((total, row) => total + Number(row.reads ?? 0), 0);
      const dead = usage.filter((row) => Number(row.injections ?? 0) > 0 && Number(row.reads ?? 0) === 0).length;

      if (!wide) {
        return h(
          'button',
          {
            type: 'button',
            className: 'loci-card-root is-rail',
            title: t('card.open'),
            'aria-label': t('card.open'),
            onClick: () => open?.(),
          },
          h('style', null, CSS),
          h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M4 6.5h16M4 12h16M4 17.5h10', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
            h('circle', { cx: 18.5, cy: 17.5, r: 2.2, stroke: 'currentColor', strokeWidth: 1.5 }),
          ),
        );
      }

      const dotClass = stats.error !== undefined ? 'is-error' : pending > 0 || disputed > 0 ? 'is-warn' : '';
      const stamp = data === undefined ? '' : stampOf(injection?.ts ?? data.generatedAt ?? Date.now());
      const metric = (label, value, tone) =>
        h(
          'div',
          { className: 'loci-card-metric' },
          h('span', { className: 'loci-card-metric-label' }, label),
          h('span', { className: `loci-card-metric-value${tone ? ` ${tone}` : ''}` }, String(value)),
        );

      return h(
        'div',
        {
          className: 'loci-card-root',
          role: 'button',
          tabIndex: 0,
          onClick: () => open?.(),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') open?.();
          },
        },
        h('style', null, CSS),
        h(
          'div',
          { className: 'loci-card-head' },
          h(
            'span',
            { className: 'loci-card-mark', 'aria-hidden': true },
            h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none' },
              h('path', {
                d: 'M20 4c0 9-6.5 15-16 16 0 0 .5-7 4.5-11S20 4 20 4Z',
                stroke: 'currentColor',
                strokeWidth: 1.6,
                strokeLinejoin: 'round',
              }),
              h('path', { d: 'M5 20 14 10', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
            ),
          ),
          h('span', { className: 'loci-card-title' }, t('card.title')),
          h(VersionLabel, { t, update: fresh ?? update.data, onCheck: check, checking }),
          h('span', { className: `loci-card-dot ${dotClass}`.trim(), 'aria-hidden': true }),
          h('span', { className: 'loci-card-meta' }, stamp ? `${t('card.updated')} ${stamp}` : ''),
        ),
        stats.error !== undefined
          ? h('div', { className: 'loci-card-empty' }, stats.error)
          : data === undefined
            ? h('div', { className: 'loci-card-empty' }, t('panel.loading'))
            : entries === 0 && pending === 0 && disputed === 0
              ? h(
                  'div',
                  null,
                  h('div', { className: 'loci-card-empty' }, t('card.empty')),
                  h('div', { className: 'loci-card-hint' }, t('card.emptyHint')),
                )
              : h(
                  'div',
                  { className: 'loci-card-grid' },
                  metric(t('card.verified'), verified),
                  metric(t('card.pending'), pending, pending > 0 ? 'is-warn' : ''),
                  metric(t('card.disputed'), disputed, disputed > 0 ? 'is-error' : ''),
                ),
        data !== undefined && entries > 0 && budget > 0
          ? h(
              'div',
              { className: 'loci-card-barline' },
              h(
                'div',
                { className: 'loci-card-bar', role: 'presentation' },
                h('div', {
                  className: `loci-card-bar-fill${indexBytes / budget > 0.85 ? ' is-warn' : ''}`,
                  style: { width: `${Math.min(100, Math.round((indexBytes / budget) * 100))}%` },
                }),
              ),
              h('span', { className: 'loci-card-bar-label' }, `${indexBytes} / ${budget} B`),
            )
          : null,
        data !== undefined && injected > 0
          ? h(
              'div',
              { className: 'loci-card-foot' },
              h('span', null, `${t('card.injected')} ${injected}`),
              h('span', null, `${t('card.opened')} ${opened}`),
              dead > 0 ? h('span', null, `${t('card.dead')} ${dead}`) : null,
              h('span', { className: 'loci-card-foot-grow' }),
            )
          : null,
        pending > 0 ? h('div', { className: 'loci-card-hint' }, t('card.pendingHint').replace('{n}', String(pending))) : null,
      );
    }
    // ---------------------------------------------------------------- panel

    function FeedTab({ t, onOpen }) {
      const { data, error, loading, reload } = useJson('/activity?limit=60', { intervalMs: 20_000 });
      // One row per entry, not per event: "added earlier, verified just now" is
      // one story. Events for the same id collapse into a chain of tags and the
      // row keeps the position of its newest event.
      const rows = [];
      const byId = new Map();
      for (const item of data?.items ?? []) {
        const seen = item.id === null ? undefined : byId.get(item.id);
        if (seen !== undefined) {
          if (!seen.chain.includes(item.action)) seen.chain.push(item.action);
          continue;
        }
        const row = { ...item, chain: [item.action] };
        rows.push(row);
        if (item.id !== null) byId.set(item.id, row);
      }
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'loci-meta', style: { marginBottom: '10px', alignItems: 'center' } },
          h('span', { className: 'loci-muted' }, t('panel.feedHint')),
          h('span', { className: 'loci-grow' }),
          h('button', { type: 'button', className: 'loci-btn', onClick: reload }, t('panel.refresh')),
        ),
        h(ErrorLine, { error, t }),
        loading && data === undefined ? h('div', { className: 'loci-muted' }, t('panel.loading')) : null,
        data !== undefined && rows.length === 0 ? h('div', { className: 'loci-muted' }, t('panel.empty')) : null,
        rows.map((item, index) =>
          h(
            'div',
            { key: `${item.ts}-${item.id ?? 'x'}-${index}`, className: 'loci-row' },
            h(
              'span',
              { className: 'loci-actions', style: { gap: '3px' } },
              item.chain.map((action, step) =>
                h(
                  'span',
                  { key: `${action}-${step}`, className: 'loci-tag is-' + action, style: { display: 'flex', gap: '3px' } },
                  step > 0 ? h('span', { className: 'loci-muted' }, '→') : null,
                  t(ACTION_KEY(action)),
                ),
              ),
            ),
            h(
              'div',
              { className: 'loci-main' },
              h('div', { className: 'loci-name' }, item.title ?? (item.action === 'maintained' ? t('action.maintained') : '—')),
              h(
                'div',
                { className: 'loci-meta' },
                h('span', null, fmtSince(item.ts, t)),
                item.kind ? h('span', null, t(`kind.${item.kind}`)) : null,
                item.scope ? h('span', null, item.scope) : null,
                item.detail
                  ? h(
                      'span',
                      null,
                      `${item.detail.closedCandidates} closed${item.detail.reindexed ? ' · reindexed' : ''}`,
                    )
                  : null,
              ),
            ),
            h(
              'div',
              { className: 'loci-actions' },
              item.id
                ? h('button', { type: 'button', className: 'loci-btn is-quiet', onClick: () => onOpen(item.id) }, '→')
                : null,
            ),
          ),
        ),
      );
    }

    function Row({ item, t, onOpen }) {
      return h(
        'div',
        { className: 'loci-row' },
        h('span', { className: 'loci-id' }, item.id.slice(0, 10)),
        h(
          'div',
          { className: 'loci-main' },
          h('div', { className: 'loci-name' }, item.title),
          h(
            'div',
            { className: 'loci-meta' },
            h('span', null, t(`kind.${item.kind}`)),
            h('span', null, item.scope),
            h('span', null, fmtDate(item.validFrom)),
            item.pinned ? h('span', null, '★') : null,
            item.total !== undefined ? h('span', null, `${t('panel.total')}: ${item.total}`) : null,
          ),
          item.snippet ? h('div', { className: 'loci-snippet' }, item.snippet) : null,
        ),
        h(
          'div',
          { className: 'loci-actions' },
          h(StatusPill, { status: item.status, t }),
          h('button', { type: 'button', className: 'loci-btn', onClick: () => onOpen(item.id) }, '→'),
        ),
      );
    }

    function Detail({ id, t, onBack, onChange }) {
      const { data, error, loading, reload } = useJson(`/item?id=${encodeURIComponent(id)}&history=1`);
      // \edges\ is a sibling of \entry\ in the API payload; fold it in so the detail view\n      // can show declared relations without a second request.\n      const entry = data?.entry === undefined ? undefined : { ...data.entry, edges: data.edges ?? [] };
      const act = async (path, body) => {
        try {
          await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
          reload();
          onChange?.();
        } catch (failure) {
          window.console?.warn?.('loci: action failed', failure);
        }
      };
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'loci-detail-head' },
          h('button', { type: 'button', className: 'loci-btn', onClick: onBack }, `← ${t('panel.back')}`),
          h('span', { className: 'loci-grow' }),
          entry
            ? h(
                'div',
                { className: 'loci-actions' },
                entry.status !== 'verified'
                  ? h('button', { type: 'button', className: 'loci-btn is-primary', onClick: () => act('/verify', { id, status: 'verified' }) }, t('panel.verify'))
                  : null,
                entry.status !== 'disputed'
                  ? h('button', { type: 'button', className: 'loci-btn', onClick: () => act('/verify', { id, status: 'disputed' }) }, t('panel.dispute'))
                  : null,
                h(
                  'button',
                  { type: 'button', className: 'loci-btn', onClick: () => act('/verify', { id, status: entry.pinned ? 'unpin' : 'pin' }) },
                  entry.pinned ? t('panel.unpin') : t('panel.pin'),
                ),
                entry.status === 'deleted'
                  ? h('button', { type: 'button', className: 'loci-btn', onClick: () => act('/delete', { id, mode: 'restore' }) }, t('panel.restore'))
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'loci-btn is-danger',
                        onClick: () => {
                          if (window.confirm?.(t('panel.confirmDelete')) === false) return;
                          act('/delete', { id, mode: 'soft' });
                        },
                      },
                      t('panel.delete'),
                    ),
              )
            : null,
        ),
        h(ErrorLine, { error, t }),
        loading && entry === undefined ? h('div', { className: 'loci-muted' }, t('panel.loading')) : null,
        entry
          ? h(
              'div',
              null,
              h('div', { className: 'loci-name', style: { fontSize: '15px', fontWeight: 600 } }, entry.title),
              h(
                'div',
                { className: 'loci-meta' },
                h('span', { className: 'loci-id' }, `${entry.id}@${entry.revision}`),
                h(StatusPill, { status: entry.status, t }),
                h('span', null, entry.kind),
                h('span', null, `${entry.scope}:${entry.scopeLabel}`),
                h('span', null, `${fmtDate(entry.validFrom)} → ${entry.validTo === null ? 'now' : fmtDate(entry.validTo)}`),
              ),
              h('div', { className: 'loci-section' }, 'Body'),
              h('pre', { className: 'loci-pre' }, entry.body),
              // A lesson's shape, and the relations that record a partial correction.
              // Both are read-only here: they come from the write that created the entry.
              ['pattern', 'fix', 'prevents', 'when'].some((key) => typeof entry[key === 'when' ? 'whenCondition' : key] === 'string')
                ? h(
                    'div',
                    null,
                    h('div', { className: 'loci-section' }, t('panel.lesson')),
                    h(
                      'dl',
                      { className: 'loci-kv' },
                      ...['pattern', 'fix', 'prevents', 'when'].flatMap((key) => {
                        const value = entry[key === 'when' ? 'whenCondition' : key];
                        return typeof value === 'string' && value.length > 0
                          ? [h('dt', { key: `${key}-k` }, t(`panel.lesson.${key}`)), h('dd', { key: `${key}-v` }, value)]
                          : [];
                      }),
                    ),
                  )
                : null,
              (entry.edges ?? []).some((edge) => edge.relation === 'conflicts' || edge.relation === 'extends')
                ? h(
                    'div',
                    null,
                    h('div', { className: 'loci-section' }, t('panel.relations')),
                    ...(entry.edges ?? [])
                      .filter((edge) => edge.relation === 'conflicts' || edge.relation === 'extends')
                      .map((edge) => {
                        const other = edge.src_id === entry.id ? edge.dst_id : edge.src_id;
                        return h(
                          'div',
                          { key: `${edge.relation}-${other}`, className: 'loci-meta' },
                          h('span', null, edge.relation),
                          h('code', { className: 'loci-id' }, other),
                        );
                      }),
                  )
                : null,
              entry.sourceRef
                ? h(
                    'div',
                    null,
                    h('div', { className: 'loci-section' }, t('panel.source')),
                    h(
                      'div',
                      { className: 'loci-meta' },
                      h('code', { className: 'loci-id' }, entry.sourceRef),
                    ),
                  )
                : null,
              entry.evidence?.quote
                ? h(
                    'div',
                    null,
                    h('div', { className: 'loci-section' }, t('panel.evidence')),
                    h('div', { className: 'loci-evidence' }, entry.evidence.quote),
                  )
                : null,
              h('div', { className: 'loci-section' }, t('panel.history')),
              h(
                'div',
                { className: 'loci-kv' },
                (data.history ?? []).map((revision) =>
                  h(
                    'div',
                    { key: revision.revision, style: { display: 'contents' } },
                    h('dt', null, `r${revision.revision}`),
                    h(
                      'dd',
                      null,
                      `${revision.status} · ${fmtDate(revision.validFrom)} → ${revision.validTo === null ? 'now' : fmtDate(revision.validTo)}${revision.supersededBy ? ` → ${revision.supersededBy}` : ''}`,
                    ),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    function IndexTab({ t }) {
      const { data, error, loading, reload } = useJson('/preview');
      return h(
        'div',
        null,
        h('div', { className: 'loci-muted', style: { marginBottom: '8px' } }, t('panel.indexHint')),
        h(
          'div',
          { className: 'loci-actions', style: { marginBottom: '10px' } },
          h('button', { type: 'button', className: 'loci-btn', onClick: reload }, t('panel.refresh')),
          data
            ? h(
                'span',
                { className: 'loci-meta' },
                h('span', null, `${fmtBytes(data.bytes)} ${t('panel.bytes')}`),
                h('span', null, `${t('panel.listed')}: ${data.listed}`),
                h('span', null, `${t('panel.hidden')}: ${data.hidden}`),
              )
            : null,
        ),
        h(ErrorLine, { error, t }),
        loading && data === undefined ? h('div', { className: 'loci-muted' }, t('panel.loading')) : null,
        data ? h('pre', { className: 'loci-pre' }, data.text.length === 0 ? t('panel.empty') : data.text) : null,
      );
    }

    function SearchTab({ t, onOpen }) {
      const [draft, setDraft] = useState('');
      const [query, setQuery] = useState('');
      const [pages, setPages] = useState([]);
      const [error, setError] = useState(undefined);
      const [loading, setLoading] = useState(false);
      const request = async (cursor) => {
        setLoading(true);
        setError(undefined);
        try {
          const params = new URLSearchParams({ q: query, limit: '20', status: 'any' });
          if (cursor) params.set('cursor', cursor);
          const data = await apiFetch(`/list?${params.toString()}`);
          setPages((previous) => (cursor ? [...previous, data] : [data]));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setLoading(false);
        }
      };
      useEffect(() => {
        if (query.length === 0) return;
        request(undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [query]);
      const hits = pages.flatMap((page) => page.hits ?? []);
      const last = pages.at(-1);
      return h(
        'div',
        null,
        h(
          'form',
          {
            onSubmit: (event) => {
              event.preventDefault();
              setQuery(draft.trim());
            },
            style: { marginBottom: '10px' },
          },
          h('input', {
            className: 'loci-input',
            value: draft,
            placeholder: t('panel.searchPlaceholder'),
            onChange: (event) => setDraft(event.target.value),
          }),
        ),
        h(ErrorLine, { error, t }),
        last ? h('div', { className: 'loci-meta' }, `${t('panel.total')}: ${last.total}`) : null,
        hits.length === 0 && last !== undefined && !loading ? h('div', { className: 'loci-muted' }, t('panel.searchEmpty')) : null,
        hits.map((hit) => h(Row, { key: hit.id, t, item: hit, onOpen })),
        last?.hasMore
          ? h('button', { type: 'button', className: 'loci-btn', disabled: loading, onClick: () => request(last.cursor) }, t('panel.more'))
          : null,
      );
    }

    function ReviewTab({ t, onOpen, onChanged }) {
      // Only the kinds that could actually reach the prompt are reviewable. An
      // episodic session summary is history: it is never injected, so parking it
      // here forever is how the queue became a wall nobody reads.
      const reviewable = 'kinds=rule,semantic,procedural';
      const candidates = useJson(`/list?status=candidate&limit=50&${reviewable}`);
      const disputed = useJson(`/list?status=disputed&limit=50&${reviewable}`);
      const [busy, setBusy] = useState(undefined);
      const [failed, setFailed] = useState(undefined);
      const act = async (path, body, id) => {
        setBusy(id);
        setFailed(undefined);
        try {
          await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
          candidates.reload();
          disputed.reload();
          onChanged?.();
        } catch (failure) {
          // A swallowed click is worse than a visible error: the user cannot tell
          // "it worked" from "nothing happened".
          setFailed(`${body.id ?? 'bulk'}: ${String(failure?.message ?? failure)}`);
        } finally {
          setBusy(undefined);
        }
      };
      const verifyMany = async (items) => {
        setBusy('bulk');
        setFailed(undefined);
        try {
          for (const item of items) {
            await apiFetch('/verify', { method: 'POST', body: JSON.stringify({ id: item.id, status: 'verified' }) });
          }
          candidates.reload();
          disputed.reload();
          onChanged?.();
        } catch (failure) {
          setFailed(String(failure?.message ?? failure));
        } finally {
          setBusy(undefined);
        }
      };
      const row = (item, actions) =>
        h(
          'div',
          { key: item.id, className: 'loci-row' },
          h('span', { className: 'loci-id' }, item.id.slice(0, 10)),
          h(
            'div',
            { className: 'loci-main' },
            h('div', { className: 'loci-name' }, item.title),
            item.snippet ? h('div', { className: 'loci-snippet' }, item.snippet) : null,
            h('div', { className: 'loci-meta' }, h('span', null, t(`kind.${item.kind}`)), item.scope ? h('span', null, item.scope) : null),
          ),
          h('div', { className: 'loci-actions' }, actions, h('button', { type: 'button', className: 'loci-btn is-quiet', onClick: () => onOpen(item.id) }, '→')),
        );
      // A session digest arrives as a batch. Showing five identical-shaped rows with
      // no grouping is what turns one sitting into five decisions; grouping lets the
      // reviewer confirm the batch that was proposed together.
      const bySession = (items) => {
        const groups = new Map();
        for (const item of items) {
          const key = item.sourceSession ?? '';
          const list = groups.get(key);
          if (list === undefined) groups.set(key, [item]);
          else list.push(item);
        }
        return groups;
      };
      const sessionGroups = (items) =>
        [...bySession(items).entries()]
          .filter(([key, list]) => key !== '' && list.length > 1)
          .map(([key, list]) =>
            h(
              'div',
              { key, className: 'loci-meta', style: { margin: '10px 0 4px', alignItems: 'center' } },
              h('span', null, `${t('panel.digestOf').replace('{n}', String(list.length))} · ${key.slice(0, 12)}`),
              h('span', { className: 'loci-grow' }),
              h(
                'button',
                { type: 'button', className: 'loci-btn is-primary', disabled: busy !== undefined, onClick: () => verifyMany(list) },
                t('panel.verifyGroup').replace('{n}', String(list.length)),
              ),
            ),
          );
      const block = (title, state, actions) =>
        h(
          'div',
          null,
          h(
            'div',
            { className: 'loci-meta', style: { margin: '18px 0 8px', alignItems: 'center' } },
            h('div', { className: 'loci-section', style: { margin: 0 } }, `${title} (${state.data?.total ?? 0})`),
            h('span', { className: 'loci-grow' }),
            state.data?.items?.length
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'loci-btn',
                    disabled: busy !== undefined,
                    onClick: () => verifyMany(state.data.items),
                  },
                  t('panel.verifyAll').replace('{n}', String(state.data.items.length)),
                )
              : null,
          ),
          state.data?.items?.length
            ? [sessionGroups(state.data.items), ...state.data.items.map((item) => row(item, actions(item)))]
            : h('div', { className: 'loci-muted' }, t('panel.noCandidates')),
        );
      const candidateActions = (item) => [
        h(
          'button',
          { key: 'v', type: 'button', className: 'loci-btn is-primary', disabled: busy !== undefined, onClick: () => act('/verify', { id: item.id, status: 'verified' }, item.id) },
          t('panel.verify'),
        ),
        h(
          'button',
          {
            key: 'r',
            type: 'button',
            className: 'loci-btn is-danger',
            disabled: busy !== undefined,
            onClick: () => act('/delete', { id: item.id, mode: 'soft', reason: 'rejected in review' }, item.id),
          },
          t('panel.reject'),
        ),
      ];
      const disputedActions = (item) => [
        h(
          'button',
          { key: 'v', type: 'button', className: 'loci-btn is-primary', disabled: busy !== undefined, onClick: () => act('/verify', { id: item.id, status: 'verified' }, item.id) },
          t('panel.verify'),
        ),
      ];
      return h(
        'div',
        null,
        h(ErrorLine, { error: candidates.error ?? disputed.error, t }),
        failed !== undefined ? h('div', { className: 'loci-error' }, `${t('panel.actionFailed')}: ${failed}`) : null,
        h('div', { className: 'loci-muted' }, t('panel.reviewHint')),
        block(t('panel.candidates'), candidates, candidateActions),
        block(t('panel.disputed'), disputed, disputedActions),
      );
    }

    function StatsTab({ t }) {
      const { data, error, loading, reload } = useJson('/stats', { intervalMs: 15_000 });
      if (loading && data === undefined) return h('div', { className: 'loci-muted' }, t('panel.loading'));
      const cell = (label, value) => h('div', { className: 'loci-cell' }, h('span', { className: 'loci-label' }, label), h('b', null, value));
      const vs = data?.vector ?? {};
      return h(
        'div',
        null,
        h(ErrorLine, { error, t }),
        data
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'loci-grid' },
                cell('entries', data.heads ?? 0),
                cell('revisions', data.revisions ?? 0),
                cell(t('panel.candidates'), data.pendingCandidates ?? 0),
                cell('disputed', data.disputed ?? 0),
                cell('db', fmtBytes(data.dbBytes)),
                cell('index rev', data.indexRev ?? 0),
              ),
              h('div', { className: 'loci-section' }, t('panel.store')),
              h(
                'dl',
                { className: 'loci-kv' },
                h('dt', null, 'path'), h('dd', null, data.memoryRoot ?? '—'),
                h('dt', null, 'schema'), h('dd', null, `v${data.schemaVersion}`),
                h('dt', null, 'host'), h('dd', null, data.hostVersion ?? 'unknown'),
                h('dt', null, 'vector'), h('dd', null, `${vs.mode ?? 'off'}${vs.healthy ? ' · healthy' : ''}${vs.lastError ? ` · ${vs.lastError}` : ''}`),
                h('dt', null, 'last injection'),
                h('dd', null, data.lastInjection ? `${data.lastInjection.bytes} B · ${data.lastInjection.listed} listed · ${data.lastInjection.hidden} hidden` : '—'),
              ),
              h('div', { className: 'loci-section' }, t('panel.injections')),
              (data.injections ?? []).slice(0, 20).map((row, index) =>
                h(
                  'div',
                  { key: `${row.ts}-${index}`, className: 'loci-row' },
                  h('span', { className: 'loci-id' }, new Date(row.ts).toLocaleTimeString()),
                  h('div', { className: 'loci-main' }, h('div', { className: 'loci-name' }, `${row.sectionBytes} ${t('panel.bytes')}`), h('div', { className: 'loci-meta' }, `${row.listed} listed · ${row.hidden} hidden`)),
                ),
              ),
              h('div', { className: 'loci-meta', style: { marginTop: '14px' } }, `${t('panel.version')} v${data.pluginVersion ?? '—'}`),
              // Which lines spend prompt bytes and are never opened. Sorted host-side,
              // so the first row is the most expensive and least used.
              (data.usage ?? []).some((row) => row.injections > 0 && row.reads === 0)
                ? h(
                    'div',
                    null,
                    h('div', { className: 'loci-section' }, t('panel.deadWeight')),
                    (data.usage ?? [])
                      .filter((row) => row.injections > 0 && row.reads === 0)
                      .slice(0, 8)
                      .map((row) =>
                        h(
                          'div',
                          { key: row.id, className: 'loci-row' },
                          h('span', { className: 'loci-id' }, row.id),
                          h(
                            'div',
                            { className: 'loci-main' },
                            h('div', { className: 'loci-name' }, row.title),
                            h('div', { className: 'loci-meta' }, `${row.injections}×${t('panel.injected')} · 0×${t('panel.opened')}`),
                          ),
                        ),
                      ),
                  )
                : null,
            )
          : null,
      );
    }

    function MemoryPanel({ t }) {
      const [tab, setTab] = useState('feed');
      const [selected, setSelected] = useState(undefined);
      const [nonce, setNonce] = useState(0);
      const tabs = useMemo(
        () => [
          { id: 'feed', label: t('panel.feed') },
          { id: 'index', label: t('panel.index') },
          { id: 'search', label: t('panel.search') },
          { id: 'review', label: t('panel.review') },
          { id: 'stats', label: t('panel.stats') },
        ],
        [t],
      );
      const changed = useCallback(() => setNonce((value) => value + 1), []);
      return h(
        'div',
        { className: 'loci-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'loci-bar' },
          h('span', { className: 'loci-title' }, t('panel.title')),
          h('span', { className: 'loci-grow' }),
          selected === undefined ? h(Tabs, { value: tab, onChange: setTab, tabs }) : null,
        ),
        h(
          'div',
          { className: 'loci-body' },
          selected !== undefined
            ? h(Detail, { id: selected, t, onBack: () => setSelected(undefined), onChange: changed })
            : tab === 'feed'
              ? h(FeedTab, { t, onOpen: setSelected, key: `feed-${nonce}` })
              : tab === 'index'
                ? h(IndexTab, { t, key: `index-${nonce}` })
                : tab === 'search'
                  ? h(SearchTab, { t, onOpen: setSelected })
                  : tab === 'review'
                    ? h(ReviewTab, { t, onOpen: setSelected, onChanged: changed })
                    : h(StatsTab, { t }),
        ),
      );
    }

    function PanelIcon({ size, active }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { opacity: active ? 1 : 0.75, display: 'block' },
        },
        h('path', { d: 'M4 6.5h16M4 12h16M4 17.5h10', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('circle', { cx: 18.5, cy: 17.5, r: 2.2, stroke: 'currentColor', strokeWidth: 1.5 }),
      );
    }

    function SettingsIcon({ size }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M5 7h14M5 12h14M5 17h9', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      );
    }

    // --------------------------------------------------------------- settings

    function Field({ label, hint, children }) {
      return h(
        'div',
        { className: 'loci-field' },
        h('div', null, h('div', null, label), hint ? h('div', { className: 'loci-muted' }, hint) : null),
        h('div', null, children),
      );
    }

    function SettingsSection(props) {
      const t = props?.t ?? ((key) => key);
      const ctx = props?.ctx;
      const effective = useJson('/config');
      const [status, setStatus] = useState(undefined);
      const [forgetPhrase, setForgetPhrase] = useState('');
      const [forgetBusy, setForgetBusy] = useState(false);
      const [forgetResult, setForgetResult] = useState(undefined);
      const forms = ctx?.get?.('configForms');
      const form = forms?.get?.(ENTRY_ID);
      const [snapshot, setSnapshot] = useState(() => form?.getSnapshot?.() ?? { status: 'unavailable', value: undefined, writable: false });
      useEffect(() => {
        if (!form?.subscribe) return undefined;
        setSnapshot(form.getSnapshot());
        return form.subscribe(() => setSnapshot(form.getSnapshot()));
      }, [form]);
      const values = { ...(effective.data?.config ?? {}), ...(snapshot?.value ?? {}) };
      const write = async (field, value) => {
        if (!form?.set) return;
        setStatus('saving');
        try {
          const ok = await form.set(field, value);
          setStatus(ok ? 'saved' : 'rejected');
        } catch {
          setStatus('failed');
        }
        setTimeout(() => setStatus(undefined), 2500);
      };
      const select = (field, options, current) =>
        h(
          'select',
          { value: String(current), disabled: !form?.set, onChange: (event) => write(field, event.target.value) },
          options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        );
      return h(
        'div',
        { className: 'loci-root', style: { height: 'auto' } },
        h('style', null, CSS),
        h('div', { className: 'loci-muted', style: { marginBottom: '8px' } }, t('settings.intro')),
        form?.set ? null : h('div', { className: 'loci-muted' }, t('settings.unavailable')),
        h(ErrorLine, { error: effective.error, t }),
        h(
          'div',
          null,
          h(Field, {
            label: t('settings.budget'),
            hint: t('settings.budgetHint'),
            children: h('input', {
              type: 'number',
              min: 1024,
              max: 16384,
              step: 256,
              value: values.sectionMaxBytes ?? 3584,
              disabled: !form?.set,
              onChange: (event) => write('sectionMaxBytes', Number(event.target.value)),
            }),
          }),
          h(Field, {
            label: t('settings.scope'),
            children: select('defaultScope', [
              { value: 'workspace', label: 'workspace' },
              { value: 'project', label: 'project' },
              { value: 'global', label: 'global' },
            ], values.defaultScope ?? 'workspace'),
          }),
          h(Field, {
            label: t('settings.capture'),
            children: select('captureMode', [
              { value: 'rules', label: t('captureRules') },
              { value: 'off', label: t('off') },
            ], values.captureMode ?? 'rules'),
          }),
          h(Field, {
            label: t('settings.assist'),
            children: select('recallAssist', [
              { value: 'off', label: t('off') },
              { value: 'session-start', label: 'session-start' },
            ], values.recallAssist ?? 'off'),
          }),
          h(Field, {
            label: t('settings.maintenance'),
            children: select('maintenanceMode', [
              { value: 'sweep', label: 'every 6h' },
              { value: 'off', label: t('off') },
            ], values.maintenanceMode ?? 'sweep'),
          }),
          h(Field, {
            label: t('settings.secret'),
            children: select('secretPolicy', [
              { value: 'redact', label: t('secretRedact') },
              { value: 'reject', label: t('secretReject') },
            ], values.secretPolicy ?? 'redact'),
          }),
          h(Field, {
            label: t('settings.vector'),
            children: select('vectorMode', [
              { value: 'off', label: t('vectorOff') },
              { value: 'http', label: t('vectorHttp') },
            ], values.vectorMode ?? 'off'),
          }),
        ),
        h('div', { className: 'loci-section' }, t('settings.danger')),
        h('div', { className: 'loci-muted' }, t('settings.dangerHint')),
        h(
          'div',
          { className: 'loci-row', style: { borderBottom: 0 } },
          h('input', {
            className: 'loci-input',
            value: forgetPhrase,
            placeholder: t('settings.dangerPhrase'),
            onChange: (event) => setForgetPhrase(event.target.value),
            style: { maxWidth: '260px' },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'loci-btn is-danger',
              disabled: forgetPhrase.trim().length === 0 || forgetBusy,
              onClick: async () => {
                setForgetBusy(true);
                setForgetResult(undefined);
                try {
                  const answer = await apiFetch('/forget-all', {
                    method: 'POST',
                    body: JSON.stringify({ confirm: forgetPhrase.trim(), mode: 'soft' }),
                  });
                  setForgetResult(t('settings.dangerDone').replace('{n}', String(answer.count ?? 0)));
                  setForgetPhrase('');
                } catch (failure) {
                  setForgetResult(`${t('panel.actionFailed')}: ${String(failure?.message ?? failure)}`);
                } finally {
                  setForgetBusy(false);
                }
              },
            },
            forgetBusy ? t('settings.dangerBusy') : t('settings.dangerRun'),
          ),
        ),
        forgetResult !== undefined ? h('div', { className: 'loci-muted' }, forgetResult) : null,
        h('div', { className: 'loci-section' }, t('settings.diagnostics')),
        h(
          'dl',
          { className: 'loci-kv' },
          h('dt', null, 'store'), h('dd', null, effective.data?.config?.home ? String(effective.data.config.home) : 'DSH_HOME/memory/loci'),
          h('dt', null, 'schema'), h('dd', null, 'v1'),
          h('dt', null, 'status'), h('dd', null, status ?? '—'),
        ),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN }), 'dsh-loci: locale dictionaries');
      const bind = ctx.locale.bind(NS);
      const t = tOf(bind);

      // The sidebar mirror: a card beside Settings, always visible while the sidebar is.
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'loci-card',
            order: 10,
            label: () => t('card.title'),
            locale: NS,
            inject: () => ({ t, openPanel: ctx.layout ? () => ctx.layout.selectPanel(PANEL_ID) : undefined }),
          },
          MemoryCard,
        ),
      );
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: NS,
            order: 25,
            label: () => t('settings.title'),
            locale: NS,
            inject: () => ({ t, ctx }),
          },
          SettingsSection,
        ),
      );
      ctx.slots.inject('settings.section.icon', () =>
        ctx.slots.register({ name: 'settings.section.icon', id: NS, locale: NS }, SettingsIcon),
      );
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: () => t('panel.title'),
            locale: NS,
          },
          PanelIcon,
        ),
      );
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) }, MemoryPanel),
      );
    }

    return { inject: ['slots', 'locale', 'layout'], apply };
  },
});
