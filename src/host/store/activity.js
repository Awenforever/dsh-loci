/**
 * The activity feed behind the sidebar mirror: what changed recently, in the
 * order it changed.
 *
 * The audit log already records every write, revision, trust change and
 * deletion with ids and byte counts — but it deliberately carries no titles, so
 * it cannot be turned into a human-readable feed on its own. This module joins
 * the audit tail to the current rows and produces two views over the same
 * events:
 *
 * - `feed`    — newest first, one line per event, with the title it touched;
 * - `digest`  — the counts the compact sidebar card shows ("3 added · 1 revised").
 *
 * The join is bounded (audit tail → ids → rows), so a large store never loads
 * into memory to render a card.
 * @module dsh-loci/store/activity
 */

/** Events that belong in the "what changed" surface. */
const FEED_EVENTS = new Set(['write', 'verify', 'delete', 'import', 'maintenance']);

/** Titles are clipped here, not in the UI, so every surface agrees. */
const TITLE_CLIP = 96;

/**
 * The change a `write` audit line represents.
 * @param event - parsed audit line.
 * @returns `'added' | 'revised'`.
 */
function writeKind(event) {
  return Number(event.rev) > 1 ? 'revised' : 'added';
}

/**
 * Build the feed for one store.
 *
 * @param store - open store (`audit`, `db`).
 * @param options - `limit`, `since` (epoch ms), `auditWindow` (raw lines read).
 * @returns `{items, digest, generatedAt}`.
 */
export function buildActivity(store, options = {}) {
  const maintenance = [];
  const limit = Math.max(1, Math.min(200, options.limit ?? 40));
  const window = Math.max(limit, Math.min(2000, options.auditWindow ?? 400));
  const since = Number.isFinite(options.since) ? options.since : 0;
  const audit = store.auditTail(window);

  // Only the ids we are about to render are fetched, in one query.
  const wanted = [];
  for (const event of audit) {
    if (!FEED_EVENTS.has(event.event)) continue;
    if (typeof event.id === 'string') wanted.push(event.id);
  }
  const rows = new Map();
  if (wanted.length > 0) {
    const unique = [...new Set(wanted)].slice(-200);
    const marks = unique.map(() => '?').join(', ');
    for (const row of store.db
      .prepare(`SELECT id, title, kind, scope, scope_label, status FROM memory WHERE id IN (${marks})`)
      .all(...unique)) {
      rows.set(row.id, row);
    }
  }

  const items = [];
  for (let index = audit.length - 1; index >= 0; index -= 1) {
    const event = audit[index];
    if (!FEED_EVENTS.has(event.event)) continue;
    if (Number(event.ts) < since) continue;
    // Maintenance is a footnote, not a headline. It is included only when the
    // caller asks for it, or when there is nothing else to show — a pass that
    // reindexed or expired rows should still be visible somewhere.
    if (event.event === 'maintenance' && options.includeMaintenance !== true) {
      maintenance.push(event);
      continue;
    }
    if (items.length >= limit) break;
    const row = typeof event.id === 'string' ? rows.get(event.id) : undefined;
    const title = typeof row?.title === 'string' ? row.title : undefined;
    items.push(normalize(event, row, title));
  }
  if (items.length === 0) {
    for (const event of maintenance.slice(0, limit)) items.push(normalize(event, undefined, undefined));
  }

  return { items, digest: summarize(audit, since), generatedAt: Date.now() };
}

/**
 * Turn one audit line into one feed item.
 * @param event - audit line.
 * @param row - current row for the id, when it still exists.
 * @param title - current title, when known.
 * @returns the feed item.
 */
function normalize(event, row, title) {
  const base = {
    ts: Number(event.ts) || 0,
    id: typeof event.id === 'string' ? event.id : null,
    title: clip(title),
    kind: row?.kind ?? null,
    scope: row?.scope_label ?? row?.scope ?? null,
    status: row?.status ?? event.status ?? null,
    bytes: Number.isFinite(event.bytes) ? Number(event.bytes) : null,
  };
  switch (event.event) {
    case 'write':
      return {
        ...base,
        action: writeKind(event),
        revision: Number(event.rev) || null,
        redacted: Number(event.redactions) > 0,
        flagged: Array.isArray(event.flags) && event.flags.length > 0,
      };
    case 'verify':
      return {
        ...base,
        action: event.pinned === true ? 'pinned' : event.pinned === false ? 'unpinned' : 'verified',
        to: event.status ?? null,
        actor: event.actor ?? null,
      };
    case 'delete':
      return {
        ...base,
        action: event.mode === 'purge' ? 'purged' : event.mode === 'restore' ? 'restored' : 'deleted',
        reason: typeof event.reason === 'string' ? clip(event.reason) : null,
      };
    case 'import':
      return {
        ...base,
        action: 'imported',
        count: Number(event.count) || 1,
        source: typeof event.source === 'string' ? clip(event.source) : null,
      };
    case 'maintenance':
      return {
        ...base,
        action: 'maintained',
        // The panel renders the tag as the action name, so the title has to say
        // something different: what the pass actually did.
        title:
          [
            Number(event.expiredWorking) > 0 ? `${Number(event.expiredWorking)} expired` : null,
            Number(event.closedCandidates) > 0 ? `${Number(event.closedCandidates)} closed` : null,
            event.reindexed === true ? 'index rebuilt' : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'nothing to do',
        detail: {
          expiredWorking: Number(event.expiredWorking) || 0,
          closedCandidates: Number(event.closedCandidates) || 0,
          reindexed: event.reindexed === true,
        },
      };
    default:
      return { ...base, action: event.event };
  }
}

/**
 * Count the changes in a window, for the compact card.
 *
 * The counters are computed over the whole audit window, not over the page of
 * items that happens to be rendered: "3 today" must not depend on how many lines
 * the card asked for.
 *
 * The card shows a 24-hour and a 7-day number, which is what "did it learn
 * anything today" actually means to a user.
 * @param audit - the parsed audit tail.
 * @param since - epoch ms lower bound.
 * @returns `{today, week, total, lastAt}`.
 */
function summarize(audit, since) {
  const now = Date.now();
  const day = 86_400_000;
  let today = 0;
  let week = 0;
  let total = 0;
  let lastAt = null;
  for (const event of audit) {
    if (!FEED_EVENTS.has(event.event) || event.event === 'maintenance') continue;
    const ts = Number(event.ts);
    if (!Number.isFinite(ts) || ts < since) continue;
    total += 1;
    if (lastAt === null || ts > lastAt) lastAt = ts;
    const age = now - ts;
    if (age <= day) today += 1;
    if (age <= 7 * day) week += 1;
  }
  return { today, week, total, lastAt };
}

/**
 * Clip one line of text for a card.
 * @param value - candidate text.
 * @returns the clipped string, or null.
 */
function clip(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= TITLE_CLIP ? flat : `${flat.slice(0, TITLE_CLIP - 1)}…`;
}
