/**
 * dsh-loci — Client half.
 *
 * A settings page and a sidebar panel over the Host's owner-only API. No
 * imports beyond the shell's React: styles use the documented `--dsw-alias-*`
 * tokens, so light/dark follows the host without a second stylesheet.
 *
 * Hand-authored in the module-loader format (`window.__ModuleLoader__.load`),
 * which is what the Host serves for `dsh.client` packages.
 */
window.__ModuleLoader__.load({
  id: 'dsh-loci',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'loci';
    const API = '/api/loci';
    const ENTRY_ID = 'dsh-loci';

    const EN = {
      'meta.title': 'Loci memory palace',
      'meta.description':
        'Layered long-term memory: the prompt holds a stable index, full text is one lookup away, and only verified facts are injected.',
      'settings.title': 'Loci',
      'settings.intro': 'Long-term memory for this agent. Changes apply immediately where marked live.',
      'settings.unavailable': 'Live editing needs the settings service. Values below are the effective configuration.',
      'settings.saved': 'saved',
      'settings.rejected': 'rejected by the host',
      'settings.failed': 'write failed',
      'settings.restart': 'applies on restart',
      'settings.budget': 'Index budget',
      'settings.budgetHint': 'bytes for the whole injected section',
      'settings.capture': 'Session capture',
      'settings.captureOff': 'off',
      'settings.captureRules': 'rules only',
      'settings.scope': 'Default scope for new facts',
      'settings.assist': 'First-turn recall assist',
      'settings.maintenance': 'Background maintenance',
      'settings.secret': 'Secrets in memory',
      'settings.secretRedact': 'redact',
      'settings.secretReject': 'refuse the write',
      'settings.vector': 'Embedding channel',
      'settings.vectorOff': 'off (lexical only)',
      'settings.vectorHttp': 'HTTP endpoint',
      'settings.diagnostics': 'Diagnostics',
      'settings.openPanel': 'Open the memory panel',
      'panel.title': 'Memory',
      'panel.index': 'Index',
      'panel.search': 'Search',
      'panel.review': 'Review',
      'panel.stats': 'Stats',
      'panel.refresh': 'Refresh',
      'panel.loading': 'Loading…',
      'panel.empty': 'Nothing here yet.',
      'panel.indexHint': 'Exactly what the model sees in its system prompt, plus the measured byte cost.',
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
      'panel.sources': 'Source',
      'panel.candidates': 'Candidates',
      'panel.disputed': 'Disputed',
      'panel.noCandidates': 'No entries waiting for review.',
      'panel.injections': 'Recent injections',
      'panel.requestBytes': 'bytes',
      'panel.store': 'Store',
      'panel.confirmDelete': 'Soft-delete this entry?',
      'panel.error': 'Request failed',
    };

    const ZH = {
      'meta.title': 'Loci 记忆宫殿',
      'meta.description':
        '分层长期记忆：提示词里只放稳定索引，全文按需一次取回；只有已核实的记忆才会被注入。',
      'settings.title': 'Loci',
      'settings.intro': '给 agent 的长期记忆。标注「即时」的改动立即生效。',
      'settings.unavailable': '当前缺少设置服务，以下显示实际生效的配置。',
      'settings.saved': '已保存',
      'settings.rejected': '宿主拒绝写入',
      'settings.failed': '写入失败',
      'settings.restart': '重启后生效',
      'settings.budget': '索引预算',
      'settings.budgetHint': '整段注入的字节上限',
      'settings.capture': '会话捕获',
      'settings.captureOff': '关闭',
      'settings.captureRules': '仅规则',
      'settings.scope': '新事实的默认作用域',
      'settings.assist': '首轮辅助召回',
      'settings.maintenance': '后台维护',
      'settings.secret': '记忆中的密钥',
      'settings.secretRedact': '脱敏',
      'settings.secretReject': '拒绝写入',
      'settings.vector': '向量通道',
      'settings.vectorOff': '关闭（仅词法）',
      'settings.vectorHttp': 'HTTP 端点',
      'settings.diagnostics': '诊断',
      'settings.openPanel': '打开记忆面板',
      'panel.title': '记忆',
      'panel.index': '索引',
      'panel.search': '检索',
      'panel.review': '待审',
      'panel.stats': '统计',
      'panel.refresh': '刷新',
      'panel.loading': '加载中…',
      'panel.empty': '这里还没有内容。',
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
      'panel.sources': '来源',
      'panel.candidates': '候选',
      'panel.disputed': '争议',
      'panel.noCandidates': '没有待审条目。',
      'panel.injections': '最近注入',
      'panel.requestBytes': '字节',
      'panel.store': '存储',
      'panel.confirmDelete': '软删除这条记忆？',
      'panel.error': '请求失败',
    };

    const CSS = `
.loci-root { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); font-size: 13px; }
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
.loci-input { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 6px 9px; font: inherit; }
.loci-row { display: flex; gap: 10px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.loci-row:last-child { border-bottom: 0; }
.loci-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); flex: 0 0 auto; }
.loci-main { min-width: 0; flex: 1 1 auto; }
.loci-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.loci-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.loci-snippet { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 3px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.loci-actions { display: flex; gap: 6px; flex: 0 0 auto; }
.loci-pill { font-size: 11px; border-radius: 999px; padding: 1px 7px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.loci-pill.is-verified { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.loci-pill.is-candidate { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.loci-pill.is-disputed { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.loci-pill.is-deleted { color: var(--dsw-alias-state-idle-primary); }
.loci-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.loci-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 8px; padding: 10px 12px; }
.loci-card b { display: block; font-size: 18px; font-weight: 600; margin-top: 2px; }
.loci-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.loci-pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px 12px; margin: 0; }
.loci-section { margin: 18px 0 8px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: .04em; }
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

    /** Fetch JSON with an abort signal; throws a readable error. */
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

    /** Subscribe to one GET endpoint. */
    function useJson(path, deps = []) {
      const [state, setState] = useState({ loading: true, data: undefined, error: undefined });
      const [nonce, setNonce] = useState(0);
      const reload = useCallback(() => setNonce((value) => value + 1), []);
      useEffect(() => {
        if (path === undefined) return undefined;
        const controller = new AbortController();
        setState((previous) => ({ ...previous, loading: true, error: undefined }));
        apiFetch(path, { signal: controller.signal })
          .then((data) => setState({ loading: false, data, error: undefined }))
          .catch((error) => {
            if (controller.signal.aborted) return;
            setState({ loading: false, data: undefined, error: String(error?.message ?? error) });
          });
        return () => controller.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [path, nonce, ...deps]);
      return { ...state, reload };
    }

    const fmtDate = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '—');
    const fmtBytes = (n) => `${Math.round(Number(n) || 0)} B`;

    function StatusPill({ status, t }) {
      return h('span', { className: `loci-pill is-${status}` }, t(`status.${status}`) === `status.${status}` ? status : t(`status.${status}`));
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

    // ------------------------------------------------------------------ panel

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
              h(
                'div',
                { className: 'loci-section' },
                t('panel.history'),
              ),
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
        hits.map((hit) =>
          h(Row, {
            key: hit.id,
            t,
            item: { ...hit, status: hit.status, total: undefined },
            onOpen,
          }),
        ),
        last?.hasMore
          ? h(
              'button',
              { type: 'button', className: 'loci-btn', disabled: loading, onClick: () => request(last.cursor) },
              t('panel.more'),
            )
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
      const block = (title, state, kind) =>
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
                    kind === 'candidate'
                      ? h('button', { type: 'button', className: 'loci-btn is-primary', onClick: () => act('/verify', { id: item.id, status: 'verified' }) }, t('panel.verify'))
                      : h('button', { type: 'button', className: 'loci-btn', onClick: () => act('/verify', { id: item.id, status: 'verified' }) }, t('panel.verify')),
                    h('button', { type: 'button', className: 'loci-btn', onClick: () => onOpen(item.id) }, '→'),
                  ),
                ),
              )
            : h('div', { className: 'loci-muted' }, t('panel.noCandidates')),
        );
      return h('div', null, h(ErrorLine, { error: candidates.error ?? disputed.error, t }), block(t('panel.candidates'), candidates, 'candidate'), block(t('panel.disputed'), disputed, 'disputed'));
    }

    function StatsTab({ t }) {
      const { data, error, loading, reload } = useJson('/stats');
      useEffect(() => {
        const timer = setInterval(reload, 15000);
        return () => clearInterval(timer);
      }, [reload]);
      if (loading && data === undefined) return h('div', { className: 'loci-muted' }, t('panel.loading'));
      const card = (label, value) => h('div', { className: 'loci-card' }, h('span', { className: 'loci-label' }, label), h('b', null, value));
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
                card('entries', data.heads ?? 0),
                card('revisions', data.revisions ?? 0),
                card(t('panel.candidates'), data.pendingCandidates ?? 0),
                card('disputed', data.disputed ?? 0),
                card('db', fmtBytes(data.dbBytes)),
                card('index rev', data.indexRev ?? 0),
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
              h(
                'div',
                null,
                (data.injections ?? []).slice(0, 20).map((row, index) =>
                  h(
                    'div',
                    { key: `${row.ts}-${index}`, className: 'loci-row' },
                    h('span', { className: 'loci-id' }, new Date(row.ts).toLocaleTimeString()),
                    h('div', { className: 'loci-main' }, h('div', { className: 'loci-name' }, `${row.sectionBytes} ${t('panel.requestBytes')}`), h('div', { className: 'loci-meta' }, `${row.listed} listed · ${row.hidden} hidden`)),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    function MemoryPanel({ t }) {
      const [tab, setTab] = useState('index');
      const [selected, setSelected] = useState(undefined);
      const [nonce, setNonce] = useState(0);
      const tabs = useMemo(
        () => [
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
              value: values.sectionMaxBytes ?? 5120,
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
              { value: 'rules', label: t('settings.captureRules') },
              { value: 'off', label: t('settings.captureOff') },
            ], values.captureMode ?? 'rules'),
          }),
          h(Field, {
            label: t('settings.assist'),
            children: select('recallAssist', [
              { value: 'off', label: t('settings.captureOff') },
              { value: 'session-start', label: 'session-start' },
            ], values.recallAssist ?? 'off'),
          }),
          h(Field, {
            label: t('settings.maintenance'),
            children: select('maintenanceMode', [
              { value: 'sweep', label: 'every 6h' },
              { value: 'off', label: t('settings.captureOff') },
            ], values.maintenanceMode ?? 'sweep'),
          }),
          h(Field, {
            label: t('settings.secret'),
            children: select('secretPolicy', [
              { value: 'redact', label: t('settings.secretRedact') },
              { value: 'reject', label: t('settings.secretReject') },
            ], values.secretPolicy ?? 'redact'),
          }),
          h(Field, {
            label: t('settings.vector'),
            children: select('vectorMode', [
              { value: 'off', label: t('settings.vectorOff') },
              { value: 'http', label: t('settings.vectorHttp') },
            ], values.vectorMode ?? 'off'),
          }),
        ),
        h(
          'div',
          { className: 'loci-section' },
          t('settings.diagnostics'),
        ),
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
            id: NS,
            order: 20,
            label: () => t('panel.title'),
            locale: NS,
          },
          PanelIcon,
        ),
      );
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: NS,
            locale: NS,
            inject: () => ({ t }),
          },
          MemoryPanel,
        ),
      );
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
