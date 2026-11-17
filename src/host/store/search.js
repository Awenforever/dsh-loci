/**
 * Hybrid retrieval: full-text + entity graph + optional vectors, ranked in
 * process.
 *
 * Why the ranking is not SQL: FTS5's `bm25()` (and any `ORDER BY` over an FTS
 * result) scores every matching row before applying LIMIT. At 10,000 entries a
 * single query cost ~900 ms — 4.5x the whole latency budget. This module
 * therefore uses FTS5 only to *find* candidates (cheap, bounded), fetches a
 * bounded set of rows, and scores them in JavaScript where the cost is
 * proportional to the candidates, not the corpus.
 *
 * Honesty contract:
 * - `total` is the size of the ranked, pageable result; pagination can deliver
 *   every row it counts.
 * - `matchedTotal` is exact when the full-text window was not filled; when it
 *   is filled the field is `null` and `partial` is true, because an exact
 *   count of a common term is the one query here that cannot be bounded.
 *   Nothing is reported as complete when it is not.
 * @module dsh-loci/store/search
 */
import { createHash } from 'node:crypto';
import { blobToVector, cosine } from './embedding.js';
import { positionOf } from './axis.js';
import { buildQueryPlan, makeSnippet, normalizeText } from './tokenize.js';

/** How many full-text candidates to pull. */
const FTS_WINDOW = 400;

/** How many recent entries to consider for the recency signal. */
const RECENT_WINDOW = 400;

/** How many ranked candidates a response can page through. */
const RANK_WINDOW = 600;

/** Most entity rows one query may expand. */
const ENTITY_WINDOW = 40;
/** Most embeddings to compare when the vector channel is doing recall rather than re-ranking. */
const MAX_VECTOR_SCAN = 5000;

/** Snippet sizes by requested detail level. */
const DETAIL_CHARS = Object.freeze({ snippet: 240, overview: 800, full: 8192 });

/** Milliseconds in a day. */
const DAY = 86_400_000;
/** MU distance at which recency credit has fallen to 1/e. Uncalibrated, like the band edges. */
const MU_RECENCY_SCALE = 50;

/**
 * Encode a pagination cursor.
 * @param state - `offset` and `hash`.
 * @returns a URL-safe token.
 */
export function encodeCursor(state) {
  return Buffer.from(JSON.stringify({ v: 1, o: state.offset, h: state.hash }), 'utf8').toString('base64url');
}

/**
 * Decode a pagination cursor.
 * @param token - token from a previous page.
 * @returns `{offset, hash}` or undefined when malformed.
 */
export function decodeCursor(token) {
  if (typeof token !== 'string' || token.length === 0) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (parsed?.v !== 1 || !Number.isSafeInteger(parsed.o) || parsed.o < 0 || typeof parsed.h !== 'string') return undefined;
    return { offset: parsed.o, hash: parsed.h };
  } catch {
    return undefined;
  }
}

/**
 * Stable hash of everything that changes the result set.
 * @param request - normalized search request.
 * @returns a hex digest.
 */
function queryHash(request) {
  const parts = [
    normalizeText(request.query),
    [...request.scopeKeys].sort().join(','),
    [...request.statuses].sort().join(','),
    [...(request.kinds ?? [])].sort().join(','),
    [...(request.tags ?? [])].sort().join(','),
    request.asOf ?? '',
  ];
  return createHash('sha1').update(parts.join('\u0000'), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The SQL predicate shared by every candidate query.
 * @param base - normalized request.
 * @param alias - table alias for `memory`.
 * @returns `{sql, params}`.
 */
function filterSql(base, alias = 'm') {
  const parts = [`${alias}.scope_key IN (${base.scopeKeys.map(() => '?').join(', ')})`];
  const params = [...base.scopeKeys];
  parts.push(`${alias}.status IN (${base.statuses.map(() => '?').join(', ')})`);
  params.push(...base.statuses);
  if (Array.isArray(base.kinds) && base.kinds.length > 0) {
    parts.push(`${alias}.kind IN (${base.kinds.map(() => '?').join(', ')})`);
    params.push(...base.kinds);
  }
  if (base.asOf !== undefined) {
    parts.push(`${alias}.valid_from <= ? AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > ?) AND ${alias}.recorded_at <= ?`);
    params.push(base.asOf, base.asOf, base.asOf);
  } else {
    parts.push(`(${alias}.valid_to IS NULL OR ${alias}.valid_to > ?)`);
    params.push(base.now);
  }
  return { sql: parts.join(' AND '), params };
}

/** One row hydrated for scoring. */
const ROW_COLUMNS =
  'm.ord, m.id, m.revision, m.kind, m.scope, m.scope_key, m.scope_label, m.title, m.body, m.tags, m.status, m.valid_from, m.valid_to, m.recorded_at, m.updated_at, m.pinned';

/**
 * Full-text candidates, in index order, bounded.
 * @returns `{rows, matchedTotal}`.
 */
function fullTextCandidates(store, base, limit) {
  const plan = base.plan;
  if (plan.match.length === 0) return { rows: [], matchedTotal: 0 };
  const filter = filterSql(base);
  const rows = store.db
    .prepare(
      `SELECT ${ROW_COLUMNS}
       FROM memory_fts
       CROSS JOIN memory m ON m.ord = memory_fts.rowid
       WHERE memory_fts MATCH ? AND ${filter.sql}
       LIMIT ?`,
    )
    .all(plan.match, ...filter.params, limit);
  // The exact match count is the one query in this module that cannot be
  // bounded: counting a common bigram's postings with the scope join cost
  // ~100 ms at 10k entries. When the window is full the honest answer is
  // "more than the window", which the caller reports as partial.
  const matchedTotal = rows.length < limit ? rows.length : null;
  return { rows, matchedTotal };
}

/**
 * Recent head rows, newest first, through the tier index.
 * @returns rows.
 */
function recentCandidates(store, base, limit) {
  const filter = filterSql(base);
  return store.db
    .prepare(`SELECT ${ROW_COLUMNS} FROM memory m WHERE ${filter.sql} ORDER BY m.created_at DESC, m.ord DESC LIMIT ?`)
    .all(...filter.params, limit);
}

/**
 * Entity-expanded candidates and their hit counts.
 * @returns `{rows, hits}` where `hits` maps id to matched-entity count.
 */
function entityCandidates(store, base) {
  const tokens = base.plan.tokens.filter((token) => token.length >= 2).slice(0, 12);
  if (tokens.length === 0) return { rows: [], hits: new Map() };
  const scopeMarks = base.scopeKeys.map(() => '?').join(', ');
  const nameMarks = tokens.map(() => 'norm_name LIKE ?').join(' OR ');
  // An entity linked to more than 5% of the store names a category, not a
  // subject. Expanding it would return the whole store and cost the aggregation
  // over every link, so it is skipped before the join.
  const total = Number(store.db.prepare('SELECT COUNT(*) AS n FROM memory_head').get()?.n ?? 0);
  const maxLinks = Math.max(50, Math.ceil(total * 0.05));
  const entities = store.db
    .prepare(
      `SELECT id FROM entity
       WHERE scope_key IN (${scopeMarks}) AND (${nameMarks}) AND link_count <= ?
       ORDER BY link_count ASC LIMIT ?`,
    )
    .all(...base.scopeKeys, ...tokens.map((token) => `%${token}%`), maxLinks, ENTITY_WINDOW);
  if (entities.length === 0) return { rows: [], hits: new Map() };
  const filter = filterSql(base);
  const entityMarks = entities.map(() => '?').join(', ');
  const links = store.db
    .prepare(
      `SELECT ${ROW_COLUMNS}, COUNT(*) AS hits
       FROM memory_entity me
       JOIN memory m ON m.ord = me.ord
       WHERE me.entity_id IN (${entityMarks}) AND ${filter.sql}
       GROUP BY m.id ORDER BY hits DESC LIMIT ?`,
    )
    .all(...entities.map((entity) => entity.id), ...filter.params, FTS_WINDOW);
  const hits = new Map();
  for (const row of links) hits.set(row.id, Number(row.hits));
  return { rows: links, hits };
}

/**
 * Cosine similarity over the stored embeddings of the candidate ids.
 * @returns `{scores: Map<id, number>, rows: []}`.
 */
async function vectorCandidates(store, base, ids) {
  const channel = base.channel;
  const scores = new Map();
  if (channel === undefined || !channel.available()) return { scores };
  const queryVector = await channel.embed([base.query]);
  if (queryVector === undefined || queryVector.length === 0) return { scores };
  const target = queryVector[0];

  // Two modes, because re-ranking and recall are different jobs.
  //
  // Given candidate ids, this re-ranks the lexically-found entries — cheap, and it improves ordering.
  // Given *no* ids, it searches every vector in scope, which is what makes the channel able to answer
  // a question that shares no words with the stored sentence. Until this fallback existed the channel
  // could only reorder lexical hits, so it could never fix the paraphrase miss it was configured for;
  // a test that asks a wordless question would have found nothing with the channel on.
  const marks = ids.map(() => '?').join(', ');
  const rows =
    ids.length === 0
      ? store.db
          .prepare(
            `SELECT e.ord, e.vec, m.id FROM embedding e JOIN memory m ON m.ord = e.ord
              JOIN memory_head h ON h.ord = m.ord
             WHERE e.model = ? AND h.status = 'verified' AND m.valid_to IS NULL
               AND m.scope_key IN (${(base.scopeKeys ?? []).map(() => '?').join(', ') || "''"})
             LIMIT ?`,
          )
          .all(channel.model, ...(base.scopeKeys ?? []), MAX_VECTOR_SCAN)
      : store.db
          .prepare(
            `SELECT e.ord, e.vec, m.id FROM embedding e JOIN memory m ON m.ord = e.ord
              WHERE e.model = ? AND m.id IN (${marks})`,
          )
          .all(channel.model, ...ids);

  for (const row of rows) {
    const score = cosine(target, blobToVector(row.vec));
    if (score >= channel.minScore) scores.set(row.id, score);
  }
  return { scores, recalled: ids.length === 0 };
}

/**
 * Score one candidate in process.
 *
 * Two different signals, because Chinese and English fail differently:
 * - **Latin/word tokens** score on partial overlap (title ×2, body ×1).
 * - **A CJK run of 3+ characters** is only admitted when *every* bigram of the
 *   run occurs, which is the cheap equivalent of the FTS phrase match. Without
 *   that rule a query like `路径断言` also admits a note that happens to
 *   contain `路径` and `断言` in unrelated clauses.
 *
 * @param row - hydrated memory row.
 * @param plan - query plan.
 * @returns `{score, runHit, coverage}`.
 */
export function lexicalDetail(row, plan) {
  const title = String(row.title ?? '').toLowerCase();
  const body = String(row.body ?? '').toLowerCase();
  const tokens = plan.tokens.filter((token) => token.length >= 2).slice(0, 12);
  const runs = (plan.runs ?? []).filter((run) => run.length >= 3);
  let score = 0;
  let matched = 0;
  for (const token of tokens) {
    if (title.includes(token)) {
      score += 2;
      matched += 1;
    } else if (body.includes(token)) {
      score += 1;
      matched += 1;
    }
  }
  let runHit = false;
  let runSpan = 0;
  let runSpanHub = true;
  let runSpanInTitle = false;
  const isHub = typeof plan.hub === 'function' ? plan.hub : () => false;
  for (const run of runs) {
    // Longest contiguous stretch of the run whose bigrams are all present. All-or-nothing
    // was the old rule, and it made a sentence with one unseen word return nothing:
    // "回滚窗口" found the entry, "回滚窗口多久？" did not, because 多久 appears in no
    // document. Requiring a *contiguous* stretch still rejects the case the old rule was
    // written for — a note that happens to contain 路径 and 断言 in unrelated clauses has
    // a longest span of 2 characters, not 4.
    let span = 0;
    let current = 0;
    let spanHub = true;
    let currentHub = true;
    let spanEnd = 0;
    for (let i = 0; i + 1 < run.length; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (title.includes(bigram) || body.includes(bigram)) {
        if (!isHub(bigram)) currentHub = false;
        current += 1;
        if (current > span) {
          span = current;
          spanHub = currentHub;
          spanEnd = i + 2;
        }
      } else {
        current = 0;
        currentHub = true;
      }
    }
    // `span` counts bigrams; a stretch of n bigrams covers n+1 characters.
    const spanChars = span === 0 ? 0 : span + 1;
    const spanText = span === 0 ? '' : run.slice(spanEnd - spanChars, spanEnd);
    // A two-character span only counts as evidence when it is a real content word *and*
    // it appears in the title. Without the title requirement, "完全无关的问题？" was
    // admitted by an entry whose body happened to contain 问题 — the query had no topic
    // overlap at all. The title is the entry's subject, so that is where weak evidence
    // has to be.
    const inTitle = spanText.length > 0 && title.includes(spanText);
    if (spanChars > runSpan) {
      runSpan = spanChars;
      runSpanHub = spanHub;
      runSpanInTitle = inTitle;
    } else if (spanChars === runSpan) {
      if (spanHub === false) runSpanHub = false;
      if (inTitle) runSpanInTitle = true;
    }
    if (spanChars === run.length) {
      runHit = true;
      score += 3;
    }
  }
  const coverage = tokens.length === 0 ? 0 : matched / tokens.length;
  return {
    score: tokens.length === 0 ? 0 : score / (tokens.length + 1),
    runHit,
    runSpan,
    runSpanHub,
    runSpanInTitle,
    coverage,
    hasRuns: runs.length > 0,
  };
}

/**
 * Run one search.
 *
 * An empty query is not an error: it means "list what you have", which is the
 * question users actually ask. That path pages through the newest entries with
 * the same `total`/`cursor` contract, so a caller does not need a second tool.
 *
 * @param store - open store.
 * @param request - `query`, `scopeKeys`, `statuses`, `kinds`, `tags`, `asOf`,
 *   `limit`, `cursor`, `detail`, `sessionId`, `scopeKey`, `channel`.
 * @returns `{total, matchedTotal, partial, returned, hasMore, cursor, channels, tookMs, hits}`.
 */
export async function search(store, request) {
  const started = Date.now();
  const limit = Math.max(1, Math.min(request.limit ?? 10, 50));
  const detail = DETAIL_CHARS[request.detail] === undefined ? 'snippet' : request.detail;
  const query = String(request.query ?? '').trim();
  if (query.length === 0) return listRecent(store, request, { limit, detail, started });

  const plan = buildQueryPlan(query, { hub: store.hubPredicate?.() });
  if (plan.match.length === 0 && plan.fallbackChars.length === 0) {
    return { total: 0, matchedTotal: 0, partial: false, returned: 0, limit, hasMore: false, cursor: null, channels: [], tookMs: 0, hits: [] };
  }
  const base = {
    query,
    scopeKeys: request.scopeKeys,
    statuses: request.statuses ?? ['verified'],
    kinds: request.kinds,
    now: request.now ?? Date.now(),
    asOf: Number.isFinite(request.asOf) ? request.asOf : undefined,
    plan,
    // Defaulted here rather than required from every caller.
    //
    // It used to be `request.channel`, and no caller passed one — so the vector channel was configured,
    // health-reported, and never once consulted. A capability that every call site forgets to enable is
    // not a capability; the store already owns the channel, so the search uses it unless told otherwise.
    channel: request.channel ?? store.embedding,
  };
  const hash = queryHash({ ...base, tags: request.tags });
  const cursor = decodeCursor(request.cursor);
  const emptyPage = { total: 0, matchedTotal: 0, partial: false, returned: 0, limit, hasMore: false, cursor: null, channels: [], tookMs: 0, hits: [] };
  if (request.cursor !== undefined && cursor === undefined) return { ...emptyPage, error: 'cursor-invalid' };
  if (cursor !== undefined && cursor.hash !== hash) return { ...emptyPage, error: 'cursor-mismatch' };
  const offset = cursor?.offset ?? 0;

  // Candidate generation. Three bounded sources; any one of them may be empty.
  // The recency sweep only runs when the full-text channel found little: when
  // it already produced a full window there is nothing left for recency to
  // rescue, and the sweep would sort the whole scope for nothing.
  const timings = {};
  let mark = Date.now();
  const fullText = fullTextCandidates(store, base, FTS_WINDOW);
  timings.fts = Date.now() - mark; mark = Date.now();
  timings.recent = 0;
  const entity = entityCandidates(store, base);
  timings.entity = Date.now() - mark; mark = Date.now();
  const byId = new Map();
  const add = (row) => {
    if (row === undefined || byId.has(row.id)) return;
    byId.set(row.id, row);
  };
  for (const row of fullText.rows) add(row);
  for (const row of entity.rows) add(row);

  const channels = [];
  if (fullText.rows.length > 0) channels.push('lexical');
  if (entity.rows.length > 0) channels.push('entity');

  // With lexical candidates this re-ranks them. With none it searches the whole scope, which is the
  // only arrangement where the channel can answer a question that shares no words with the entry.
  const vector = await vectorCandidates(store, base, [...byId.keys()]);
  timings.vector = Date.now() - mark; mark = Date.now();
  if (vector.scores.size > 0) channels.push('vector');
  if (vector.recalled === true) {
    // Hydrate what recall found, since nothing else contributed those rows.
    const found = store.db
      .prepare(
        `SELECT m.id, m.kind, m.title, m.body, m.updated_at FROM memory m
          WHERE m.id IN (${[...vector.scores.keys()].map(() => '?').join(', ')})`,
      )
      .all(...vector.scores.keys());
    for (const row of found) add(row);
  }

  const now = base.now;
  // One clock read for the whole ranking pass: reading the memory unit inside the loop would let two
  // candidates be scored against different instants.
  const muNow = store.muNow();
  // Candidate rows come from three different queries that each select their own columns, so the MU
  // stamp is fetched once here instead of being threaded through all three.
  const muTouches = new Map();
  const candidateIds = [...byId.keys()];
  if (candidateIds.length > 0) {
    const usage = store.db
      .prepare(
        `SELECT id, p_base, mu_base FROM memory_usage
          WHERE id IN (${candidateIds.map(() => '?').join(', ')})`,
      )
      .all(...candidateIds);
    for (const row of usage) muTouches.set(row.id, positionOf({ pBase: row.p_base, muBase: row.mu_base }, muNow));
  }
  const ranked = [];
  for (const row of byId.values()) {
    const lexical = lexicalDetail(row, plan);
    const entityHits = entity.hits.get(row.id) ?? 0;
    const vectorScore = vector.scores.get(row.id) ?? 0;
    // Admission: a CJK run must be fully evidenced; word-only queries need at
    // least half their tokens. Recency is a tie-breaker, never an admission
    // ticket, so a row no other signal matched does not appear just by being new.
    // Admission. When the query contains a CJK run, a contiguous stretch of at least three
  // characters in the *same* run has to appear in the entry. Three was chosen against the
  // two failure modes:
  //   - all-or-nothing (the old rule) rejected "回滚窗口多久？" for a 6-character entry
  //     match, because 多久 is in no document — so any sentence with one unfamiliar word
  //     returned nothing at all;
  //   - plain token coverage admitted notes that merely contain two of the words in
  //     different clauses, which is the false positive the run rule existed to stop.
  // A contiguous span is the middle ground: scattered words do not form one, and a real
  // entry match always does.
  // A 2-character span is admitted only when it is a real content word rather than a term
  // that appears in a sixth of the store — `hub` is the existing frequency predicate, so
  // "回滚" passes and "我们" does not. Below 20 entries every token is a non-hub, which is
  // the right answer for a small store: missing a recall is worse than one extra candidate.
  const lexicalAdmitted = lexical.hasRuns
    ? lexical.runHit || lexical.runSpan >= 3 || (lexical.runSpan === 2 && lexical.runSpanHub === false && lexical.runSpanInTitle)
    : lexical.coverage >= 0.5;
    if (!lexicalAdmitted && entityHits === 0 && vectorScore === 0) continue;
    // Distance from the habitat on the signed axis, never calendar age.
    //
    // This used to be `exp(-age / (30 * DAY))`, which made a note written yesterday and never used
    // outrank a rule in daily use written last year. "Recent" means "close to the working set", and the
    // working set is the habitat at zero — an entry at the entrance is new but not yet settled, an entry far
    // left is being forgotten, and both are further from usefulness than one sitting at zero.
    const position = muTouches.get(row.id);
    const distance = position === undefined || position === null ? Number.POSITIVE_INFINITY : Math.abs(position);
    const recency = Number.isFinite(distance) ? Math.exp(-distance / MU_RECENCY_SCALE) : 0;
    const score = lexical.score + 0.5 * Math.min(entityHits, 3) + vectorScore + 0.05 * recency;
    const hits = [];
    if (lexicalAdmitted) hits.push('lexical');
    if (entityHits > 0) hits.push('entity');
    if (vectorScore > 0) hits.push('vector');
    ranked.push({ row, score, channels: hits });
  }
  ranked.sort((a, b) => b.score - a.score || (a.row.id < b.row.id ? -1 : 1));
  timings.rank = Date.now() - mark; mark = Date.now();
  const windowed = ranked.slice(0, RANK_WINDOW);

  let page = windowed;
  if (Array.isArray(request.tags) && request.tags.length > 0) {
    const allowed = tagAllowedIds(store, base, request.tags);
    page = windowed.filter((entry) => allowed.has(entry.row.id));
  }

  const total = page.length;
  const slice = page.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  const hasMore = nextOffset < total;
  const hits = slice.map((entry) => hydrateOne(entry, detail));
  const tookMs = Date.now() - started;
  const result = {
    total,
    matchedTotal: fullText.matchedTotal,
    partial: fullText.matchedTotal === null || total < fullText.matchedTotal,
    returned: hits.length,
    limit,
    hasMore,
    cursor: hasMore ? encodeCursor({ offset: nextOffset, hash }) : null,
    channels: [...new Set(channels)],
    tookMs,
    timings,
    hits,
  };
  store.recordRecall?.({
    sessionId: request.sessionId,
    scopeKey: request.scopeKey,
    query,
    total,
    returned: hits.length,
    tookMs,
    channels: result.channels,
  });
  return result;
}

/**
 * Turn one ranked candidate into the caller-facing hit.
 * @param entry - `{row, score, channels}`.
 * @param detail - snippet/overview/full.
 * @returns the hit.
 */
function hydrateOne(entry, detail) {
  const row = entry.row;
  const body = String(row.body ?? '');
  const maxChars = DETAIL_CHARS[detail] ?? DETAIL_CHARS.snippet;
  const text = maxChars >= body.length ? body : makeSnippet(body, [], maxChars);
  return {
    id: row.id,
    revision: Number(row.revision),
    kind: row.kind,
    scope: row.scope,
    scopeKey: row.scope_key,
    scopeLabel: row.scope_label,
    title: row.title,
    status: row.status,
    snippet: text,
    truncated: maxChars < body.length,
    tags: JSON.parse(row.tags ?? '[]'),
    validFrom: Number(row.valid_from),
    validTo: row.valid_to === null ? null : Number(row.valid_to),
    recordedAt: Number(row.recorded_at),
    updatedAt: Number(row.updated_at),
    pinned: Number(row.pinned) === 1,
    score: Number(entry.score.toFixed(6)),
    channels: entry.channels,
  };
}

/**
 * Ids whose tag array contains every requested tag.
 * @returns the allowed id set.
 */
function tagAllowedIds(store, base, tags) {
  const filter = filterSql(base);
  const clauses = tags.map(() => 'EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = ?)').join(' AND ');
  const rows = store.db
    .prepare(`SELECT m.id FROM memory m WHERE ${filter.sql} AND ${clauses}`)
    .all(...filter.params, ...tags);
  return new Set(rows.map((row) => row.id));
}

/**
 * Page the newest entries, for a search with no query.
 *
 * This is what "what do you remember?" actually needs: no fabricated query
 * string, the same `total`/`cursor` contract as a real search, and the same
 * detail levels. Order is by insertion (`ord`), which is also the id order, so
 * a cursor is stable even while rows are being written.
 *
 * @param store - open store.
 * @param request - the search request.
 * @param options - `limit`, `detail`, `started`.
 * @returns a search-shaped page.
 */
function listRecent(store, request, options) {
  const { limit, detail, started } = options;
  const filter = filterSql({
    scopeKeys: request.scopeKeys,
    statuses: request.statuses ?? ['verified'],
    kinds: request.kinds,
    now: request.now ?? Date.now(),
    asOf: Number.isFinite(request.asOf) ? request.asOf : undefined,
  });
  const tagClauses =
    Array.isArray(request.tags) && request.tags.length > 0
      ? ` AND ${request.tags.map(() => 'EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = ?)').join(' AND ')}`
      : '';
  const tagParams = Array.isArray(request.tags) ? request.tags : [];
  const total = Number(
    store.db
      .prepare(`SELECT COUNT(*) AS n FROM memory m WHERE ${filter.sql}${tagClauses}`)
      .get(...filter.params, ...tagParams)?.n ?? 0,
  );
  const cursor = request.cursor === undefined ? undefined : decodeCursor(request.cursor);
  if (request.cursor !== undefined && cursor === undefined) {
    return { total: 0, matchedTotal: 0, partial: false, returned: 0, limit, hasMore: false, cursor: null, channels: [], tookMs: 0, hits: [], error: 'cursor-invalid' };
  }
  const offset = cursor?.offset ?? 0;
  const rows = store.db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM memory m WHERE ${filter.sql}${tagClauses}
       ORDER BY m.ord DESC LIMIT ? OFFSET ?`,
    )
    .all(...filter.params, ...tagParams, limit, offset);
  const hits = rows.map((row) => hydrateOne({ row, score: 0, channels: ['recent'] }, detail));
  const hasMore = offset + hits.length < total;
  const result = {
    total,
    matchedTotal: total,
    partial: false,
    returned: hits.length,
    limit,
    hasMore,
    cursor: hasMore ? encodeCursor({ offset: offset + hits.length, hash: hashForListing({ ...request, kinds: request.kinds }) }) : null,
    channels: ['recent'],
    tookMs: Date.now() - started,
    hits,
  };
  store.recordRecall?.({
    sessionId: request.sessionId,
    scopeKey: request.scopeKey,
    query: '',
    total,
    returned: hits.length,
    tookMs: result.tookMs,
    channels: ['recent'],
  });
  return result;
}

/**
 * Cursor hash for a listing (same query-shape guard as a search).
 * @param request - the listing request.
 * @returns a short digest.
 */
function hashForListing(request) {
  return queryHash({
    query: '',
    scopeKeys: request.scopeKeys,
    statuses: request.statuses ?? ['verified'],
    kinds: request.kinds,
    tags: request.tags,
    asOf: Number.isFinite(request.asOf) ? request.asOf : undefined,
  });
}
