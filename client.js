/**
 * dsh-loci — Client half.
 *
 * Two surfaces over the Host's owner-only API:
 *
 * - a **sidebar mirror** (`sidebar.footer.action`): a flat, dense card that
 *   shows what memory changed today and last week, with the last few changes
 *   as one-liners. It is the "副屏" — glanceable, never modal;
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
      'card.empty': 'Nothing learned yet',
      'card.emptyHint': 'Facts you confirm appear here',
      'card.today': 'today',
      'card.week': 'this week',
      'card.pending': 'to review',
      'card.open': 'Open memory',
      'card.check': 'Check for updates',
      'card.upToDate': 'Up to date',
      'card.updateTo': 'Update available',
      'card.checking': 'Checking…',
      'card.unknown': 'Version check unavailable',
      'card.unpublished': 'Not on npm yet',

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
      'panel.candidates': 'Candidates',
      'panel.disputed': 'Disputed',
      'panel.noCandidates': 'Nothing waiting for review.',
      'panel.injections': 'Recent injections',
      'panel.store': 'Store',
      'panel.confirmDelete': 'Soft-delete this entry?',
      'panel.error': 'Request failed',
      'panel.updated': 'Updated',
      'panel.version': 'version',
    };

    const ZH = {
      'meta.title': 'Loci 记忆宫殿',
      'meta.description':
        '分层长期记忆：提示词里只放稳定索引，全文按需一次取回；只有已核实的记忆才会被注入。',

      'card.title': '记忆',
      'card.empty': '还没有学到东西',
      'card.emptyHint': '确认过的事实会出现在这里',
      'card.today': '今日',
      'card.week': '本周',
      'card.pending': '待审',
      'card.open': '打开记忆',
      'card.check': '检查更新',
      'card.upToDate': '已是最新',
      'card.updateTo': '有新版本',
      'card.checking': '检查中…',
      'card.unknown': '无法检查版本',
      'card.unpublished': '尚未发布',

      'action.added': '新增',
      'action.revised': '更正',
      'action.verified': '核实',
      'action.disputed': '存疑',
      'action.pinned': '置顶',
      'action.unpinned': '取消置顶',
      'action.deleted': '删除',
      'action.purged': '彻底删除',
      'action.restored': '恢复',
      'action.imported': '导入',
      'action.maintained': '维护',

      'settings.title': 'Loci',
      'settings.intro': '给 agent 的长期记忆。标注「即时」的改动立即生效。',
      'settings.unavailable': '当前缺少设置服务，以下显示实际生效的配置。',
      'settings.saved': '已保存',
      'settings.rejected': '宿主拒绝写入',
      'settings.failed': '写入失败',
      'settings.budget': '索引预算',
      'settings.budgetHint': '整段注入的字节上限',
      'settings.scope': '新事实的默认作用域',
      'settings.capture': '会话捕获',
      'settings.assist': '首轮辅助召回',
      'settings.maintenance': '后台维护',
      'settings.secret': '记忆中的密钥',
      'settings.vector': '向量通道',
      'settings.diagnostics': '诊断',
      'off': '关闭',
      'captureRules': '仅规则',
      'secretRedact': '脱敏',
      'secretReject': '拒绝写入',
      'vectorOff': '关闭（仅词法）',
      'vectorHttp': 'HTTP 端点',

      'panel.title': '记忆',
      'panel.feed': '动态',
      'panel.index': '索引',
      'panel.search': '检索',
      'panel.review': '待审',
      'panel.stats': '统计',
      'panel.refresh': '刷新',
      'panel.loading': '加载中…',
      'panel.empty': '这里还没有内容。',
      'panel.feedHint': '记住了什么、更正了什么、核实或删除了什么。最新的在前。',
      'panel.indexHint': '与模型系统提示里完全一致的那一段，以及它的字节开销。',
      'panel.bytes': '字节',
      'panel.listed': '已列出',
      'panel.hidden': '未列出',
      'panel.searchPlaceholder': '检索标题与正文…',
      'panel.searchEmpty': '没有匹配。',
      'panel.more': '加载更多',
      'panel.total': '总数',
      'panel.verify': '核实',
      'panel.dispute': '标记争议',
      'panel.delete': '删除',
      'panel.restore': '恢复',
      'panel.pin': '置顶',
      'panel.unpin': '取消置顶',
      'panel.back': '返回',
      'panel.history': '历史',
      'panel.evidence': '证据',
      'panel.candidates': '候选',
      'panel.disputed': '争议',
      'panel.noCandidates': '没有待审条目。',
      'panel.injections': '最近注入',
      'panel.store': '存储',
      'panel.confirmDelete': '软删除这条记忆？',
      'panel.error': '请求失败',
      'panel.updated': '更新于',
      'panel.version': '版本',
    };

    const CSS = `
.loci-root { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); font-size: 13px; }
.loci-card-root { display: flex; flex-direction: column; gap: 6px; width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 8px; cursor: pointer; text-align: left; font: inherit; color: inherit; }
.loci-card-root:hover { background: var(--dsw-alias-bg-layer-2); }
.loci-card-root.is-rail { padding: 6px; align-items: center; justify-content: center; }
.loci-card-head { display: flex; align-items: center; gap: 6px; width: 100%; }
.loci-card-title { font-size: 12px; font-weight: 600; letter-spacing: .01em; }
.loci-card-grow { flex: 1 1 auto; }
.loci-card-ver { font-size: 10px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.loci-card-counts { display: flex; gap: 12px; }
.loci-count { display: flex; align-items: baseline; gap: 4px; }
.loci-count b { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.loci-count span { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.loci-card-feed { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.loci-card-line { display: flex; gap: 6px; align-items: baseline; font-size: 11px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.loci-card-line em { font-style: normal; flex: 0 0 auto; font-size: 10px; padding: 0 4px; border-radius: 3px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.loci-card-line span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.loci-card-empty { font-size: 11px; color: var(--dsw-alias-label-secondary); }
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

    /** "3m", "2h", "5d" — short enough for a card line. */
    function fmtAgo(ms, now = Date.now()) {
      if (!Number.isFinite(ms)) return '';
      const delta = Math.max(0, now - ms);
      const minute = 60_000;
      if (delta < minute) return 'now';
      if (delta < 60 * minute) return `${Math.floor(delta / minute)}m`;
      if (delta < 24 * 60 * minute) return `${Math.floor(delta / (60 * minute))}h`;
      return `${Math.floor(delta / (24 * 60 * minute))}d`;
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
    function VersionLine({ t, update, onCheck, checking }) {
      const version = typeof update?.version === 'string' ? update.version.replace(/^v/i, '') : null;
      const hasUpdate = update?.updateAvailable === true;
      const unknown = update !== undefined && update.status === 'unavailable';
      const text = hasUpdate
        ? `${t('card.updateTo')}${update.latestVersion ? ` · v${update.latestVersion}` : ''}`
        : unknown
          ? t('card.unknown')
          : update?.status === 'ok'
            ? t('card.upToDate')
            : t('card.check');
      return h(
        'span',
        { className: 'loci-card-line', style: { gap: '5px' } },
        version ? h('span', { className: 'loci-card-ver' }, `v${version}`) : null,
        h(
          'button',
          {
            type: 'button',
            className: 'loci-btn is-quiet',
            title: text,
            disabled: checking === true,
            onClick: (event) => {
              event.stopPropagation();
              onCheck?.();
            },
          },
          checking === true ? t('card.checking') : text,
        ),
        hasUpdate ? h('span', { className: 'loci-dot' }) : null,
      );
    }

    // ------------------------------------------------------------ sidebar card

    function MemoryCard(props) {
      const t = props?.t ?? ((key) => key);
      const wide = props?.wide !== false;
      const open = props?.openPanel;
      const activity = useJson('/activity?limit=12', { intervalMs: 30_000 });
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

      const data = activity.data;
      const digest = data?.digest;
      // One line per entry: a fact that was added and then verified in the same
      // minute is one piece of news, not two.
      const seen = new Set();
      const shown = (data?.items ?? [])
        .filter((item) => item.action !== 'maintained')
        .filter((item) => {
          const key = item.id ?? `${item.action}-${item.ts}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 3);
      const pending = props?.pending ?? undefined;

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
          h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M4 6.5h16M4 12h16M4 17.5h10', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
            h('circle', { cx: 18.5, cy: 17.5, r: 2.2, stroke: 'currentColor', strokeWidth: 1.5 }),
          ),
        );
      }

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
        h(
          'div',
          { className: 'loci-card-head' },
          h('span', { className: 'loci-card-title' }, t('card.title')),
          h('span', { className: 'loci-card-grow' }),
          h(VersionLine, { t, update: fresh ?? update.data, onCheck: check, checking }),
        ),
        digest === undefined
          ? h('div', { className: 'loci-card-empty' }, activity.error ?? t('panel.loading'))
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'loci-card-counts' },
                h('span', { className: 'loci-count' }, h('b', null, digest.today), h('span', null, t('card.today'))),
                h('span', { className: 'loci-count' }, h('b', null, digest.week), h('span', null, t('card.week'))),
                Number.isFinite(pending) && pending > 0
                  ? h('span', { className: 'loci-count' }, h('b', null, pending), h('span', null, t('card.pending')))
                  : null,
              ),
              shown.length === 0
                ? h('div', { className: 'loci-card-empty' }, t('card.empty'))
                : h(
                    'div',
                    { className: 'loci-card-feed' },
                    shown.map((item) =>
                      h(
                        'div',
                        { key: `${item.ts}-${item.id ?? item.action}`, className: 'loci-card-line' },
                        h('em', null, t(ACTION_KEY(item.action))),
                        h('span', { title: item.title ?? '' }, item.title ?? '—'),
                        h('span', { style: { marginLeft: 'auto', flex: '0 0 auto' } }, fmtAgo(item.ts)),
                      ),
                    ),
                  ),
            ),
      );
    }

    // ---------------------------------------------------------------- panel

    function FeedTab({ t, onOpen }) {
      const { data, error, loading, reload } = useJson('/activity?limit=60', { intervalMs: 20_000 });
      const items = (data?.items ?? []).slice();
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
        data !== undefined && items.length === 0 ? h('div', { className: 'loci-muted' }, t('panel.empty')) : null,
        items.map((item, index) =>
          h(
            'div',
            { key: `${item.ts}-${item.id ?? 'x'}-${index}`, className: 'loci-row' },
            h('span', { className: 'loci-tag is-' + item.action }, t(ACTION_KEY(item.action))),
            h(
              'div',
              { className: 'loci-main' },
              h('div', { className: 'loci-name' }, item.title ?? (item.action === 'maintained' ? t('action.maintained') : '—')),
              h(
                'div',
                { className: 'loci-meta' },
                h('span', null, fmtAgo(item.ts)),
                item.kind ? h('span', null, item.kind) : null,
                item.scope ? h('span', null, item.scope) : null,
                item.revision ? h('span', null, `r${item.revision}`) : null,
                item.redacted ? h('span', null, 'redacted') : null,
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
            h('span', null, item.kind),
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
      const entry = data?.entry;
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
      const candidates = useJson('/list?status=candidate&limit=50');
      const disputed = useJson('/list?status=disputed&limit=50');
      const act = async (path, body) => {
        try {
          await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
          candidates.reload();
          disputed.reload();
          onChanged?.();
        } catch (failure) {
          window.console?.warn?.('loci: review action failed', failure);
        }
      };
      const block = (title, state) =>
        h(
          'div',
          null,
          h('div', { className: 'loci-section' }, `${title} (${state.data?.total ?? 0})`),
          state.data?.items?.length
            ? state.data.items.map((item) =>
                h(
                  'div',
                  { key: item.id, className: 'loci-row' },
                  h('span', { className: 'loci-id' }, item.id.slice(0, 10)),
                  h('div', { className: 'loci-main' }, h('div', { className: 'loci-name' }, item.title), h('div', { className: 'loci-snippet' }, item.snippet)),
                  h(
                    'div',
                    { className: 'loci-actions' },
                    h('button', { type: 'button', className: 'loci-btn is-primary', onClick: () => act('/verify', { id: item.id, status: 'verified' }) }, t('panel.verify')),
                    h('button', { type: 'button', className: 'loci-btn', onClick: () => onOpen(item.id) }, '→'),
                  ),
                ),
              )
            : h('div', { className: 'loci-muted' }, t('panel.noCandidates')),
        );
      return h('div', null, h(ErrorLine, { error: candidates.error ?? disputed.error, t }), block(t('panel.candidates'), candidates), block(t('panel.disputed'), disputed));
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
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-loci: locale dictionaries');
      const bind = ctx.locale.bind(NS);
      const t = tOf(bind);

      // The "副屏": a card beside Settings, always visible while the sidebar is.
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
