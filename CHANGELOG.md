# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0.0.

## [3.4.0] — 2026-11-15

The index-byte bar had no visible track.

### Fixed

- **The bar's track was one theme layer step**, `--dsw-alias-bg-layer-2` against a
  `--dsw-alias-bg-layer-1` card — #f1f1f4 on #ffffff, which is almost nothing. The bar read
  as a floating blue sliver: you could see how much was used and not what the whole was, which
  is the only reason a bar beats a number here. The track is now `--dsw-alias-border-l1` with
  an inset ring, and the groove is 5px so the unfilled part is legible.
- A non-zero section gets at least a 2% fill so a nearly-empty index still shows *something*
  against the groove rather than looking empty.

## [3.3.0] — 2026-11-15

R23 and R24: the card now describes *this* conversation, and the panel explains itself.

### Fixed — R23: the card showed the whole store

Commit `4065c98` recorded the intent for this surface as "what does this conversation's
agent know", scoped to this project's read set. The card read every stored scope instead,
because `sidebar.footer.action` is global chrome: it receives `{ wide }` and nothing else, so
it has no session and no cwd.

`dsh-ustc-quota` solves a similar problem with a DOM probe that finds the focused split pane.
That is a lot of fragile machinery for a summary card, and there is a better source already
in the database: **every prompt assembly records the scope key it served**
(`request_stat.scope_key`, `source = 'section'`). The scope of the most recent assembly is,
by definition, the scope the agent is reading right now.

- `store.activeScopeKeys()` derives the session/workspace/project/global set from that last
  assembly, and falls back to every stored scope when nothing has been assembled yet — with
  no history there is no "current", and saying "everything" is the honest answer.
- `/api/loci/stats` and `/api/loci/knowledge` default to it. `?all=1` keeps the admin view,
  and an explicit `?cwd=` / `?session=` still wins.

**Known limit, stated rather than hidden:** switching conversations without sending a message
leaves the card showing the previous conversation's scope, because nothing has been assembled
for the new one yet. It is a summary of what the agent was last given, which is what it says
on the tin.

### Fixed — R24: the panel did not explain itself

Five tabs, one of which said what it was for. The first complaint about the panel was
literally "I don't know how to review". Now:

- every tab opens with one line of purpose, in the same place the Feed tab already used;
- every row action carries a `title` that says what it does rather than what it is called —
  *"Approve: this entry can now be injected into the prompt"* rather than "Verify",
  *"Mark as wrong or unsafe: kept in history, never injected"* rather than "Dispute".

## [3.2.0] — 2026-11-15

The sidebar was sending people to an empty room. Found in the live store, not in a test.

### Fixed

- **"N item(s) waiting for you in Review" counted rows Review hides.** The card read
  `stats.pendingCandidates`, which counted every candidate and disputed row in scope; the
  Review tab lists only the kinds that can reach the prompt (`rule`, `semantic`,
  `procedural`). Episodic session summaries are candidates *by design* — they are history,
  not claims — so on a normal day the entire count was composed of rows Review deliberately
  excludes.

  Live evidence, after one afternoon of use: **3 pending rows, all `episodic`**, and the
  sidebar offering to review them somewhere it would not. The count is now `0` and Review
  shows `0`.

  `REVIEWABLE_KINDS` is one exported list. `countPending`, `stats.pendingCandidates`,
  `stats.disputed` and the panel's request all use it, so the badge and the list cannot drift
  apart again. `byStatus` stays complete — that is a data view, not a to-do.

- **`stats.pendingCandidates` ignored `valid_to`** while `countPending` honoured it, so a
  candidate closed by maintenance stayed in the badge. Both now exclude expired rows.

### Why this matters beyond the cosmetic

The card was telling the user to do something that could not be done, which reads as "the
tool is broken" rather than "there is nothing to do". A number with a door is a promise.

### Not fixed, recorded

Episodic summaries still accumulate as candidates and are only removed by the 30-day
candidate TTL. They are visible in the Feed tab, which is where history belongs, but nothing
says so. That is part of R24 (the panel explains almost nothing about itself).

## [3.1.0] — 2026-11-15

Four things from looking at the live sidebar and panel.

### Changed

- **The sidebar icon now has the same weight as the menu it sits in.** Native
  `sidebar.panellist` entries receive `{ size, active }`; this one used `size` correctly but
  drew inside 4–20 of a 24 viewBox with a small off-centre dot, so beside the shipped icons
  it read thinner and smaller. Redrawn as a symmetric **layers** glyph spanning 3–21 at
  stroke 1.8 — the optical weight of its neighbours, and a shape that says layered memory.

- **The panel is a readable column, not edge-to-edge text.** The scroll container's
  horizontal padding became `max(16px, calc((100% - 860px) / 2))`, so rows sit in a centred
  measure on a wide window without touching any tab component.

- **"N item(s) waiting for you in Review" is now a way in.** It was a sentence telling a
  person to go somewhere else and find the tab. It is a button: it opens the panel already
  on Review. The card and the panel mount separately, so the request travels through module
  scope and is consumed once.

- **The card says what it knows, not only how much.** Commit `4065c98` (2026-11-13) recorded
  the brief for this surface: *"not a dashboard … read the card and think 'it got that, it
  recorded that, we agreed on that'"*, with one short paragraph of what the agent
  understands in this project and pending work as one quiet line, never a number. 3.0.0
  replaced that paragraph with counters. The counters stay — they were asked for and they
  are useful — and one line of content goes back under them: a `Latest` row showing the most
  recently trusted entry, from `GET /api/loci/knowledge?limit=1`.

### Not changed

- `docs/PRIOR-ART.md` still records that the card should be scoped to **this project's read
  set** rather than every scope. It currently is not: `/stats` and `/knowledge` called
  without parameters enumerate the whole store, and the sidebar card has no access to the
  session's cwd. Scoping the card is a real open item, not something to assert.

## [3.0.1] — 2026-11-15

The 3.0.0 card was correct markup with no stylesheet, and the screenshot showed it.

### Fixed

- **The card was never styled outside the panel.** Every `.loci-*` rule lives in one CSS
  template string that only `MemoryPanel` and `SettingsSection` render as a `<style>`
  element. In the sidebar, with the panel closed, no `<style>` existed — so the card's DOM
  was right and its layout was simply absent. That is what "bare text in the sidebar"
  looked like, and it predates 3.0.0: the first screenshot showed it too. The card now
  renders the stylesheet itself, and so does its rail variant.

- **`card.pending` was defined twice.** The old value was the sentence
  `'{n} still need your review'`; 3.0.0 added a bare `'Pending'` label for the metric row,
  and the later definition won — so the card printed the sentence with an unsubstituted
  `{n}`. The sentence is now `card.pendingSentence` and the label stays `Pending`.

- **The version chip rendered as `v3. 0. 0`.** The chip used
  `ui-monospace, SFMono-Regular, Menlo, monospace`, which on Windows falls back to a
  monospace face whose period is centred in a wide advance; at 8.5px that reads as gaps
  between the digits. Measured with `getComputedStyle`: `letter-spacing: normal`,
  `word-spacing: 0`, width 25.50 — the spacing was correct, the **glyph** was not. The chip
  now inherits the UI font with tabular figures, at 9px.

### Added

- **`scripts/shot-card.mjs`** renders the sidebar card to a PNG using the stylesheet
  extracted from `client.js` and the DOM the component produces, through headless Edge. It
  cannot catch a logic mistake, only a drawing one — but a drawing mistake is exactly what
  shipped twice, and a screenshot is the only review that shows it.

### Not added

Four guard files from the previous draft (a separate client-i18n test, an English-only test,
a CSS-shape assertion and a manifest check) were collapsed into **one** test file and one
manifest assertion. Guards that outnumber the behaviour they protect get deleted by the next
person, which is worse than not having them.

### Corrected in the record

The 3.0.0 log entry said the card had been verified. It had not been looked at. The entry
above records what the screenshot showed.

## [3.0.0] — 2026-11-15

The sidebar card was not a card, and the plugin had a second language it did not need.

### Changed — the card

The screenshot that prompted this showed three plugin cards in a row: two with white
rounded shells, a status dot, a version chip and numeric rows; one — this one — as bare
text on the sidebar background, two sentences of prose and nothing clickable.

The difference was measurable, not aesthetic. `dsh-ustc-quota`'s shell carries
`box-shadow: 0 3px 12px`, `flex: 0 0 100%`, `order: 1`, `grid-column: 1 / -1`,
`border-radius: 12px` and `font-variant-numeric: tabular-nums`. This card had none of them,
so it sat in the same visual plane as the sidebar and looked like a note pasted over it.

Now:

- **Shell** — the same box model the neighbouring plugins use, so three cards in one column
  read as three cards.
- **Header** — title, a dim monospace version chip, a 5px status dot (brand / warn / error),
  and a right-aligned `updated <time>` that truncates instead of wrapping.
- **Numbers** — `Verified / Pending / Disputed` in a three-column grid, tabular figures,
  amber for pending and red for disputed.
- **Budget** — a thin bar of index bytes against `sectionMaxBytes`, turning amber past 85%.
- **Usage** — `Injected / Opened / Dead` (the last one only when non-zero), which is the row
  that makes schema v2's counters visible where a person will actually see them.
- **Empty state** — one line and one instruction instead of two sentences of apology.

This reverses the earlier "a page of notes, not a dashboard" stance *for this surface*. The
audit had already called that stance out: an aesthetic refusal to interrupt, applied to the
one place where a person must act. The panel keeps the prose; the card gets the numbers.

### Changed — one language

Chinese was not in the client because anyone chose it; the client shipped a full `ZH`
dictionary, so a browser whose locale resolved to `zh` rendered the UI in Chinese. The
English dictionary was already complete. The second dictionary was the only reason the
product had a language at all.

- `client.js`: the 128-line `ZH` dictionary is gone, the locale registration is `{ en: EN }`,
  and four Chinese comments are rewritten.
- `locale/zh.json`: deleted; `locale/en.json` is the only locale file.
- `package.json` / `manifests`: no longer advertise a second language. `README.md` loses the
  `记忆宫殿` gloss and the `更新于` label description; the Chinese *examples* of stored
  content stay, because they demonstrate CJK retrieval.
- `scripts/capture-panel.mjs`: its panel selector matched `记忆|Memory` and can only ever
  match the latter now.

Kept, deliberately: the Chinese regexes in `capture.js` (they match Chinese input) and in
`sanitize.js` (they match Chinese prompt-injection phrasings). Deleting those would disable
the features for the language most of the user's memories are written in. They are pattern
data, not output.

### Added

- `test/unit/client-i18n.test.mjs` — no Chinese in `client.js`, no `ZH` dictionary, no
  `locale/zh.json`, every `t()` key defined, and the card still has its shell/metric pieces.
- `test/unit/english-only.test.mjs` — no Chinese in emitted strings under `src/` outside a
  two-file allowlist, and the allowlisted files must still contain their patterns (a guard
  that silently allows a file would hide the deletion it exists to catch).
- `scripts/check-manifest.mjs` now **fails if `locale/zh.json` reappears**, so the language
  cannot come back in a version that never touched `client.js`.

### Still Chinese, on purpose

`README.zh.md`, `docs/*.md`, and the `titleZh`/`descriptionZh` fields in
`marketplace/entry.json` are documentation and storefront metadata, not output the plugin
emits at runtime. They were left alone rather than deleted; if they should go too, that is a
separate decision about the deliverable, not about the product's language.

## [2.11.0] — 2026-11-15

One fix, made because it is the last thing that could put another project's facts into a
conversation.

### Fixed

- **A session with no `cwd` borrowed the Host process directory as its scope.**
  `resolveScopes` fell back to `process.cwd()` whenever the host did not supply
  `session.header.cwd`. Every such session and every panel request therefore shared one
  workspace key — the directory the Host process was started in, which for a packaged
  install is the install directory. Two consequences: memories written there belonged to no
  project, and any two cwd-less sessions could read each other's entries.

  A missing cwd now yields an explicit `workspace:unresolved` / `project:unresolved`. It
  collides with no real workspace, appears in no other session's read set, and the panel
  labels it "unresolved workspace" — visible rather than quiet.

  The trade is deliberate: a cwd-less session loses access to workspace memories instead of
  being handed someone else's. That is the direction the I4′ invariant points.

### Docs

- `PRIOR-ART.md` I4′ and its expiry table said the process-cwd fallback was "a known risk,
  not a guarantee". It is now a stated behaviour with a test, and the remaining half of that
  risk (project-scope collapse past 12 ancestor directories, no `doctor` check on scope
  identity) is named as still open.

## [2.10.1] — 2026-11-15

Three more ways a scope mistake could have answered with the wrong data. Found by checking
the last unverified claims from the audit instead of trusting the previous pass.

### Fixed

- **`/api/loci/preview?cwd=…` returned 400.** The route read `resolved.readKeys` and
  `resolved.label`, neither of which `resolveScopes` returns, so any caller that supplied a
  `cwd` or `session` got `Cannot read properties of undefined (reading 'length')`. The panel
  never sends those parameters, which is why it survived: a latent failure on the one
  endpoint that answers "what does *this* conversation get". `/api/loci/knowledge` had the
  same defect.

- **An explicit empty scope set meant "the whole store".** `stats({ scopeKeys: [] })` and
  `usageReport({ scopeKeys: [] })` dropped the filter, while `list([])` and
  `countPending([])` returned nothing. That asymmetry turns a scope-resolution failure into
  a confident answer about every project on the machine. Now: omitted means the whole
  database (an admin question), `[]` means nothing.

- **`update`, `pin`, `unpin`, `restore` and `merge` ignored the read set.** Only `loci_get`
  and `loci_forget` were guarded in 2.10.0. `update` moved a foreign entry into the calling
  session's scope, `pin` changed how it sorts in another project's index, and `restore`
  could un-delete an entry a different project had removed.

### Note

`test/unit/scope-semantics.test.mjs` pins all three. The empty-versus-absent distinction is
asserted in both directions, because the failure mode is a silent widening rather than a
crash.

## [2.10.0] — 2026-11-15

The last four findings from the audit. All four are the same shape: an operation that
trusted an input it should have checked.

### Fixed

- **`snapshot --label` could write outside the memory root.** The label came from the
  command line and was joined straight into a path, so `--label ../../tmp/x` produced a
  database outside `$DSH_HOME/memory/loci/`. `SECURITY.md` said `assertInside` guarded
  every generated path; this one was not guarded. The label is now reduced to a filename
  *and* the resolved path is asserted.

- **`loci_get` and `loci_forget` ignored the scope set.** Every read in the product binds
  an explicit scope-key set except these two, which took an id and used it — so an id
  pasted from another project's chat returned that entry's body, or soft-deleted it. Both
  now refuse an entry outside the session's read set. A miss and a foreign hit answer the
  same way, so the refusal does not confirm what exists elsewhere.

- **An MCP write with no scope pooled in `session:unknown`.** `readScopeKeys(scopes, {
  scope: undefined })[0]` is the *session* key, and a facade has no session — so every MCP
  server on the machine shared that one key while no Host session ever read it. Proposals
  were invisible to the review tab. A scope-less write now lands in the workspace the
  facade is serving.

- **Capture turned ordinary sentences into verified rules.** Bare `别` matched inside
  级别, 特别, 识别, 区别 and 分别, and `要不要…？` matched the 不要 rule. Measured before
  the change: *"我特别想看 diff"*, *"两者区别不大，随便选"*, *"我们分别试了两种方案"*,
  *"识别这类错误要靠日志"*, *"这个 bug 的级别是 P1，先处理它"* — five false positives, each
  of which becomes a `verified` line in `Rules (must follow)` with the default
  `autoVerifyCaptured`. An imperative must now open a clause, and a sentence ending in `？`
  is never a statement.

  Verified against 8 negatives (all rejected) and 10 positives (all captured with the right
  kind: 以后都用…, 不要再改…, 别把密钥…, 禁止…, 必须先…, 我们的约定是…, 记住…, 发布流程是…, 以后一律…, 下次别…).

### Docs

- `DESIGN.md` said "every captured row is a `candidate`". That stopped being true when
  `autoVerifyCaptured` shipped and the sentence survived several releases; it now states the
  two doors into the prompt and what the flag controls.

## [2.9.0] — 2026-11-15

R3 was the last rule the product stated and did not keep.

### Fixed

- **The recall assist was not reproducible.** R3 requires the conditional path to evaluate
  over a reproducible snapshot: the same session replayed must produce the same result, and
  the outcome must not drift with a moving clock. `search` already accepted a `now` for its
  recency term and its time-window filter — but `renderAssistBlock` never passed one, so it
  silently took `Date.now()` and the same store ranked differently on replay. The sentence
  in the document was not a property of the code.

  `renderAssistBlock` now takes `now` and threads it through, and the caller reads the clock
  **once**: that single instant is used for the evaluation *and* for
  `recordInjection({ ts })`. Measured:

  | | Result |
  |---|---|
  | same snapshot, same `now`, twice | identical ids, identical order |
  | same snapshot, `now` pushed 400 days | same set, order swapped |

  That second row is the whole argument for passing the instant in: the dependency exists,
  so it has to be an explicit input rather than a hidden `Date.now()`.

- **The record now names its snapshot.** The `inject` audit line carries `ids`,
  `source`, and the store's `indexRev` alongside the timestamp, so "why these entries"
  is answerable after the fact instead of being asserted.

### Note

All five rules in §2.1 of `docs/PRIOR-ART.md` are now marked against the code — R1 and R2 as
written-down exceptions, R3 and R4 as enforced since 2.9.0 and 2.8.0, R5 as always true.
Two of the five were violations when the audit found them, and both were fixed rather than
re-worded.

## [2.8.0] — 2026-11-15

Two real defects, both found by measuring rather than reading: search returned nothing for
normal questions, and the one conditional injection path recorded nothing at all.

### Fixed

- **`loci_search` returned nothing for sentences.** A CJK run is matched as an FTS5 phrase,
  which requires it to appear contiguously — so one word the store had never seen zeroed the
  whole query. Measured: `回滚窗口` found the entry, `回滚窗口多久？` found nothing. People
  type sentences, so this made the tool useless for its main use.
  Two changes: the run's bigrams are also offered as individual OR terms, and admission now
  accepts a **contiguous** stretch of ≥3 characters instead of requiring the whole run.
  A 2-character stretch needs to be a non-hub token *in the title*, which keeps the original
  false positive out — `完全无关的问题` used to be admitted by an entry whose body happened to
  contain `问题`.

  Effect on `scripts/acceptance-v2.mjs`, same 30 facts, same questions, no corpus change:
  **lexical top-1 went 0/30 → 8/30, top-3 0/30 → 9/30.** The remaining 21 misses share no
  bigram at all with their target — a genuine vocabulary gap that no lexical method closes,
  which is why the index is the primary channel.

- **`recallAssist` recorded nothing.** The only conditional injection in the product wrote no
  `request_stat` row, bumped no per-entry counter, put no ids in the audit line, and did not
  even pass a session id to its own search — so the panel could not answer "why did this
  entry appear in that session", which is the project's own R4 rule. `renderAssistBlock` now
  returns `{text, ids, bytes}`, and the injection is recorded with `source: 'assist'`, its
  ids, and the usual per-entry counters. Recording failures are caught: a logging problem
  must never break the turn it is recording.

### Schema

- **v4** adds `request_stat.source` (`section` | `assist`), with the migration marking
  existing rows `section` — which is what they were, since nothing but the index wrote to
  that table before. `ALTER TABLE … DROP COLUMN` re-parses the stored statement, so the
  column's comment lives outside the `CREATE TABLE` body.

## [2.7.1] — 2026-11-15

A correction, and a decision not to ship something.

### Corrected

2.7.0's acceptance note said the index does not scale — "arm C asked for 12/12 ids, so at 200
entries the model pulls the whole store". **That was wrong, and the error was in the
experiment.** Arm C asked **12 questions about 12 different entries**; fetching 12 bodies is
the correct answer to 12 questions. Concluding "it over-fetches" from `questions == fetches`
was a mistake in the arm's design, not a property of the product.

The fair version — **one** question against many candidates:

| Arm | Candidates | Result |
|---|---|---|
| D1 | 12 titles, 1 relevant | fetched **1**, the right one |
| D2 | 40 titles, 1 relevant, plus a decoy sharing the query word | fetched **1**, the right one |
| E | 40 titles, nothing relevant | answered `NOT_IN_MEMORY`, substituted nothing |

### Not shipped, on purpose

The work item was "make the index guide the model to converge". It already converges, so no
steering text was added to the footer. Two arms tested a footer that explicitly said "do not
batch-fetch titles that merely look plausible": it changed nothing. The footer is 83 bytes on
every request, and this design's entire argument is that prompt bytes are the scarce
resource — a sentence that changes no behaviour is pure cost.

The lesson is worth more than the fix would have been: **a measurement that counts fetches
against questions must keep those two numbers independent.** `docs/ACCEPTANCE.md` now carries
the correction in place, rather than quietly deleting the wrong claim.

## [2.7.0] — 2026-11-15

The acceptance was measuring less than it claimed. This release re-runs it properly and
writes down the answer, including the part that is uncomfortable.

### The measurement

`scripts/acceptance-v2.mjs` — 30 facts, each question written so it shares **no character
bigram** with its target title (checked, not assumed). Seeded into a throwaway store, never
placed where the model could read it.

| Channel | Result |
|---|---|
| lexical search (`loci_search`) | **0/30 top-1 · 0/30 top-3 · 30 missed** |
| injected index | **30/30 present** |
| section cost | 0 entries → 0 B · 10 → 1,081 B · 30 → 2,781 B |

Three blind answer arms on 20 questions about a fictional project whose facts exist nowhere
in this repo:

| Arm | Correct | Behaviour |
|---|---|---|
| no memory | **0/20** | answered `UNKNOWN` 20/20 — abstained instead of confabulating |
| index only, titles carry the fact | **20/20** | exact values |
| index + fetch, titles are summaries | requested **12/12** ids | did not discriminate — pulled the whole index |

**What this means:** memory demonstrably changes answers (0/20 → 20/20 on identical
questions, nothing else varied). It also shows that a paraphrase with no shared vocabulary
is **invisible to lexical search — not degraded, zero** — so the index, not search, is the
channel that carries facts. And arm C is the warning: when titles are summaries, a model's
response to ambiguity is to fetch everything, which is fine at 12 entries and untenable at
200. Narrowing that is a design problem, not a formatting problem.

### Fixed

- **Two e2e checks were `record(..., true)`** — literal `pass: true`, structurally unable to
  fail. Replaced with real assertions on `lastInjection.bytes` and `listed`.
- `scripts/acceptance-v2.mjs` gives each store size its own home and asserts the seed count;
  the v1.0.0 harness created a scratch home and discarded it (`void scratch`) and called
  `seedCorpus(...).slice(count)`, which does not limit seeding.

### Docs

- `docs/ACCEPTANCE.md` rewritten into two clearly separated sections: §A the historical
  v1.0.0 record with the four defects that limited it, §B the 2.6.0 re-run. Where they
  disagree, §B wins.
- **Not measured, and stated as such**: whether the model answers correctly *inside a real
  DSH session* (the arms pasted the index into a prompt), tokens per answered question, and
  long-run queue behaviour.

## [2.6.0] — 2026-11-15

The rest of the boundary audit: three silent-wrongness bugs, and the invariants rewritten
to say what the code actually does.

### Fixed

- **The review filter was ignored.** The panel sent `kinds=rule,semantic,procedural`
  while the route read `kind`, so every session summary appeared in a queue designed to
  exclude them. The route now accepts both spellings.
- **"N items await review" could never reach zero.** `countPending` ignored `valid_to`,
  so candidates closed by maintenance stayed counted in the injected notice forever —
  a permanent nag that cost bytes and named rows no review list would show.
- **`/loci review` pointed at an operation that does not exist** (`loci_write op:"verify"`).
  Fixed by adding the door that was actually missing: **`dsh-loci verify --id <id>
  [--status disputed]`**. The tool surface still has no verify, on purpose — the model
  must never grant trust — but a terminal-only user could previously create candidates
  forever and never promote one.

### Changed

- **The invariants now state what is enforced, and when each one expires.**
  - I2 became **I2′**: no write reorders or rewrites an existing line; re-evaluation
    happens at session/day boundaries only. The old "byte-identical with no writes" was
    false — the footer carries a date, so it changed daily by design.
  - I4 became **I4′**: session reads bind an explicit key set; the panel and export
    enumerate every scope, which is an administrative view rather than a session read.
  - I1 no longer says "verified requires a human": it says the store derives status, and
    verified comes from a human action **or** a quote that is present and related.
  - R1 and R2 were rewritten because the project violated them: `recallAssist` selects by
    body text (now an explicit, bounded exception), and the pending count deliberately
    changes mid-session (now stated as an informed cost, not denied).
  - New **§0.1** gives every invariant its category (structural / contingent /
    preference), what it depends on, and the event that should trigger re-evaluation.
    §2.1 had expiry signals for the one thing the project *rejected* and none for the
    four things it *relies on*; that asymmetry is the most reusable finding of the audit.

- **PRIVACY said "two things can reach the network". It was three.** Session extraction
  sends up to 12 KB of conversation through the Host's own model service. Not a third
  party, but the count was wrong and the page now names all three. The prose test grew a
  check for the third path so the count cannot drift again.

## [2.5.0] — 2026-11-15

The rest of the boundary audit: one real hole in the trust gate, one check that could
never fail, and a number that was being read as more than it is.

### Fixed

- **A real quote could certify an unrelated claim.** The gate asked only "did the user
  say this"; it never asked "is the claim about what they said". Quoting any real
  sentence — "好的，继续吧" — was enough to launder a fabricated fact into the prompt.
  `evidenceSupports` was written for exactly this and had no caller. It is now part of
  the gate, and its threshold is **measured** rather than inherited: on Chinese text a
  legitimate paraphrase scores 0.083–0.364 and a laundered claim scores 0.000, so the
  bar is 0.05. The old 0.15 would have rejected "用户偏好中文" from "以后都用中文回复我".

- **`loci doctor`'s host row could never warn.** It printed `[ok]` for any recorded
  version, including one outside `engines.dsh`. It now compares against the declared
  range and warns when outside, degrading to `ok` (not a failure) when the range cannot
  be parsed.

### Changed

- **The acceptance numbers are qualified, not deleted.** Every measurement in
  `docs/ACCEPTANCE.md` was taken on **v1.0.0**; the tree is 2.5.0. Worse, the
  acceptance question contains the entry title verbatim (`acceptance-e2e.mjs:94`), the
  corpus fixture is readable from the agent's workspace, and there is no no-memory arm —
  so "49/50" measures lookup, not memory effect. The page now says so at the top and on
  the row itself. A re-acceptance on 2.5.x with held-out facts and a control arm is an
  open item, not something a doc edit can settle.

## [2.4.1] — 2026-11-15

Three fixes from an independent boundary audit. All three were verified by running the
code, not by reading it.

### Fixed

- **The CLI bypassed the hard-delete gate.** `scripts/cli.mjs` constructed the store
  with `live: () => true`, so every gate that reads a live value evaluated to open:
  with `allowHardDelete: false` the store refused `purge` and the command deleted
  anyway, `--allow-hard-delete` was decorative, and a comment directly above the code
  said the opposite. Measured before and after. `test/integration/cli-gate.test.mjs`
  now runs the real command line, which is the surface that broke — the store-level
  test passed throughout.

- **The panel write route accepted a caller-supplied `status`.** `POST /api/loci/write`
  forwarded `status` verbatim and defaulted it to `'verified'`, which also skipped the
  instruction-like quarantine: instruction-shaped text sent through the panel landed as
  `verified` instead of `disputed`. The field is gone; every write goes through the
  store's derivation like the rest of the system.

- **`SECURITY.md` claimed a self-test probe that did not exist.** The T2 row said "a
  self-test probe keeps this honest" and the string `self-test` appeared nowhere else
  in the repository. Rather than delete the sentence, `loci doctor` now runs the probe:
  it renders hostile text (`{{…}}`, a closing fence, a script tag, bare angle brackets)
  and fails if anything survives, and it checks that a known instruction shape is still
  detected.

### Note

The audit also found that the acceptance numbers are from **v1.0.0** while the tree is
2.4.x, and that the acceptance question contains the entry title verbatim — so the
"98% recall" figure measures lookup, not memory effect. That is a measurement problem,
not a bug, and it is not addressed in this patch; it needs a re-run, not an edit.

## [2.4.0] — 2026-11-15

Three items from `docs/PRIOR-ART.md` — the systematic pass over what the field does
better, judged against this plugin's four invariants rather than by popularity.

### Added

- **Lesson shape (`pattern` / `fix` / `prevents` / `whenCondition`)**, schema v3. A
  lesson stored as free text is unreadable six months later: you remember the rule but
  not why it exists. `prevents` is where that answer lives, and it is the one clause
  appended to the index line for `procedural` entries — a rule without its consequence
  gets ignored. Ordinary facts render byte-identically to before, and the fields never
  raise trust.

- **`conflicts` / `extends` relations.** `memory_edge` has always had a `relation`
  column but only ever held `supersedes`, so every correction was a full replacement.
  Real corrections are partial — "the rollback window is 45 minutes now, but database
  changes still get 30" contradicts one clause and confirms another. Now a caller can
  declare a weaker relation, both entries stay readable, and `loci_get` shows the link.

- **Touched files in the episodic summary.** "Where were we last time" was a question
  this project had to answer by hand. File paths are now extracted from tool-call
  arguments and recorded on the session summary, which is never injected — so it costs
  the prompt nothing and only helps `loci_search`.

### Migration

Schema v2 → v3 adds four nullable columns; no row can be lost and every existing entry
simply has no lesson shape yet. The integration test now walks the whole shipped chain
v1 → v3 rather than a single step.

### Not done, on purpose

Auto-triggered injection (`when` matching decides what gets injected) stays rejected:
it breaks prefix stability and lets memory content decide its own admission. The
condition is **stored and shown, never used to select**. Recorded with the rest of the
rejections in `docs/PRIOR-ART.md` §2.

## [2.3.1] — 2026-11-15

### Fixed

- **A corrupted line in the config schema.** `2.3.0` failed in CI at
  `.number().n .step(1)` — a patch script wrote a literal `.n` where a newline was
  meant. It passed every local gate, because `buildSchema()` only runs when
  `@deepseek-ai/schemastery` resolves, and a checkout without dependencies never
  executes that line.

### Added

- `test/unit/config-schema.test.mjs` builds the schema whenever the peer dependency
  is present, and constructs it with the shipped defaults. A broken chain, an
  out-of-range default or a wrong union member now fails a test instead of a tag.
  The corruption above was reintroduced on purpose to confirm this test catches it.

### Note

`2.3.0` was tagged but **never published** (the CI job stopped before the publish
step). This is the first version carrying the session digest.

## [2.3.0] — 2026-11-15

The last open item from the blind review, and the one a heavy daily user called the
biggest product hole: between "deterministic rules" and "ask the model every turn"
there was no middle. Per-turn extraction asks for one review decision per turn until
the queue is abandoned; rules alone miss anything stated in passing.

### Added

- **`extractMode: 'session'`** — one digest per session, run when the session ends,
  proposing at most `extractSessionMaxCandidates` (5) items. Same rules as before:
  candidates only, verbatim-quote grounding, hourly budget, timeout, silent failure.
  `'on'`/`'turn'` keep the per-turn behaviour for anyone who wants it.

- **Review groups a digest.** List rows now carry `sourceSession`, and the review tab
  shows "N proposed together" with one button to verify that batch — the shape the
  reviewer asked for, instead of five identical rows and five decisions.

### Notes

- The digest runs independently of the episodic summary, so a user can want one
  without the other, and a failing model cannot break the session release.
- The buffer is copied before the asynchronous call: releasing it at dispose must
  not race with the model reading it.

## [2.2.0] — 2026-11-15

Four reviewers of an independent blind review named the same risk: `engines.dsh`
admits the whole `>=0.2.2-rc.1 <0.3.0-0` range, but the only version ever booted was
`0.2.2-rc.1`. A range is a promise nobody tested.

### Added

- **`scripts/compat-probe.mjs`** — reads the *installed* Host out of its `app.asar`
  and asserts that every API this plugin touches still exists in the expected shape:
  the section contract (`interpolate: false`, `order`), the `tools`, `commands` and
  `connection` services with their registration calls, and the `turn/end` event.
  Run against the installed **0.2.2-rc.3**: **5/5 passed**. It is not a boot test,
  and the docs now say exactly which question it answers and which it does not.

- **The store records the Host that opened it.** `DSH_INSTALL_DIR` is read at
  activation, the version lands in `meta.host_version`, `stats` exposes it, the panel
  shows it, and `loci doctor` prints
  `[ok] host: last opened by DeepSeek Harness 0.2.2-rc.3`. Every user install now
  produces the evidence the next compatibility table needs, instead of leaving the
  answer to a range in a manifest.

- CI gained a conditional probe step: it runs where a Host is installed and prints a
  skip notice otherwise (the Host is not published to npm, so a stock runner has
  nothing to read).

### Changed

- `dshReleases` gained a `0.2.2-rc.3` row with status `api-surface-verified` — a
  deliberate third status between "verified" (booted) and "untested", so a range
  entry can never again imply more than was actually checked.

## [2.1.0] — 2026-11-15

Two findings from an independent blind review, where seven reviewers compared this
plugin against the rest of the field. Two of them caught the same false claim; the
other had the sharpest product objection, and both are addressed here.

### Fixed

- **The "no network" claim was false.** `README` and the threat-model row both said
  "no network unless `vectorMode` is http", while `updateCheck` defaulted to `true`
  and the panel's update route fetched the registry. Rather than reword the claim,
  the default is now **false**, so the sentence is true: turning the check on is one
  click, and a disabled check reads "Update check off" instead of looking like a
  dead button. `test/unit/network-claims.test.mjs` also greps the source, so a new
  `fetch` outside the two opt-in modules fails CI.

### Added

- **A pending-review line in the injected section.** Verified-only injection has an
  invisible failure mode: a fact written at midnight is absent at 9 a.m., and "never
  saved" looks exactly like "saved but gated". When — and only when — something is
  waiting, the footer now carries one line with the count and says those items are
  deliberately absent. An empty queue still costs exactly 0 bytes, and the count is
  part of the render cache key so a new candidate appears on the next request.

- **Per-entry usage counters (schema v2).** `memory_usage` records `inject_count`,
  `read_count`, `last_injected_at`, `last_read_at` per memory, so "which line spends
  prompt bytes and is never opened" becomes answerable. The panel's Stats tab lists
  that dead weight; `loci_get` records a read.

### Migration

Schema v1 → v2 adds one table. It runs through the existing migration runner: a
`VACUUM INTO` snapshot first, then one immediate transaction, then a row-count guard
over every pre-existing table. Rollback stays "restore the snapshot". This is the
first real migration this project has shipped, so `test/integration/migrate.test.mjs`
now exercises both the rehearsal step and the shipped one.

### Note

The same review found two things worth stating openly rather than burying: the
plugin is **not yet in the DSH plugin catalog** (the catalog snapshot predates its
publication), and it has been verified on `0.2.2-rc.1` only, while `engines.dsh`
admits the whole `0.2.2-rc.1 <0.3.0-0` range. Both are tracked as open work.

## [2.0.3] — 2026-11-14

### Fixed

- `dsh-loci --version` (and `-v`, and the bare `version` word) prints the version.
  It fell through to the help text before, because the version was only read for
  the store's metadata and never wired to an argument. `test/unit/cli-version.test.mjs`
  keeps it from regressing, including the "flag before command" position.

## [2.0.2] — 2026-11-14

### Fixed

- The manifest gate now checks the `bin` entry: bare relative path, target exists,
  shebang present, covered by `files`. No user-visible behaviour changed — measured
  on the published builds, `bin` was already correct in both 2.0.0 and 2.0.1
  (`node_modules/.bin/dsh-loci` is created and `npx dsh-loci help` works).

  The reason for the guard: npm rewrites a bin path that starts with `./` and prints
  `script name … was invalid and removed`, which reads like the binary was dropped.
  It was not. The value is now canonical so that warning cannot hide a real problem
  next time.

## [2.0.1] — 2026-11-14

### Changed

- **Publishing now uses Trusted Publishing (OIDC) only.** `setup-node` no longer
  receives `registry-url` and the publish step no longer reads `NODE_AUTH_TOKEN`:
  the collaboration center's npm runbook records both as `ENEEDAUTH` traps, and
  with a Trusted Publisher bound, the OIDC identity token is the credential. The
  repository therefore holds no npm secret.
- `release.yml` gained an `npm >= 11.5` check, because npm 10 never performs the
  OIDC exchange.

### Note

`2.0.0` was the bootstrap publish (npm does not allow a first publish over OIDC,
[npm/cli#8544](https://github.com/npm/cli/issues/8544)), so it carries no
attestation. **2.0.1 is the first version with a provenance attestation.**

## [2.0.0] — 2026-11-14

### Added

- **`loci doctor` now looks for near-duplicates.** Two entries that say the same
  thing split the ranking, each take an index line, and force a correction to be
  applied twice. The check reports groups with their ids and a similarity score, and
  leaves the merge to a person (the store can already do it: `loci_write op:'merge'`).

  The metric is `max(Jaccard, containment)` over character bigrams. Jaccard alone
  scores a restated Chinese title at 0.55 — under any useful threshold — because the
  two titles share most of the *shorter* one rather than most of the union. The scan
  is bounded (verified heads only, ≤2000 entries, candidate pairs from shared tags
  and title windows, report capped at 5 groups).

- `test/unit/duplicates.test.mjs`: the metric, the verified-only rule, the clean
  store, the caps, and the doctor row.

### Changed

- `publishConfig.access: "public"` is set in the manifest, so a direct `npm publish`
  cannot accidentally create a private package.

### Note

This is the last item from the audit's "ten improvements" list: rows 1–3 and 5–10
are done, and row 2's remaining gap (duplicate detection) closed here. The version
jumps to 2.0.0 because the feature set that list described is complete, not because
anything in the on-disk format broke — schemas and the tool surface are unchanged.

## [1.9.0] — 2026-11-14

### Added

- **Candidate-only background extraction** (`extractMode: 'on'`, **off by default**).
  The deterministic capture layer only records statements that announce themselves
  ("always", "never", "we agreed"). A preference stated in passing — "honestly I'd
  rather see the diff first" — carries no such marker and was lost. With the feature
  on, the recent conversation is sent to the configured model at turn end and the
  answers land as **candidates** for review.

  Four rules keep it from becoming the feature a user turns off:
  - off unless `extractMode: 'on'`, and inert when the profile has no `llm` route
    (reports `no-model`, writes nothing);
  - candidates only — an extracted preference can never reach the prompt by itself;
  - budgeted: `extractMaxCallsPerHour` (6), `extractMaxCandidates` (3),
    `extractTimeoutMs` (20 s), and a 12 KB input cap. Exhausting the budget is
    silent, not an error;
  - it can always fail: timeout, provider error, unparseable answer or an invented
    quote all return `{written: 0, reason}` on its own timer, never touching the
    turn. A quote that is not in the transcript is dropped before storage.

- `test/unit/extractor.test.mjs` covers the switch, the missing route, the budget,
  the timeout, invented quotes and the unusable-answer paths.

### Unverified

- The `ctx.llm` adapter is written against the Host's `llm.stream(request)` call and
  collects text from whatever frame shape the provider emits. **It has not been run
  against a live provider**; the unit tests use a fake completer and a fake stream.
  If a provider's chunk shape is not one of the recognised forms, the extractor
  records `model-error` and stays out of the way — it does not write junk.

## [1.8.0] — 2026-11-14

### Added

- **Import bridges** for the memory plugins a user is likely leaving
  (`dsh-loci import --from auto-memory|claude`, `POST /api/loci/import-peer`,
  `--dry-run` to preview):
  - **dsh-auto-memory**: reads one Markdown file per memory with its front matter
    (`name/title/type/disabled/evidence`). `_user/` becomes global scope, each
    `--<project>--/` directory keeps its own scope key, `type: feedback` maps to
    `procedural`, and disabled or already-superseded entries are skipped.
  - **Claude Code memory**: reads `MEMORY.md`'s links plus every topic file that
    is not in the index, so a hand-added file is not silently lost.
  - everything lands as a **candidate**: another plugin's trust level is not
    evidence here, and the source file is recorded as `sourceRef`.
  - format details were taken from the producer's own serializer, not guessed;
    `@tr1v3r/dsh-ltm` is deliberately not read (private SQLite schema) and the
    operations guide says why.

### Fixed

- A **byte-order mark** in front matter silently disabled parsing: the whole file
  became body text and the entry imported with a filename-derived title. A BOM is
  now stripped before the fence is matched, with a regression test.

## [1.7.0] — 2026-11-14

### Added

- **`sourceRef`**: a fact can cite where it lives (`src/host/store.js:120`).
  - accepted by `loci_write`, stored with the evidence (the quote and the citation
    are both provenance), returned by `loci_get` as a `source:` line, shown under
    **Source** in the panel detail, and written to the export front matter so a
    round trip keeps it;
  - flattened and capped at 160 characters like every other free-text field;
  - a citation that trips the secret scanner is dropped rather than stored;
  - it never raises trust: a model-written entry with a citation is still a
    candidate, because knowing where something is written down does not make it
    true.

## [1.6.0] — 2026-11-14

### Added

- **`merge`** (`loci_write` with `op:'merge'`, `store.merge()`, `POST /api/loci/merge`).
  Two entries that say the same thing in different words split the ranking, each
  take an index line, and force a correction to be applied twice. Write-time dedupe
  only catches byte-identical or same-title writes, so the realistic case — written
  months apart, different wording — now has an explicit operation:
  - the sources are **superseded, never deleted**: their history stays readable and
    `loci_get` keeps working;
  - tags and entities are unioned, so the merged entry keeps both entries'
    searchability;
  - an optional `expectedRevisions` list aborts the whole merge on a stale
    expectation, before anything is written;
  - a merge that changes the text re-opens verification (the target lands as a
    candidate), because trust is bound to the words that were confirmed;
  - one `merge` audit line names both sides.

## [1.5.0] — 2026-11-14

### Fixed

- **`--json doctor` printed the help text and exited 2.** Flags are now
  position-independent: `--json doctor` and `doctor --json` are the same thing.
- **`snapshots` was unreachable** — its block sat after the switch, so it never ran.
  It is a real command now, alongside a new `snapshot [--label <name>]` that writes
  one consistent `VACUUM INTO` file under `backups/`.
- **`stats` reported the current directory's scope only.** Running it from another
  directory showed "0 entries" for a store with entries in it. Diagnostics default
  to the whole store; `--session` narrows to the current scope set.
- **The audit log accepted arbitrary prose** in a delete `reason`. It is now capped
  and scanned by the same secret detector as memory bodies.
- **`assertInside` was lexical**: a symlink inside the data directory passed the
  prefix check and then wrote wherever the link pointed. It now also resolves the
  deepest existing part of the path and requires that to stay inside, with a test
  that skips on a host that cannot create symlinks.

### Changed

- CI and the release workflow install with **`npm ci`** from a committed
  `package-lock.json`.
- The release workflow refuses a tag whose commit is not an ancestor of `main`,
  publishes prereleases to the **`next`** dist-tag, and runs the coverage gate
  before publishing.
- The coverage gate now fails on **lines (<80), branches (<55) and functions
  (<70)**, and prints all three; before, only lines were checked while branches sat
  at 62%.
- CI installs the packed tarball and runs its `bin`, so a broken `files` list or
  shebang fails the build instead of a user's terminal.
- `docs/OPERATIONS.md` shows the exact way to invoke the CLI from an installed
  profile (`node <profile>/node_modules/dsh-loci/scripts/cli.mjs`), documents the
  `/loci` slash commands, and replaces the "no snapshot command" note.

## [1.4.0] — 2026-11-14

### Fixed

- **`export` then `import` imported nothing.** The exporter wrote entries under
  `<root>/markdown/<scope>/<kind>/` and a one-line summary under
  `<root>/exports/`; the importer read `exports`. The default is now the tree that
  holds the documents, and the original scope and scope key are restored from the
  front matter instead of forcing every import into `workspace:imported`.
- The CLI granted itself `allowHardDelete`; it now honours the config, with
  `--allow-hard-delete` as the explicit opt-in for one invocation.
- `cli.mjs` read the version from four hardcoded strings; it now reads
  `package.json`.

### Added

- `store.forgetAll()`: soft (or hard, with `allowHardDelete`) deletion of one scope
  or the whole store, gated by an echoed confirmation phrase, one audit line per
  entry. `POST /api/loci/forget-all` exposes it, and **Settings → Delete
  everything** asks for the phrase before running.
- `test/unit/export.test.mjs` (round trip, scope restore, path guard) and
  `test/unit/forget-all.test.mjs` (confirmation, hard-delete gate, scope limit).

## [1.3.0] — 2026-11-14

### Changed

- **A captured statement verifies itself.** With capture on by default, every
  durable-sounding sentence the user said landed in the review queue and was never
  injected — while the same words, written by the model with a quote, went straight
  through. A captured statement now passes the same quote gate as a model-supplied
  quote: if its sentence is still in the session buffer it is verified, otherwise it
  stays a candidate. Imports and session summaries never verify themselves.
- `autoVerifyCaptured` (default `true`) keeps the old behaviour for a cautious user.
- The review queue lists only the kinds that could be injected, so past-session
  summaries stop pretending to be pending decisions.

### Added

- Reject, verify-all, and a visible error line in the review queue; a failed click
  now says so instead of disappearing into `console.warn`.

## [1.2.0] — 2026-11-14

### Changed

- **The sidebar card is a page of notes, not a dashboard.** Counters ("4 today",
  "4 this week") are gone. The card now shows `更新于 <time>` over one short
  paragraph made of the few things the agent currently understands in this
  project — a consensus, a lesson, a fact — so reading it answers "did it
  actually take that in?" instead of "did the number go up?".
  Ordering is by when an entry last *became* trustworthy (`verified_at`, falling
  back to the last edit), so confirming an old entry today puts it at the top.
- The card is scoped to the current project's read set, not to every scope in the
  store: it answers "what does this conversation's agent know".
- Pending entries are mentioned as one line of text ("still need your review"),
  never as a badge count.

### Added

- `buildKnowledge` + `GET /api/loci/knowledge`: verified entries as notes, with a
  first-sentence `gist` that is withheld when it merely restates the title.
- `test/unit/knowledge.test.mjs`: notes exclude candidates, respect scope, carry
  the moment they became true, and re-order on a fresh confirmation.

## [1.1.0] — 2026-11-13

### Added

- **Sidebar mirror** (`sidebar.footer.action`): a flat card beside Settings that
  shows what memory changed today and in the last seven days, the last three
  changes as one-line entries, pending-review count, the installed version in small
  text, and an explicit "check for updates" that is the only path that touches the
  network.
- **Feed tab** in the panel: every add, revision, verification, pin, deletion,
  restore, import and maintenance pass, newest first, with the entry it touched.
- **`/api/loci/activity`**, **`/api/loci/update`**, **`/api/loci/version`** — the
  owner-only endpoints behind those two surfaces; the activity feed carries ids,
  titles and counts, never bodies.
- **Update checker** (`src/host/update.js`): six-hour cache, 4-second timeout, and
  "unavailable" on any failure instead of an error state. It never installs
  anything; upgrading stays a decision made in the plugin manager.

### Changed

- The panel opens on the **Feed** tab (was Index), because "what changed" is the
  question a user actually arrives with.
- Version text follows the ecosystem convention: `v1.1.0` at 10px in the card,
  and a quiet version line in the Stats tab.
- Removed the `build:client` script: the client half is hand-authored
  module-loader JavaScript, so there was nothing to build and the entry was broken.

### Fixed

- (pending) findings from the four independent production-readiness audits.

## [1.0.0] — 2026-11-13

First release.

### Added

- **Layered memory** with five kinds (`rule`, `semantic`, `procedural`, `episodic`,
  `working`), where `working` is never injected.
- **Bi-temporal facts**: `valid_from` / `valid_to` for event time and `recorded_at`
  for transaction time; edits append a revision and close the previous one instead
  of overwriting it. `loci_search(asOf)` answers "what was true then".
- **One injected section** (`loci:index`, order 4000, `interpolate:false`),
  byte-budgeted (default 3,584 B), stable across read-only turns, empty on an empty
  store.
- **Five tools**: `loci_write`, `loci_search`, `loci_get`, `loci_forget`,
  `loci_stats`. Search returns `total`, `hasMore` and a cursor; pagination reaches
  everything it counts.
- **Hybrid retrieval**: CJK bigram full text + entity expansion + optional vectors,
  ranked in process with a coverage admission rule (no `bm25()` scan, no prefix
  query). Measured p95 12.5 ms at 10,000 entries.
- **Trust gate**: only `verified` entries are injected; status is derived from a
  verbatim quote found in the user's live messages, never declared by the model.
- **Scope isolation**: `session` / `workspace` / `project` / `global`, explicit keys,
  `workspace` default, `global` only on request.
- **Deterministic capture**: durable statements become candidates after a completed
  turn; a session summary is written when a root agent is disposed. No background
  model call.
- **Safety**: `{{}}` neutralization, markup escaping, instruction-shape quarantine,
  credential redaction, fenced injection, audit without content.
- **Native UI**: a settings page and a four-tab sidebar panel (Index, Search,
  Review, Stats) built on the Host's slots and theme tokens, with `zh`/`en` strings.
- **Owner-only JSON API** for the panel, over the Host's exact-fetch routes.
- **Optional MCP facade** (`src/mcp/server.js`), read-only by default.
- SQLite store with WAL, busy timeout, snapshot migration and rollback, Markdown
  export/import, `dsh-loci` CLI, `/loci` command.

### Known limits

- No LLM consolidation (v1.1 candidate).
- Deterministic capture only records explicitly phrased durable statements.
- Vector search is brute-force cosine over stored embeddings.
- Plaintext at rest; no encryption beyond the OS.

[1.0.0]: https://github.com/Awenforever/dsh-loci/releases/tag/v1.0.0
