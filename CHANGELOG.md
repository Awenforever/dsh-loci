# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0.0.

## [6.1.1] — 2026-11-17

### The recall curve had an equilibrium in the wrong place

`recallBoost` was applied without a cap, so a recall from the habitat pushed an entry **right, into the
digestion zone**. That looks harmless and is not: the equilibrium of "time pushes left, recall pushes right"
sits right of the habitat, and the more often an entry is used the further right it sits.

| recalled every | equilibrium position |
|---|---|
| 5 μ  | ≈ 1630 μ — deep in the entrance |
| 50 μ | ≈ 478 μ — the digestion zone |

The entrance means *just arrived, not yet digested*. A memory injected 300 times is the most digested thing in
the store. Without the cap the axis said the opposite.

`recallDisplacement` now caps the pull at the distance to the habitat:

```
p >= 0   →  0            (nothing to rescue; use does not make an entry newer)
p <  0   →  min(|p|, max(δ_min, δ_base · e^(−|p|/scale)))
```

An entry at the habitat that is used constantly **stays at the habitat**; one that stops being used sinks from
there like everything else. Frequent use stops ageing an entry — it does not reverse it.

Consequence worth stating plainly: recall no longer overshoots into the digestion zone, so
`MEMORY-UNITS.md` §3.1's "a recalled memory must cross the digestion zone again" no longer describes the
dynamics. Nothing needs to re-digest, because nothing is pushed back in.

### Why exponential and not logarithmic

The brief said "roughly logarithmic"; the exact function is a design choice. Exponential is chosen because it
gives the cost of neglect a half-life: **every 347 μ of extra age doubles the number of recalls** needed to
bring an entry back (`scale · ln 2`). A log curve would fall slower in the middle of the axis — rescuing an
entry 1000 μ out would take ~15 recalls instead of ~25. Neither number is measurable with today's data, so the
tie is broken by interpretability, not by pretending there is a measurement.
`scripts/diag/recall-curve-compare.mjs` prints both.

### Lifecycle symbols

The flat dots are replaced by three symbols, one per lifecycle state, each derived from the store rather than
decorated:

| symbol | state | means |
|---|---|---|
| eight-point star | `new` | still right of the entrance threshold — has not finished arriving |
| four-point star | `awake` | woken within the last 150 μ (~6 h) of the store's clock |
| dim core in a breathing halo | `idle` | settled, drifting; the halo fades with age until only the core is left |

Colour stays a separate axis: **green = standing, blue = topical**. Size is still `importance`, glow and
opacity still fall with age, and the pulse still marks a recall that actually happened.

The first attempt at the stars used polygons whose waist was too wide, so a four-point and an eight-point star
both rendered as a `+`. Narrowed the four-point waist to 12% and rebuilt the eight-point as a proper
16-vertex alternating star.

### Stacking: the floating dots are gone

The previous lane assignment picked "the first lane with no close neighbour", which produced dots sitting high
with empty space underneath them — a dot in lane 3 meant three neighbours were *somewhere* near, not that
three entries were below it. Entries are now **binned into columns** and each column fills from the track up,
so a symbol's height means exactly how many entries share its neighbourhood.

### The card

- The latest title no longer has a two-line clamp. A memory title that is cut off cannot be recognised, and
  recognising it is the entire point of showing it. The card grows instead.
- It carries what kind of memory it is: an `always` / `topic` chip and the `kind`. Without them the card shows
  a memory and leaves the reader to guess whether they will ever see it again.
- The miniature axis shows **one** entry — the same memory named above — not all 45. Forty-five symbols in a
  twelve-pixel strip was a smear that competed with the text; a single symbol answers the only question the
  strip can answer: where that memory sits.

378 tests, coverage lines 91.1 / branches 71.9 / functions 86.1, READY 11/11.

## [6.1.0] — 2026-11-17

Memory can now be *looked at*. Plus a readability fix that had been hiding in plain sight.

### The memory axis

The panel's Statistics tab draws the signed axis and puts every verified entry on it. The sidebar card
carries the same thing as a miniature — no labels, no counts, just the shape.

Each visual property maps to something the store measured, and to nothing else:

| property | means |
|---|---|
| horizontal position | `p` — the axis is the model, and a second coordinate system would be a second thing to keep true |
| shape | square = standing (`applies: always` or pinned), circle = topical |
| size | `importance` — a mild cue, because that number is a guess made at write time |
| opacity | distance from the habitat in *both* directions: an entry at the entrance is not settled yet, one far left is going |
| pulse | recalled within the last 40 μ — the only genuinely live signal on the axis |

**Nothing animates that is not data.** Position changes only when the clock advances, so dots slide between
positions on refresh rather than swimming continuously. A dot that swam for its own sake would be decoration
pretending to be measurement.

### Two things the screenshot caught that the code did not

The first render put every entry on one line, and 21 of 45 entries sit within a few percent of each other at
the entrance — they merged into a single blue smear. **A picture that cannot be counted is not showing the
data**, and "everything is piled at the entrance" is itself the most useful thing this store has to say. Dots
now stack into lanes, with the track as a baseline and columns rising from it.

The tick labels were pinned at 4% / 50% / 96% while the dots were placed by an arbitrary left edge, so
"forgotten" sat wherever it happened to land. Ticks are now computed with the same mapping as the dots.

### The sidebar card was set at 9.5px

`Latest` followed by a memory title at `font-size: 9.5px` with no explicit font family. At that size Chinese
characters — which are dense enough that they need roughly 12px to be legible — blur into a grey ribbon. Now
11.5px, line-height 1.45, and an explicit stack (`Segoe UI` for Latin, `Microsoft YaHei UI` for CJK) instead
of inheriting whatever the host happened to set.

### Data

`muPositions` entries now carry `applies`, `pinned`, `importance`, `injections` and `sinceRecall` (μ elapsed
since the last recall, derived from `mu_base`), because a picture needs to say things a list cannot.

377 tests, coverage lines 91.1 / branches 71.9 / functions 86.1, READY 11/11.

## [6.0.1] — 2026-11-17

6.0.0 built the axis and left three readers pointing at the old column. This finishes the wiring.

### What 6.0.0 missed

The axis was correct and the data was correct, but the *consumers* were not all migrated:

| reader | was | now |
|---|---|---|
| `selectCore` ordering | `ORDER BY mu_touched DESC` — the deprecated column | `(p_base + mu_base) DESC`, which is position up to a query-constant offset |
| slice ordering tie-break | `muTouched` delta | the evaluated position; an entry with no anchor ranks last, not first |
| `search` recency | `exp(-(muNow − mu_touched)/scale)` | `exp(-|p|/scale)` — distance from the **habitat**, since the entrance is also far from usefulness |
| rendered line | `3 μ ago` | `+1800 μ` / `0 μ` / `−271 μ` |

The rendering change matters more than it looks. "3 μ ago" was the right summary under a model with no
places; on a signed axis a position is a *place*, and what the model needs to know is which side of the
habitat it is on — right means not yet digested, left means being compressed. A signed number says that
without a word. The footer now reads "positions are in μ, measured from the habitat at 0".

### The degraded-mode check caught it

`readiness` reported **READY 11/11** while the prompt was still printing ages, because the readiness check
tested the store's shape and the degraded-mode check tested the *rendered text* — and only the second one
noticed the footer still said "ages". The assertion is fixed, and the fact that a check failed on a wording
change is the check working: a prompt nobody reads is a prompt nobody maintains.

377 tests, coverage lines 91.0 / branches 72.0 / functions 86.1, READY 11/11.

## [6.0.0] — 2026-11-17

The axis the document described was never built. This builds it. Schema v9.

### What was wrong

`p = max(0, muNow − mu_touched)` — non-negative, no entrance, no compression region, and pointing the wrong
way: a freshly written memory sat at **0** (the habitat) while older entries drifted **right**. The document
it was meant to implement describes a signed axis where new memories land at `+R` and time pushes everything
left.

Worse, `mu_touched` was written by **three different events** — creation, injection, read — so `p` could not
tell "just remembered" from "just used". Measured: among entries never once injected, `p` ranged from 1.61 to
366.56. A dimension where the newest member of a class and an average member differ by two orders of
magnitude is not measuring that class.

### The axis

```
遗忘 ←———— − ————← 0 ←———— 修剪 ————← + ←———— 新记忆在这里落下 (+R)
```

Three moves, kept distinct:

| | |
|---|---|
| **写入** | lands at `+R`, not at the habitat |
| **时间** | −1 per μ, unconditional — this is what guarantees termination |
| **召回** | `δ(p) = max(δ_min, δ_base·e^(−|p|/scale))` — large near 0, small far away, floored so nothing becomes unreachable |

Position is **evaluated, never stored as a live value**: `p = p_base − (muNow − mu_base)`. Time costs no
writes; only a recall writes, and it writes both halves of the anchor.

### Parameters: rate-derived, and labelled as such

`R = 2000 μ · δ_base = 130 · scale = 500 · δ_min = 1`.

The first attempt used `R = 100`. At this store's measured rate of ~580 μ/day that gives a memory a working
life of **0.3 days** — shorter than the session that created it. The numbers are now derived from the rate
the store measures about itself, multiplied by lifespans a person would recognise, and `describeAxis()`
prints the implication so it can be argued with:

```
R 2000 μ (habitat in 3.4 d, forgotten in 6.9 d) · one recall rescues 105 μ (~4.3 h) · parameters rate-derived, NOT measured
```

That last clause is the point. `docs/AXIS.md` §4 says how each parameter is meant to be measured and why the
data to do it does not exist yet. Every surface that shows the axis shows this sentence with it.

### The migration needed two rules, not one

Old rows had to be given a starting position, and where they started depends on whether they were ever used —
which the old schema happened to record in `inject_count`:

| | |
|---|---|
| never injected | `p = R − distance` — it fell in at the entrance and has been drifting |
| injected ≥ 1 | `p = −distance` — its last touch was the moment it sat at the habitat |

The first version used the entrance rule for everything, and the live store came out **35 of 45 entries at the
entrance, including one injected 442 times**. A memory used hundreds of times is the most settled thing in the
store; putting it at the entrance inverted the one distinction the axis exists to make. After the correction:
entrance 21 / digesting 3 / habitat 6 / compressing 15.

**What the migration cannot recover**: how many times an entry was recalled before its last one. Only the
final stamp was kept, so the shape of the journey is gone. The new dynamics rebuild it — a needed entry climbs
back toward the habitat the next time it is recalled.

### Everything that read `p` had to change

`muPositions` now returns signed positions and **regions** (entrance / digesting / habitat / compressing /
forgotten) instead of four distance bands, and an entry with no anchor is reported as having **no position**
rather than position zero. Core selection, the doctor line, the panel, `report-production` and `journal` all
follow.

`journal`'s "sunk" list lost its wall-clock floor. That threshold was a mistake: it filtered by
`Date.now() - created_at` in a product whose entire premise is that a predetermined by calendar does not
decide anything. "Sunk" is now a position — left of the habitat, never once recalled — which is the same fact
expressed in the store's own units.

### Two bugs the rebuild exposed

- **`Number(null)` is 0**, so a naive finiteness check on the anchor accepted a missing value and placed an
  unanchored row exactly at the habitat. The presence check now comes first.
- `positionOf` returned **`-0`** for an entry exactly at the habitat, which is `Object.is`-unequal to `0` and
  made region boundaries depend on which branch produced the zero. Normalised.

### Tests

16 new tests covering the five criteria in `docs/AXIS.md` §8 — direction, entrance, recall, no abyss, and the
one that matters most: **writing and using are different places**. 377 tests, coverage lines 91.1 / branches
72.1 / functions 86.2. Readiness is now 11 checks, including that every live entry has an evaluable position.

## [5.3.1] — 2026-11-17

A view for the person who has to live with this thing.

### `dsh-loci journal`

The existing surfaces answer different questions: `stats` gives counts, the panel's Index shows what is in
scope right now. Neither answers **"what did it remember this week, and is any of it doing anything"** — the
question someone actually has.

```
最近 7 天记了什么  ·  共 36 条
  16:52  相关时才出现   插件坞先来后到用 arrived-at 毫秒时间戳判定…
  11:48  常驻          AGENTS.md 只留指针，不写案例细节或事故经过

一直在用的  ·  被放进提示词的次数
    442 次  相关时才出现   位置切换图标不要用简单的左右箭头…

沉底的  ·  写入并 verified 超过 3 天，却一次都没进过提示词

需要你处理的  ·  待审 0 条 · 隔离 1 条
```

### Two design decisions worth stating

**"Forgotten" means never shown, not never read.** `read_count` is 0 for every entry in this store, because
when the title is the whole rule there is nothing to expand — normal working state, not disuse. A journal
that reported "0 uses" for everything would be worse than none, so it reports the one hard fact instead:
*written, verified, and never once placed in front of a model*.

**A three-day floor.** Freshly written entries have not had a turn to appear in yet. Without the floor the
"forgotten" list was simply everything just remembered, which made the only honest signal here useless.

### Why it went into the CLI

Only `scripts/cli.mjs` ships in the published package. The diagnostic scripts under `scripts/diag/` are
useful to whoever has the checkout and invisible to everyone who installed the plugin — and a view nobody can
reach is not a feature. The first version of this was a standalone script; it was deleted.

### Also

The answer-eval fixture writes invented facts (`Tessera 的保留期是九个季度`) into a scope of its own. They
appeared in the journal because the query did not exclude that scope. Test data is not memory, and it has no
business in a view a person reads.

`docs/HOW-TO-LOOK.md` explains what every column means, which signals are trustworthy, and — explicitly —
which ones are not.

361 tests unchanged.

## [5.3.0] — 2026-11-17

Production readiness, as ten checks rather than an opinion. And the last unknown is closed.

### The last unknown

Whether a model would ever answer `applies` — if not, the column would have become a second `importance`:
present, sorted on, always the default. **It does.** The first real curator write after the signal existed:

```
08:03:59  m_01M7M8HGKZC98DXX32NY
  trust_source = curator        supplied.applies = true
  applies = topic
  "插件坞同侧堆叠按先来后到，不按 id 排序，也不固定让词元额度置顶"
```

One sample, and it is right: a specific stacking behaviour is topical. One sample is also not a rate — the
honest statement is "the path works", not "35% of entries will be standing".

### The check script found two things the code did not

`scripts/diag/readiness.mjs` runs ten checks and refuses to say READY unless all pass. It immediately caught:

**1. The echo quarantine did not quarantine.** An entry written at 13:56 carried
`flags: ["index-echo"]` **and status `verified`**: the detector fired, the enforcement was never written,
and the feedback loop continued with a label on it. `#resolveStatus` now returns `disputed` for an echo
**before** it considers an explicit `verified`, because the caller claiming verified is exactly the case that
cannot be trusted — the extractor believed it had found a rule. The legacy row has been quarantined too, so
the store matches the rule it now enforces.

**2. A check counted deleted rows as live defects.** Three withdrawn echoes still carried the old `MU`
marker, so the check reported a historical artefact as a current one. A readiness check has to describe the
store as it is used, not as it once was.

### And a systemic misread in my own diagnostics

`index.js` records `written: <count>` — a **number**. Three of my diagnostic scripts read it as an array,
so `Array.isArray(...).length` was always 0 and they reported **"curation has never written anything, 0.0%
before and after"**. The corrected numbers:

```
before  ran 45 · wrote 14 · entries 29
after   ran 14 · wrote  5 · entries  8
write rate 31.1% → 35.7%
```

`report-production.mjs` had this right all along (`Number(event.written ?? 0)`), which is why the production
report and the ad-hoc script disagreed. The ad-hoc script was wrong.

> The pattern worth naming: I produced three confident conclusions this session from instruments I had not
> calibrated — a zero standing count from a wrong denominator, a zero write rate from a wrong type, and a
> behaviour claim from an absent field. **Each was caught by checking the instrument against a second
> source**, and none by re-reading the conclusion.

### The ten checks

Version · schema · applies values · no echoes · μ not MU · core membership · audit readable · **degraded
mode** · **rollback** · test gates.

The two that mattered most:

- **degraded mode**: with nothing standing, the section still renders (264 B, names its scope, points at
  `loci_search`, explains μ) and retrieval answered 4/4. This is why readiness does **not** depend on any
  model answering `applies` — not filling it degrades to pure retrieval, which is a working product.
- **rollback**: v8 → v7 → v8 on a copy, with the cost stated (classification is lost, content is not).

`node scripts/diag/readiness.mjs` prints READY only when all ten pass.

361 tests, coverage lines 90.8 / branches 72.0 / functions 85.9.

## [5.2.3] — 2026-11-17

A deployment that cannot be reverted is not ready. The rollback was never tested, and it was wrong.

### What testing it found

`scripts/diag/rollback-check.mjs` runs on a **copy** of the live database and asks two questions: can an
older client still read a v8 store, and is the v7→v8 migration reversible.

The first answer is good: SQLite ignores columns it does not know, so 5.1.x reads a v8 database fine. The
cost of that route is behavioural — the old core admits every `rule` again — but **no data is lost**.

The second answer was **wrong in the runbook before it was written**. The obvious sequence:

```sql
ALTER TABLE memory DROP COLUMN applies;   -- fails: index ix_memory_applies references it
```

fails, and the failure **leaves the column in place**, so the next attempt reports `duplicate column name`
and the database is stranded between two shapes. Index first, then column:

```sql
DROP INDEX IF EXISTS ix_memory_applies;
ALTER TABLE memory DROP COLUMN applies;
```

### And a cost that has to be stated, not discovered later

Re-applying the migration afterwards restores the column and fills it with `topic` — **the four standing
verdicts are gone**, because rollback dropped the column that held them. Content is lossless; judgement is
not.

Both paths are now in `docs/PRODUCTION.md` §6.1 with that trade written down, because the failure mode of a
runbook is that the dangerous step is the one nobody rehearsed.

### The other thing this round established

**No write has yet passed through the `supplied` signal.** 115 writes exist, all from before 5.2.2 shipped,
so nothing in the store describes whether a model actually answers `applies`. A diagnostic script of mine
inferred model behaviour from that absence and printed a conclusion; it now says it cannot answer. That is
the third time this pattern appeared in two releases, and the correction is the same each time: **say what
the data shows, and say what it does not.**

359 tests unchanged; this release is documentation and the verification script.

## [5.2.2] — 2026-11-17

A field nobody can audit is a field nobody can trust.

### The gap

Three curator writes landed after 5.2.0, all `topic`, all `importance 3`. Reading the store, that is
indistinguishable from two opposite situations:

- the curator judged them topical and was right (they *are* specific UI details), or
- the curator never mentioned the field and the default applied.

`applies` exists precisely to be filled in, so "is anyone filling it" is the first question to ask of it —
and the store could not answer. This is the same shape as `importance` sitting at 3 for eleven releases
while looking like a working sort key.

### Fixed

Both write paths now record **whether the caller supplied the field**, not only what it resolved to:

```json
"supplied": { "applies": true, "importance": false, "whenCondition": false }
```

The distinction costs three booleans and makes the column auditable. It also makes silence visible: a run
where nothing is ever supplied now says so plainly instead of looking like a considered verdict on every
entry.

### A diagnosis that had to correct itself

`scripts/diag/curate-raw.mjs` first read the absence of `supplied` as `false` and printed "at least one write
supplied a verdict" — the exact opposite of the truth. The three writes predate the signal; their field is
absent, not false. **Reading a gap as a fact is the failure mode this whole release is about**, so the
script now distinguishes the three cases explicitly and says when it cannot answer.

### The arity question, restated

`applies` has two values because `scope` already supplies the third: all 22 topical entries sit in a narrow
scope and none is global, so `scope=workspace` + `applies=always` **is** "every task in this project". That
conclusion is conditional, and the condition is stated in `docs/MEMORY-CONTRACT.md` §6 — a third value
becomes necessary the day an entry must be project-wide while living in `global` scope.

359 tests, coverage lines 90.7 / branches 71.8 / functions 85.9.

## [5.2.1] — 2026-11-17

Feedback rides on the write, because a model does not go looking for the health of its own memory.

### The constraint that shaped it

It reads tool results and nothing else. A "memory health" report nobody opens is worth nothing, so every
note has to arrive attached to an action the model was going to take anyway — **writing**.

Three notes, each computable by the store and actionable in the same turn:

| note | computed from | what the model can do |
|---|---|---|
| "N of your M recent writes have never been injected" | `inject_count = 0` on this session's own writes | check whether the scope is one it reads from |
| "N entries are waiting for review and never reach the prompt" | `status = 'candidate'` in scope | stop believing it saved something usable |
| "N of M entries are marked always — far more than that should mean" | ratio of `always` in scope | reclassify; this is the failure §7 of the contract names |

**Deliberately absent:** anything about whether an entry was *useful*. That needs the outcome of a task,
which the store never sees; claiming it would be fabrication. Also absent: anything longer than a line — a
note that needs a paragraph gets skimmed, and a skimmed note costs bytes on every write to no effect.

### A bug the tests found, not the code

The review-queue query read `scope_key` from `memory_head`, which has only `id / ord / revision / status`.
It threw, the `catch` swallowed it, and the note silently never appeared. The catch is correct — a diagnostic
must never be the cause of a failed write — but it also meant a wrong query was indistinguishable from a
quiet store. **A test caught it.** That is the trade a swallow makes, and it is worth naming.

### The `applies` arity question, answered by structure rather than by opinion

Asked whether two values are enough, or whether `project` ("every task in this project, not elsewhere") is
missing. Measured on the live store:

```
topical entries already confined to a narrow scope: 22 of 22
topical entries in a global scope:                  0
```

`scope` already ranges over session / workspace / global, so `scope=workspace` + `applies=always` **is** that
middle. A third `applies` value would be the same statement written into a second field, and two fields
describing one thing is how they drift apart.

**That is a conditional conclusion, and the condition is testable**: a third value becomes necessary the day
an entry must be "every task in this project" while living in `global` scope. None exists today.

### The split, verified against a live session

Same session, before and after 5.2.0:

```
before  160 renders · 11 distinct entries   (one rule shown 442 times in total)
after     4 renders ·  4 distinct entries   ← exactly the four standing ones, that rule now 0
```

Zero is also what "the rule was lost" looks like, so it was falsified: asked questions that concern it —

```
"把位置切换的图标换成齿轮"            FOUND
"位置切换那个图标不好看，换一个"       FOUND
"左上角那个切换按钮的图标想改一下"     FOUND
"icon for the position toggle…"     MISSED   ← known: CJK bigram matching, no cross-language
unrelated questions                  3/3 clean
```

Out of the core, back when the subject comes up. 358 tests, coverage lines 90.7 / branches 71.8 / functions 85.9.

## [5.2.0] — 2026-11-17

The write contract can now say when a memory applies. Schema v8.

### The question that started it

A rule about the position-toggle icon was injected **397 times** into a session that was rarely touching
icon placement. The cause was not a bad sort: `loci_write` had **no parameter for when a memory applies**.
`importance` had a column, a sort key and no caller — all 29 entries sat at the default `3` — so ordering
fell through to `mu_touched`, which `recordInjection` resets on every render. Whichever six rules entered
the core first stayed there forever.

### `applies: 'always' | 'topic'`

One question decides it: **does the thing this entry is about appear in every task?**

`always` is about how work is done — "AGENTS.md keeps only pointers", "look at the result before declaring
it done". `topic` is about one thing — "the grid card shows only flow deviation", "the toggle icon must not
be plain arrows". A firm constraint on one screen is still topical: the constraint is firm, its subject is
not always present.

**The default is `topic`**, and the v7→v8 migration applies it to every existing row. That is the
conservative reading: we never asked whether a stored rule is standing, so the honest answer is "not
proven", and unproven means it goes through retrieval. Backfilling `always` would have preserved the exact
behaviour this release exists to end.

### What it did to the live store

```
before   6 rules injected every turn, one of them 397 times, section 678 B
after    4 standing rules, section 823 B, the other 28 reachable by retrieval
```

The migration also surfaced that one rule existed as **three separate entries** — same rule, three
phrasings, written independently by the extractor and the curator — which are now folded into one.

### `importance` finally has an entry point — and an honest description

It is the model's own judgement, **allowed to be wrong**, revised later from what happens to the entry. The
first draft asked for "the cost of getting it wrong", which nobody can know at write time and which
produced a table of identical values. The correction machinery is **not implemented yet** — see below.

### `whenCondition` is finally shown

Stored since v3, displayed on none. A conditional fact rendered as an unconditional title is worse than not
injecting it: the model reasons from a premise it cannot see. Injected lines now carry `· when: <premise>`,
truncated at 60 characters.

This came directly from the operator: *"VM 是运行在 invictus 上的，所以只要 invictus 可达，VM 就可达，不是
单纯的 always 就能判定的"* — which also established that `applies` (when to show) and `whenCondition`
(when it is true) are different axes and must not be collapsed.

### `CORE_BUDGET_BYTES` demoted from constraint to safety valve (500 → 1500)

Its origin was `b561bfc`: a "hard 500 B cap" introduced because a first version admitted every semantic
entry and filled the core with filler. **It was a patch over a question, not a measurement** — and once
`applies` answered the question, the cap's only remaining effect was to silently overrule
`CORE_MAX_ENTRIES`. Four standing entries need 558 B, so the cap was deciding that three of four would be
shown, using a number nobody measured.

`CORE_MAX_ENTRIES` (6) is now the governing constraint. **But 6 is not measured either** — see the
`docs/MEMORY-CONTRACT.md` §3.2 note on why the obvious statistic is circular.

### Not implemented, and why

- **Automatic `importance` correction.** The planned signals are not there: `read_count` is 0/39 (titles are
  self-contained, so nothing is opened), and the five entries with `revision > 1` are all my own `applies`
  migration, not corrections. Designing a formula over absent data is how `read_count` was misread before.
- **Write-time feedback.** Planned for the next release.

### Tests

`docs/MEMORY-CONTRACT.md` is the design of record. Nine tests pin the new contract — including that an
empty core is a correct result that must not be filled with topical filler, and that a topical rule is still
reachable through retrieval. 351 tests, coverage lines 90.7 / branches 71.8 / functions 85.7.

## [5.1.5] — 2026-11-17

The 5.1.3 fix covered one path. There were two.

### What happened

An entry whose title was a rendered index line appeared at **13:08**, forty minutes *after* 5.1.3 shipped
with the fix. So the fix did not work, and the clean-up I ran was treating a symptom.

### Why

`withRecallMessage` appends the recall block as its **own user message**, tagged `source: { kind: 'user' }`
— indistinguishable from what a person typed. Two consumers read user messages:

| consumer | filter | fixed in |
|---|---|---|
| curator transcript | `session/event` → `transcripts` map | 5.1.3 |
| rule extraction | `capture.onSessionEvent` → `source.kind === 'user'` | **5.1.5** |

I fixed the first and assumed the second went through it. It did not. This is the third time in this project
that one filter served two consumers and the fix reached only one of them — the same shape as the
"two ages for one entry" bug in 5.0.2 and the "two render paths for μ" bug in 5.1.3.

### Fixed

`capture.onSessionEvent` strips the block before buffering, and a message that was *only* the block records
nothing at all. A person asking *about* the tag (`为什么提示里会出现 <loci-context> 这个标签？`) keeps their
question, because the strip is anchored on the tag, not on the word.

### The question that started this

Asked why one rule — *位置切换图标不要用简单的左右箭头* — was injected **397 times** into a session that
was rarely touching icon placement. The answer is in `docs/REAL-TRAFFIC.md` §7 and it is not about that
entry: the core takes every `kind='rule'` in scope and keeps six, all candidates share `importance 3` and
`pinned 0` across the whole store, so ordering falls through to `mu_touched` — which every injection resets.
Whichever six enter first stay, and in that session there were only **seven** candidates, so six of seven
were shown every turn regardless of topic.

336 tests, coverage lines 90.5 / branches 71.4 / functions 85.7.

## [5.1.4] — 2026-11-17

R18 has its first numbers. They came with a warning attached.

### The measurement

Two runs against the live store and the real model route:

```
questions 1   without memory: correct 0 · wrong 1    with memory: correct 1 · wrong 0
questions 2   without memory: correct 0 · wrong 2    with memory: correct 2 · wrong 0
```

Every question the model could not answer alone, it answered correctly once the memory block was present.
Prompt cost: **+318 B** for one question, **+637 B** for two. Measured tokens, from the `usage` chunk that
5.1.2 started reading: **142 in / 91 out** for the first run.

### The warning: the model invents answers

The first run's controls — two questions whose facts **do not exist** — came back **invented 2 · abstained
0**. Asked about a project that was never mentioned, the model produced a confident number rather than
admitting it did not know.

That does not invalidate the with/without difference, which is grounded in a specific fabricated token
(`四十七分钟`). It does mean the *without* score is partly a measure of confident guessing rather than of
ignorance, and the report now says so above the score.

It also explains why the second run's `invented 0` must not be read as an improvement: the budget ran out
before the controls ran. Which was the next bug.

### Controls now run first

They were last, so a short budget dropped them silently — and a report without them invites exactly the
wrong reading, because a model that fabricates scores the same on the fixture as one that does not. Two
short calls, taken off the top.

### Budgets sized to the work

Measured cost on this Host is 30–40 s per call. Six calls (two controls, two questions twice) do not fit in
150 s, which is why the first multi-question run ended with `1 incomplete`. Total budget is now 240 s, the
tool timeout 300 s, and the default two questions. The framework timeout only stops *waiting*; the work has
to finish inside it.

### A missing usage chunk is not a zero

`tokens: ... 0 in / 0 out without` read as "the calls without memory were free", when the truth was that no
usage chunk arrived for them. The report now counts reported versus scored calls and prints `not reported`
with the estimate beside it.

334 tests, coverage lines 90.5 / branches 71.4 / functions 85.7.

## [5.1.3] — 2026-11-17

Renaming a unit found a bug that had been quietly writing memory about memory.

### μ, not MU

The memory unit is a unit, so it should be written like one: **μ**, one character, the way `s` and `kg` are.
`3 μ ago` and `3 MU ago` are both 10 bytes — μ is two bytes in UTF-8 — but μ is one character fewer, and it
reads as a symbol rather than an abbreviation of two words.

Identifiers, config keys and columns stay ASCII (`mu_now`, `mu_touched`, `muRetireAfter`); only what a person
or a model reads changed. That includes the `μ ago` marker the slice uses to decide whether to explain
itself, the doctor line, the panel, and the three shipped documents. `CHANGELOG` keeps `MU` where it always
said `MU`: rewriting a historical entry would be editing the record.

### What the rename uncovered

Chasing a stray ASCII `MU` through the rendered prompt led to a memory whose own **title** was:

```
- m_01M7JM0DEWP9313M0EWX · rule · 3.5 MU ago · 所以 agent 自身无法拼出有效 URL…
```

The plugin's injected block is prepended to the user message during `agent/pre-step`, and the session log is
written *after* that. Everything downstream — the curator's transcript, rule extraction — treated that
message as what the person said, so index lines were re-extracted as memory. In the live store this had
produced **five entries**, one of them quoting another, so the loop had already run twice and each round
made the next block bigger. Nothing failed; the store simply filled with memory about memory.

Three layers now, because one would have been a single point of failure:

1. **`stripInjected`** where a user message enters the transcript — the block comes off before anything reads
   it. Handles an unclosed fence too, since a truncated frame is the same bug in a rarer shape.
2. **`looksLikeIndexLine`** at the storage boundary — if a format change loses the wrapper, an entry id
   followed by the `· <kind> · <n> μ ago ·` separators is still a shape no person types. Entries carrying it
   are flagged `index-echo`.
3. **The live store was cleaned**: five echoes soft-deleted after a dry run showed the three originals they
   quoted were intact. `scripts/diag/index-echo-cleanup.mjs` does this and refuses to run without `--apply`.

Both functions live in `src/host/inject/fence.js` — a module with no imports of its own — because
`sanitize.js` and `compose.js` already depend on each other in one direction and putting the strip in either
would have made a cycle.

### A note on how this was found

Not by testing. By looking at what the renderer actually emitted, in bytes, because PowerShell's console
displays μ as a lookalike glyph and "it looks right" is not evidence. The rename was cosmetic; the bug it
surfaced was not.

333 tests, coverage lines 90.6 / branches 71.3 / functions 85.7.

## [5.1.2] — 2026-11-17

The timeout was still not real, and the token cost was available all along.

### 5.1.1 did not fix it

`AbortSignal.timeout` was passed to `llm.stream` and the tool still hung for another half hour. Reading the
service contract explains why: `GenerateOptions` does declare `signal`, but cancellation surfaces as a
terminal `aborted` **chunk**, not a rejection — and an adapter that ignores the signal leaves `for await`
waiting forever. A bound that depends on the other side cooperating is not a bound.

Fixed by **racing** the call against its own deadline. The abandoned request may still run to completion
inside the Host; that cost is real and is stated in the source rather than hidden.

### The usage chunk was being dropped

The same contract shows `StreamChunk` includes `{ type: 'usage', usage: TokenUsage }` with `inputTokens`,
`outputTokens`, `cacheReadTokens` and more. The streaming loop read text and discarded it, which is why cost
could only ever be *estimated* when a real number was going past unread.

- `complete({ ..., onUsage })` now reports the usage chunk when an adapter sends one.
- The report separates **measured** from **estimated** tokens and says which it is. An estimate presented as
  a measurement is a fabricated number, and this project has been careful about that distinction everywhere
  except here.

### Deployment note

`remove_bundle` failed three times this round for reasons unrelated to the plugin — first a
`minimumReleaseAge` violation from a version another session had bumped, then repeated GitHub tarball
failures — and each time it had already removed the registration. The package was synced into
`node_modules` by hand and verified file-by-file against the published tarball (`deploy-integrity.mjs`:
identical). This is a known limitation of a shared profile, now recorded in the runbook.

326 tests, coverage lines 90.5 / branches 71.1 / functions 85.6.

## [5.1.1] — 2026-11-17

The tool ran for thirty minutes because a timeout did not cancel anything.

### What happened

`loci_answer_eval` was called for the first time. The tool framework reported a timeout after 180 seconds;
the work kept going for half an hour afterwards, and the person watching the UI saw a step that never ended.

### Why

Two independent mistakes, and only the second was mine to notice:

1. **`timeoutMs` on a tool stops waiting for the handler — it does not cancel an in-flight model request.**
   Nothing in the framework promises otherwise, but I had written the tool as though it did.
2. **Every `complete()` call was unbounded.** Twelve calls, each able to take as long as the model wished,
   with no signal to abort them. `createCompleter` accepted a `signal` at construction, which is useless for
   a fan-out: the tool needs a bound per call.

### Fixed

- **`complete({ ..., signal })`** now takes a per-call signal. The construction-time signal still works; a
  call-level one overrides it.
- **Every call is bounded** by `AbortSignal.timeout(perCallTimeoutMs)`, default 60 s.
- **The whole run is bounded** by a deadline, default 150 s, and stops asking once it is reached.
- **An unfinished call is reported as `incomplete`, not scored as wrong.** Counting a timeout as a wrong
  answer would make a slow model look like a bad one, which is exactly the confusion this tool exists to
  avoid.
- **Three questions by default**, not five: eight bounded calls fit inside the budget where twelve did not.

### A test that failed for a real reason

The first version of the regression test passed `totalBudgetMs: 400` against an internal floor of one
second, so `complete` was never called and the test proved nothing. It now asserts the model *was* asked,
so that the timeout is demonstrably what ended it.

324 tests, coverage lines 90.5 / branches 71.1 / functions 85.7.

## [5.1.0] — 2026-11-17

The product claim, measured. And the clock's first real-world proof.

### `loci_answer_eval` — does memory make answers better?

Every release so far measured whether the right line *reached the prompt*. That is not the claim. The
claim is that a person gets a better answer, and it had never been tested.

A script cannot test it: the model route lives inside the Host and no API key is visible to a child
process. So it is a tool.

- A fixed fixture of **invented facts** — `Zephyr-7 的回滚窗口是四十七分钟`, `Nimbus 的负责人是
  Halvorsen 团队` — that no model could know, so a correct answer can only come from the injected block.
- Each question asked twice, identical wording: alone, then with the exact block the plugin would inject.
- Grading is **mechanical** (does the answer contain the fact's token) because a model graded by a model
  measures the grader.
- **Two control questions have no stored fact.** A confident answer there is an invention, not a win, and
  the report says so above the score.
- Cost is reported in **bytes plus a labelled estimate** — the stream carries text frames only, so there
  is no usage field to read and a "measured" token count would be fabricated.

The render puts the with/without difference first, cost beside it so a gain can never be reported without
its price, and the controls below.

### 冻结性：第一个真实世界的证据

The design says the counter may only move when something happens. Measured against the live trail:

```
silence 04:24 → 09:00   276 min   counter moved 1.39
silence 09:02 → 09:51    49 min   counter moved 1.39
silence 01:37 → 01:48    11 min   counter moved 0.69
```

Four and a half hours of nothing moved the clock **not at all**; the 1.39 at the endpoint is `log(4)` from
the injection that ended the silence. A wall clock would have aged every memory by 4.6 hours while the
person slept. That is the entire argument for the memory unit, confirmed on real data rather than in a
test.

### 四带边界第一次由分布推导

With 22 samples the derived edges became `13 / 268 / 414 MU` — much wider than the fixed `5 / 50 / 500`
hypothesis, and the bands read `fresh 6 · active 5 · cool 7 · cold 4`. The fixed numbers were not merely
unproven; they were wrong in shape, putting most entries in one band.

323 tests, coverage lines 90.5 / branches 70.9 / functions 85.6.

## [5.0.5] — 2026-11-17

Band edges come from the distribution; retirement is refused by rule.

### The distribution was lying about age

Percentiles over the live store put half the entries at ~73 MU. The cause was not age: the v7 migration
stamped existing rows with the counter's **starting value**, so `mu_touched = 0` meant *never observed*
rather than *touched at MU zero*, and those entries sat at `p = muNow` — the largest possible distance —
dominating every high percentile while saying nothing about how old they were. Counting them turned 7
cool entries into 12.

`muPositions` now reports `untracked` separately and keeps those entries out of the band counts and out
of the edge derivation. `doctor` says `16 tracked · 5 without MU history` instead of pretending the five
are the oldest.

### Edges, derived

`muBandEdges: 'auto'` derives the edges from observed distances: lower quartile, median, 95th percentile,
with each edge held at least 1.5× above the previous one. Below twenty samples it falls back to the fixed
5 / 50 / 500, because a percentile over sixteen entries describes those sixteen and nothing else — a
display that jumps while the store is young is worse than a stated hypothesis.

### Retirement, declined rather than calibrated

`muRetireAfter` stays **0**, and the reason is now a rule rather than an omission: a threshold read off
the current tail retires the tail, which recomputes the tail, which retires more. That is a ratchet that
empties the store one quantile at a time. Retirement needs a criterion from *use* — or an operator
decision — and distance alone cannot supply it. `doctor` now reads `retirement off (not derived from
distance)`.

### Capability note, recorded because it changes how UI gets verified

The web UI at `127.0.0.1:24547` answers **401 to `/` itself**, so an unauthenticated headless browser can
only screenshot a login wall. The persisted operator cookie could not be reused either: Edge is running
and holds `Default/Network/Cookies` exclusively (`EBUSY`). `scripts/diag/gui-probe.mjs` is the probe that
established this, and it is kept because the answer will change the moment the desktop app is relaunched
with `--remote-debugging-port`.

317 tests, coverage lines 90.7 / branches 70.8 / functions 85.8.

## [5.0.4] — 2026-11-17

Production instrumentation, and the first defect it found.

### `scripts/report-production.mjs` — "is it healthy right now?"

One command over the live store and audit log, aggregating both halves and the clock: injections, slice
hits, how often the rewriter fired and whether it found anything, curation attempts and outcomes, the MU
counter with its four bands, failure events, and a single verdict line ordered by what would make the
product *wrong* rather than merely idle. `--json` for trend analysis.

Wall clock appears in it only to group activity into a window, so "running now" can be told from
"stopped three days ago". Nothing in the product decides anything from it, and the runbook says so,
because that distinction is the one most likely to erode.

### What it found on the first run

One day of real use:

```
忆  injections 2790 (2361 entries listed) · slice hits 9 · rewrite fired 57 (found 16 · empty 31 · skipped 10)
记  curate started 146 · ran 29 · wrote 9 (21 entries)
    reasons: nothing to read 81, ran-and-wrote-nothing 29, no candidate sentence 19,
             "reply has no keep array" 8, not a root conversation 7, "reply is not JSON" 2
时钟 144.46 MU · fresh 6 / active 8 / cool 5 / cold 0 · retirement off
```

**7% of curation passes were failing to parse.** Those ten are not judgements — they are the model
transport or the parser — and the audit recorded only the shape complaint.

### Fixed

- **A bare JSON array is accepted** as the curator's contract without its envelope. Rejecting it cost a
  turn's memory for a formatting choice; the items are validated exactly as before.
- **The failing reply is recorded.** `rawHead` (collapsed, ≤160 chars) now travels with the parse error
  into the audit line, because "reply has no keep array" cannot distinguish a different key from a
  stringified apology, and guessing at that has cost releases before.

### Docs

`docs/PRODUCTION.md` — the runbook: which command answers which question, the wall-clock boundary, the
three checks that make a plugin registration complete, the recovery steps for the non-atomic
`remove_bundle`, the pnpm traps, and the current known gaps. `scripts/diag/deploy-integrity.mjs` proves
that what runs is what was published (5.0.3: 62 files, zero differences).

312 tests, coverage lines 90.6 / branches 70.7 / functions 85.6.

## [5.0.3] — 2026-11-17

A class name that does not exist.

The panel block shipped in 5.0.1 wrapped its four band cells in `.loci-cells`, and that class has no CSS
rule at all — the real container is `.loci-grid`. Nothing errored: the div laid out as a block, so the four
counts rendered as four full-width stacked cards, each roughly a hundred pixels tall, in a panel that is
supposed to be scannable.

Found by screenshotting the block instead of trusting the payload. The data was correct, the code was
correct, and the result was wrong — which is the whole reason a rendered picture is part of the gate and a
passing assertion is not.

`.loci-grid` gives the same auto-fit behaviour as the entries row above it: two columns at the panel's width,
one card per band.

307 tests, coverage lines 90.6 / branches 70.6 / functions 85.6.

## [5.0.2] 鈥?2026-11-17

One entry, two ages 鈥?in the same prompt.

### The bug

The same memory rendered as `now` in the always-on core and as `13 MU ago` in the per-turn slice. The
core's query joined `memory_usage` and found the real stamp; the slice's candidate query still selected
`updated_at` and left `mu_touched` undefined, and `undefined` read as zero 鈥?so every sliced entry
reported "as far away as the clock has ever got".

It was found by rendering the live prompt instead of reading the code, which is the only way a
disagreement between two queries that both look correct can surface.

### Fixed

- The candidate query selects `COALESCE(u.mu_touched, 0)`, so both surfaces read the same stamp.
- **The unit is explained wherever a distance appears.** A line saying `now` contains no "MU" at all, and
  the slice is injected as its own message, where a model may never see the section's legend. The slice
  now appends `ages are in MU (units of work, not dates)` when no line already says `MU ago` 鈥?paying
  those bytes only in the case where the word is genuinely absent.
- A regression test pins both: one entry must not carry two ages, and no block may state a distance
  without stating its unit.

307 tests, coverage lines 90.6 / branches 70.6 / functions 85.6.

## [5.0.1] 鈥?2026-11-17

The panel gets the clock.

5.0.0 shipped the counter, replaced the three wall-clock behaviours, and exposed the distribution in
`doctor` and the evaluation 鈥?but the panel, which is where a person actually looks, still showed nothing.
The objective named three surfaces and only two were done.

### Added to the Statistics tab

- **Distance from the working set**, as four bands of memory units: fresh / active / cool / cold.
- **The trail**, newest last: for each advance, the reason and the two components that produced it
  (`+2 new 路 +3 use`), so "why did the clock move" is answerable in the UI rather than by reading
  `mu_event` with a script.
- `memory unit` and `retirement` in the store block, with retirement stating plainly that it is
  **off because the threshold is not calibrated** 鈥?the growth that follows is the visible cost of that
  choice, not a hidden one.

### What the real store shows

Verified against the live database rather than assumed:

```
scopes  [session:鈥? workspace:鈥? project:鈥? global:]
mu.now  10.15
bands   {fresh: 3, active: 0, cool: 0, cold: 0}
trail   16:57:10 mu=3.00 reason=inject add=0 use=4
        16:59:15 mu=8.76 reason=inject add=0 use=4
        17:00:09 mu=10.15 reason=inject add=0 use=3
```

Every advance so far is `inject`, which is the expected shape now: the clock was introduced with all
existing entries stamped at its starting value, so nothing has had a chance to age yet. Entries that keep
being injected stay at distance 0 by design 鈥?being in the working set *is* being at zero.

306 tests, coverage lines 90.6 / branches 70.6 / functions 85.6.

## [5.0.0] 鈥?2026-11-17

The memory unit becomes the only clock.

### Why this is a major version

There is no longer any independent notion of time in this store. MU *is* time: "flowing" means the
counter moved, and "older" may only mean further from the working set. Three behaviours that decided
things from wall clock are gone, and two defaults changed.

**This also means, deliberately, that nothing expires by time any more.** The store grows until the
compaction dynamics land. That is the trade: better a store that can be pruned on purpose than one that
deletes a quarterly rule for being "old" when it was merely unused. `doctor` and the panel show the
four-band distribution so the growth is visible instead of silent.

### The counter

```
delta = log(w_add * add + w_use * use + 1)
```

`log(1) = 0` is load-bearing: with no new memory and no recall, the clock does not move. Sleeping costs
nothing 鈥?which is the entire reason a memory unit exists instead of a timestamp comparison. The log
also means the hundredth event on a busy day costs less than the first, so a large intake does not
accelerate the ageing of everything already stored.

It advances at the three places something actually happens: a write (`add`), an injection (`use` by the
number of ids listed), and a lookup (`use`). Every advance is recorded in `mu_event` with both
components, so "why did the clock move" has an answer rather than an inference.

**The number is not a duration.** It is not minutes, and it is not comparable across installs. Only
differences between two readings mean anything, and only inside one store.

### Schema v7

`memory.mu_born`, `memory_usage.mu_touched`, and `mu_event` (the trail). Existing rows are backfilled to
the current counter value, which says "their clock starts now" 鈥?we have no MU history for them, and
inventing one would make old curated entries look freshly used. The migration's `ALTER`s are guarded, so
a replayed chain cannot fail on a column that is already there.

### The three constraints, now enforced

| | Before | After |
|---|---|---|
| **C1** no wall-clock forgetting | `working` expired after 7 days, `candidate` after 30 | removed; retirement is `p > muRetireAfter`, default **0 = off** until measured |
| **C2** no wall-clock ordering | `ORDER BY updated_at`, `exp(-age / 30 days)` | `score 鈫?reads 鈫?mu_touched`; recency is `exp(-p / 50)` |
| **C3** no wall-clock presentation | `as of 2026-11-16` in the prompt, a date on every slice line | `3.2 MU ago` per line, and one footer saying ages are in units of work, not dates |

### What stayed at zero on purpose

`muRetireAfter` is `0`, and the band edges (5 / 50 / 500) and `MU_RECENCY_SCALE` (50) are labelled
uncalibrated in the source. Those four numbers have to come from a measured distribution; guessing them
would repeat the mistake already paid for with `SLICE_BUDGET_BYTES`, which is still an unmeasured number
several releases later. `eval-memory.mjs` gained a **D section** that prints the distribution so the
argument can be had with data.

### Observable

- `doctor` prints `memory unit: N MU 路 verified (fresh/active/cool/cold) 路 retirement off (threshold not calibrated)`
- `/stats` carries `mu` (positions and bands) and `muTrail`
- `eval-memory.mjs` D section: distance min/median/max and band counts for a 600-entry corpus

306 tests, coverage lines 90.6 / branches 70.6 / functions 85.6.

## [4.14.0] 鈥?2026-11-16

The section stops answering a question it cannot see, and the vector channel stops being decorative.

### 蹇嗙殑鏃舵満锛氬彧鏁?娌℃壘鍒?锛屼笉鏁?鎵鹃敊浜?

`systemPrompt.assemble` runs inside `preStep`, and at that moment the turn's message is still in the
agent's inbox. So the section could only ever search by the **previous** message. A turn that changed
the subject was handed memory about the old topic, and nothing detected it 鈥?a stale query that happens
to match looks exactly like a hit, and the rescue only fired on `tier === 'none'`.

That is a correctness bug, not a tuning issue, and the fix is structural: **the section no longer carries
anything question-dependent.** It renders rules, the count pointer and the pending notice. The
query-dependent slice is composed by `agent/pre-step`, which is handed the claimed messages, and is
injected as its own message. The rewrite rescue now backs up that slice directly instead of consulting a
handoff note, so `recordLastSlice`/`lastSliceOf` are gone rather than left as unused plumbing.

### 蹇嗗摢浜涳細浣跨敤鏁版嵁鍥炴祦鎺掑簭

`selectSlice` now joins `memory_usage` and orders by `score`, then `reads`, then `updatedAt`.

`reads` only counts upward, deliberately: it means "this was injected and somebody then looked it up",
which is the only evidence available that an entry earned its bytes. `injections` is **not** used against
an entry 鈥?an entry injected and never opened is usually one whose title was already the whole answer, and
penalising that would delete the best entries first.

### 蹇嗗摢浜涳細鍚戦噺閫氶亾姝ゅ墠鏄楗板搧

Two separate breaks, both found by asking what a wordless question does:

- `base.channel = request.channel`, and **no caller ever passed one**. The channel was configured,
  health-reported in the panel, and never consulted once. `search` now defaults to `store.embedding`.
- `vectorCandidates` re-scored **only the ids lexical search had already found**, so it was a re-ranker
  and could never recall anything new 鈥?the exact gap it was configured to close. It now searches the
  whole scope when there are no lexical candidates.

Proven end to end against a stub `/embeddings` server: an entry titled `鍙戝竷蹇呴』鍏堢伆搴 is found by the
query `rollout canary first?`, which shares no word with it, with `channels: ["vector"]`.

**Honest boundary:** the channel still needs an endpoint (`vectorMode`, `vectorEndpoint`, `vectorModel`)
and `maintenanceMode: sweep` for the backfill. The slice cannot use it at all 鈥?a prompt section is
synchronous 鈥?so vectors serve the rescue and `loci_search`.

### 鏂版枃妗?
`docs/MEMORY-UNITS.md` 鈥?the memory-unit model for elastic compaction: causal time rather than wall clock,
a signed position per memory, log decay on both sides of equilibrium, and the criteria that make the
design testable. No implementation; the one number it cannot fix without measurement is named as such.

### 鐘舵€佺伅

The dot beside the version is a status light with three states. Its "all clear" state used the brand
accent, which in this theme is dark enough to read as decoration 鈥?a signal that is always on is not a
signal. It now appears only for pending/disputed (amber) or an error (red).

297 tests, coverage lines 89.0 / branches 70.1 / functions 83.2.

## [4.13.0] 鈥?2026-11-16

Session summaries are off by default: the curator replaced them.

### Why

A summary was written as an **episodic candidate**. Episodic is not in `REVIEWABLE_KINDS`, so it could
never be approved; and only `verified` entries are injected, so it could never be recalled either. Every
summary was therefore a row that could not act 鈥?and there were a lot of them: 40 of the 51 stored rows
on `invictus`, plus five more within a minute of a full reset.

The curator does the job the summary was standing in for, and does it on content that can act: a verbatim
sentence, a kind, and a scope, which is exactly what a recall needs.

### Changed

- **`summaryOnDispose` defaults to `false`.**
- **The capability stays.** Somebody may genuinely want a chronological record of a session, read in the
  panel rather than injected; setting it to `true` still writes one.

### A test that had been passing for the wrong reason

Writing the regression test for the *on* path exposed that the shared `seed()` helper omitted `files`,
which the summary write reads. The write threw, the throw was swallowed by the `catch` that logs a
warning, and every existing test only ever exercised the paths that return before that line. So the
suite had a green test for a write path that could not have worked with that seed 鈥?it just never got
there. The helper is fixed and both branches are now covered.

295 tests, coverage lines 89.1 / branches 70.3 / functions 83.0.

## [4.12.1] 鈥?2026-11-16

Two states the reset exposed within a minute of 4.12.0 shipping.

- A store holding only session summaries 鈥?candidates of a kind that can never be reviewed and never
  injected 鈥?counted as non-empty, because `heads` counts rows, so the card rendered its header and
  nothing else. The empty state now depends on what is **usable**: verified, pending and disputed all
  zero.
- The section gauge rendered whenever there were rows, showing `0 / 3584 B` when no prompt had been
  assembled since the reset. That reads as a measurement when it is an absence of one, so it now
  requires an actual last injection.

Both were visible only against a real post-reset store, which is why the reset and the card changed
together.

## [4.12.0] 鈥?2026-11-16

The card says what its numbers mean, and stops spending a row on the ones that repeat.

### What each figure is

- **verified** 鈥?saved facts that can enter the prompt right now, in the current scope. The only
  number that answers "how much memory is active".
- **pending** 鈥?candidates of a kind that needs approval first (`rule`, `semantic`, `procedural`). A
  session summary is never counted, because a summary of the past is history, not a claim.
- **disputed** 鈥?marked wrong. Kept in history, never injected.
- **injected** 鈥?times a saved fact was included in a prompt, cumulative.
- **opened** 鈥?times one was then looked up in full, cumulative.

### What changed on the card

- **One line instead of two rows.** The three large metrics sat at the top and a footer of three more
  sat at the bottom, which spent a row on each. They answer one question between them, so they are
  now one line at the bottom. 140 px 鈫?109 px at the same width.
- **`dead` is gone.** It counted entries injected but never opened 鈥?which, while nothing is ever
  opened, is simply the number of injected entries. The same fact twice. It survives in the panel's
  statistics view, where a breakdown belongs.
- **`disputed` appears only when it is not zero.** It is an alarm, not a statistic, and a permanent
  zero trains the eye to skip the line it is on.
- **The bar is labelled.** `518 / 3584 B` on its own invited the reading "memory is 14% full"; it is
  the bytes the memory *section* took in the last prompt against that section's budget, and it now
  says `section` and carries a tooltip. It never describes how much memory is *stored*.
- **Every count has a tooltip** naming exactly what it measures, because the card is where the
  question "what am I looking at" gets asked.
- **The review button is a button**: `Review 2 鈫抈 instead of a sentence in a box.

### Verified visually, not by assumption

`scripts/diag/card-preview.mjs` renders the old layout, the new one and the empty state at the card's
real width, with the CSS extracted from `client.js` rather than retyped, and screenshots them with the
browser already on the machine. Measured heights: before 140 px, after 109 px, empty 71 px.

## [4.11.0] 鈥?2026-11-16

Both halves are now closed in real use, and the relevance figure is finally honest.

### 璁? five entries, written by the model, from real conversations

```
VERIFIED  procedural 路 session:3e48f83b   review/accept 榛樿浣跨敤 astra-high锛屼笉榛樿 astra-max
VERIFIED  semantic   路 session:28851ce6   璁惧璁剧疆閫夐」鍗℃縺娲绘椂鏄剧ず涓嶅畬鏁?VERIFIED  semantic   路 session:28851ce6   閮ㄥ垎涓嬫媺妗嗛娆＄偣鍑昏鍚烇紝绗簩娆＄偣鍑绘墠鏄剧ず瀹屾暣閫夐」
VERIFIED  semantic   路 session:28851ce6   鍏ㄥ眬璁剧疆鍒楁槧灏勬潵婧愬垪涓嬫媺妗嗛噸澶嶇偣鍑讳細閲嶅鎵撳紑鑰岄潪寮€鍏冲垏鎹?VERIFIED  rule       路 session:28851ce6   鏀瑰姩鍓嶅悗涓ユ牸瀹¤锛岀姝㈤『甯︿慨鏀规湭瑕佹眰鐨勫唴瀹?```

All five `verified`, which means the quote gate accepted every one: each is grounded in a verbatim
sentence the person actually wrote, in the conversation it came from. None were approved by anyone 鈥?the trust came from the grounding.

The reason they are session-scoped is not incidental. A conversation's own words are true of that
conversation, so they verify immediately; promoting one to workspace scope reopens the gate through
`sameScope`, which is the boundary rule from 4.2.0 doing its job.

### Why the last five releases were needed

Four things had to be right at once, and each was invisible until the one before it worked:
`agent/disposed` never fired (鈫?`step/end`), `turn/end` is not dispatched at all (found by a
histogram, one row), the capture buffer excluded most messages (鈫?a dedicated transcript), and a
two-message minimum refused a transcript that legitimately had one.

### Relevance, measured honestly

The old `relevance` column was bytes-of-the-needed-entry over section bytes. It cannot move much,
because the slice's denominator is already near its floor 鈥?so it read 2.0% against a legacy 1.0% and
understated the change.

The honest figure is **precision**: of the entries listed, the share that are the one the question
needed. A fixed index lists 35 entries for every question regardless, so its precision is bounded by
(chance of inclusion)/35 and *cannot improve* without changing what it emits.

| entries | fixed index | slice composer | ratio |
|---|---|---|---|
| 40 | 2.50% | 10.0% | 4.0脳 |
| 200 | 0.50% | 7.8% | 15.6脳 |
| 600 | 0.35% | 7.5% | 21.5脳 |

At 600 entries a reworded question got 35 lines of which about 0.35% were useful; it now gets 8 lines
of which about 7.5% are useful 鈥?**21脳 better precision on 71% less text**. Natural questions improve
35.9脳.

293 tests, coverage lines 89.1 / branches 70.3 / functions 83.0.

## [4.10.1] 鈥?2026-11-16

One message is enough to judge.

### The last "nothing to read"

The transcript starts accumulating when the plugin loads, so a conversation already in progress has a
short window 鈥?mine had exactly one message since the upgrade. The trigger required **two**, on the
reasoning that a conversation needs an exchange before it can be judged.

That reasoning is wrong on its own terms: `浠ュ悗閮ㄧ讲鍏堣蛋鐏板害` is durable in a single sentence, and the
pre-filter is what decides whether anything is worth a model call. The length check only needs to rule
out having nothing at all.

### Changed

- **\`messages.length === 0\` is the only refusal.** The pre-filter does the judging about content.
- **\`curate-start\` records both buffer sizes** 鈥?`transcriptMessages` and `captureMessages`. Two
  releases answered `nothing to read`, and "the buffer is empty" and "the buffer was never filled" are
  different faults; the counts make that visible in one row rather than another round of inference.

293 tests, coverage lines 89.1 / branches 70.2 / functions 83.0.

## [4.10.0] 鈥?2026-11-16

Curation gets the transcript the events actually carry.

### Where 4.9.0 got to

Curation fires reliably now 鈥?six runs on `step/end`, every one with `hasRoute: true` 鈥?and every one
reported **`nothing to read`**.

### The cause is the same filter, one surface later

`capture` buffers only `user/message` events whose `source.kind` is `user`. That is right for durable
extraction: an injected prompt is not something the person said. It is wrong for anything that needs
the conversation, and the histogram already showed why 鈥?of sixteen `user/message` events, the source
kinds were `time-context`, `agent-instructions`, `runtime-context`, `skill-catalog`, `tool-jobs` and
only one `user`.

The same filter produced the empty recall question two releases ago. This is the second time it has
been the answer, which is worth stating plainly: **one filter, two consumers with opposite needs.**

### Changed

- **\`index.js\` keeps a bounded transcript per session** from the events themselves 鈥?user and
  assistant messages, forty each, no source filter 鈥?and passes it to the curation trigger, which
  prefers it over the capture buffer.
- **\`capture\` is untouched.** Its filter is correct for its own job, and widening it would make
  injected prompts eligible for durable extraction.

293 tests, coverage lines 89.1 / branches 70.2 / functions 83.0.

## [4.9.0] 鈥?2026-11-16

Curation triggers on `step/end`, and only a real run counts as done.

### The row that settled it

4.8.1 recorded a histogram of every `session/event` type reaching the curation listener. It listed
`step/start`, `step/end`, `system/message`, `user/message`, `developer/message`,
`assistant/message`, `tool/call`, `tool/result`, `request/header`, `job/registered` and the
`tool/ptc-dispatch` pair 鈥?and **no `turn/end`**.

So `turn/end` is appended to the session log but never dispatched through `session/event`. Three
releases went to guessing which event carried a finished conversation; one row would have answered it
before the first of them, and that is now written into the code as a comment rather than a lesson.

### Changed

- **`step/end` triggers curation.** It fires at the end of every step, which includes the end of a
  turn, and it is demonstrably delivered.
- **A session is marked done only when curation actually ran.** The previous version marked it on any
  attempt, so the first event of a conversation 鈥?which arrives before there is anything to read 鈥?  consumed the one chance. Attempts are capped at three per session so a conversation that never has
  enough content does not retry forever.

### Also

- \`session_event_seen\` stays in \`meta\`. In normal operation its absence of `turn/end` is not a
  defect, it is the reference that explains why curation listens to `step/end`.

293 tests, coverage lines 89.1 / branches 70.2 / functions 83.0.

## [4.8.1] 鈥?2026-11-16

Does the curation listener receive anything at all.

Three triggers have now been wired for curation and none of them ran: `agent/disposed` on the injected
child, `agent/disposed` on the main context, and `turn/end` on the main context. Each was a reasonable
inference about which event carries a finished conversation, and each was wrong in a way no amount of
further inference could settle.

So this release asks the smaller question first 鈥?the one that should have preceded the first of the
three: **does this listener receive anything at all?** `session_event_seen` in `meta` is a histogram of
every `session/event` type reaching the listener, written on the first event of any kind. Empty means
the listener is not attached; the types present but without `turn/end` means that event does not exist;
`turn/end` present with curation still absent means the fault is downstream, and the audit now says
which step.

`curate-start` is written **before** the work rather than after, because an outcome recorded only on
success cannot distinguish "never called", "threw", and "returned nothing" 鈥?the three cases that have
each cost a release.

No behaviour change.

## [4.8.0] 鈥?2026-11-16

Curation triggers on an event that is proven to arrive.

### What the last two attempts established

`agent/disposed` was the obvious signal for "a conversation ended". Measured:

- registered on the injected child of `llm`: never fired;
- registered on the main context, beside capture's listener: never fired either 鈥?a finished
  conversation produced its session summary and **no `curate` audit row at all**;
- while `agent/pre-step` and `session/event` both fire on that same context without difficulty.

I stopped trying to infer the scoping rule and switched to a signal with evidence behind it.

### Changed

- **`turn/end` triggers curation.** The capture layer demonstrably receives `session/event`, and a
  completed turn is the first moment a conversation has something worth judging. `agent/disposed`
  stays registered as a second chance.
- **A once-per-session guard** makes the two triggers idempotent, so the second one costs nothing.
- **Every outcome is audited**: `{sessionId, trigger, ran, reason, written}`. Which trigger fired is
  part of the record, because "the fallback is doing the work" is a fact worth seeing rather than a
  detail to hide.

### Why the cheap trigger is also the right one

Waiting for disposal means a conversation's memory is only curated after it is completely finished 鈥?which for a long session may be hours after the content was said, and never at all if the session
stays open. Triggering on `turn/end` curates while the conversation is still alive, which is both
more timely and, as it turned out, the only one of the two that actually runs.

293 tests, coverage lines 89.1 / branches 70.2 / functions 83.0.

## [4.7.1] 鈥?2026-11-16

Curation now runs where the event actually arrives.

### The observation

A short conversation was created on purpose to make `agent/disposed` fire with real content. The
session summary was written 鈥?so the event arrived 鈥?and **no curator-sourced entry appeared**.
`curatorMode` was `session-end`, the model route was healthy, and the probe had passed four releases
running.

### The cause

The curation listener was registered on the **injected child** of `llm`:

```
ctx.inject(['llm', 'agentDefaultModel'], (child) => {
  child.on('agent/disposed', ...)   // never fired for ordinary conversations
})
```

Capture's listener, on the main `ctx`, receives the same event without difficulty. Whatever the
scoping rule is, the practical reading is the same one that cost six releases already: **do not assume
a listener on an injected child sees what a listener on the main context sees.** It moved to the main
context, next to capture's, and the route is published to it through a small holder.

### Also

- **Curation is recorded in the audit either way**: `{ran, reason, written}`. "Did not run" and "ran
  and kept nothing" are different results, and every silent failure in this project has been the two
  being indistinguishable.

### A separate finding, recorded here because it is real

The short conversation's own `loci_write` landed as `candidate` rather than `verified`, and the
reason is worth writing down: the quote it supplied contained a zero-width space, which
sanitisation strips. A stripped zero-width space removes a character from the middle of the quote, so
what remains is no longer a **contiguous** substring of the raw message and the verbatim gate correctly
refuses it. The gate is right; the lesson is that a quote copied from text containing invisible
characters can fail for a reason no one can see.

293 tests, coverage lines 89.1 / branches 70.2 / functions 83.0.

## [4.7.0] 鈥?2026-11-16

The reason the rescue kept receiving nothing, and the one surface that can see the question.

### The fact that ended three releases of guessing

`systemPrompt.assemble` runs **inside** `preStep`. At that moment the turn's user message is still
in the agent's inbox 鈥?it has been claimed, but not yet appended to the session log. So:

- a `session/event` tracker sees nothing, because that event has not fired yet;
- `capture`'s buffer sees nothing, for the same reason;
- and the prompt section, which is where retrieval runs, therefore **cannot know what is being
  asked on the first step of any turn**.

That is why the question was empty in every previous attempt, and why the three fixes before this one
(all reasonable in isolation) changed nothing measurable. The diagnostics that finally settled it were
`user_tracker` never appearing at all and `slice-render` reporting `queryChars: 0` for every session 鈥?facts, not more reasoning.

### The fix

The `agent/pre-step` waterfall **is** handed the claimed messages. It is the only surface that knows
what was just asked, and it is asynchronous, so it can also await a model. `rescueMiss` now takes the
question from its caller, and the plugin passes `firstUserText(decision.messages)`.

### What the section still does, and why

The section keeps composing from whatever it has 鈥?the core, the pointer, and a slice against the
previous user message. On a first step that slice may be stale, and that is now a known and stated
property rather than an accident: the rescue exists precisely because the first step of a turn is the
one where the section is least informed.

### Also

- `slice-render` stays in the audit: `queryChars`, tier and bytes per render make the section's own
  information state visible, which is what distinguished this cause from the two before it.
- `user_tracker` stays in `meta`. It records nothing in normal operation, and its absence is now the
  evidence that the query does not come from events 鈥?a fact worth keeping.

293 tests, coverage lines 89.2 / branches 70.3 / functions 83.0.

## [4.6.1] 鈥?2026-11-16

The empty question survived its fix, so the next layer of the failure gets named.

4.6.0 gave retrieval its own tracker. After installing it, four live rescues still reported
`query too short` with `queryChars: 0` 鈥?including two other conversations, so it was systematic
rather than a quirk of one session. The tracker is present in the installed bundle, registered on the
right event, reading the same content shape `capture` reads. Everything about it looks correct, which
is exactly why the next release records facts instead of more reasoning:

- **`user_tracker`** in `meta`: how many `user/message` events arrived, what shape their content
  had, which `source.kind` values were seen, and how many sessions are currently tracked. This
  separates "the listener never fired" from "it fired and the content had no text" 鈥?only one of
  which is a bug in the tracker.
- **`slice-render`** in the audit, per render: `queryChars`, the tier reached, and the bytes
  produced. This separates "the tracker had nothing" from "the section did not receive it", which
  are different fixes in different files.

No behaviour change. Three releases have now gone to this one empty string, and each one narrowed the
question by one layer; this one narrows it to a single bit, and the answer will be in `meta` on the
next boot.

## [4.6.0] 鈥?2026-11-16

The rescue ran in real use, and the question it was handed was empty.

### What happened

The first live `recall-rewrite` event after 4.5.1 was:

```
recall-rewrite-skip  reason: "query too short"
```

Every other part of the chain worked 鈥?the section left its note, `agent/pre-step` picked it up in
time for the same turn, and the rescue decided to rewrite 鈥?and then it was handed an empty string.

### Why

The question came from `capture.lastUserText`, and capture deliberately ignores messages whose
`source.kind` is not `user`: durable extraction must never treat an injected prompt as something the
person said. Retrieval has the opposite requirement. A turn opened by a harness-injected message
still has a question worth searching for, and reading nothing there means the section always misses
and the rescue always has nothing to rewrite.

Two surfaces, two different filters, and one of them had borrowed the other's.

### Changed

- **A dedicated per-session tracker** for the newest `user/message` text, registered on
  `session/event` without capture's source filter. It is the section's source of truth and capture
  remains untouched, so durable extraction still refuses injected prompts.
- **`recall-rewrite-skip` records `queryChars`** 鈥?the length, never the text. That is enough to
  tell "the section could not see the question" from "the model declined", which are the two
  possibilities this diagnostic existed to separate, without putting a conversation in the audit log.

### Note

This is the same class of mistake as the last four releases: a component silently doing nothing
because one filter was borrowed from a neighbour with different needs. The difference is that the
previous ones took a release each to find, and this one was named by its own first audit line 鈥?because the diagnostic was put where the failure happened rather than next to it.

## [4.5.1] 鈥?2026-11-16

A rescue that finds nothing is now recorded.

4.5.0 logged only rescues that succeeded, which left two states indistinguishable in the audit 鈥?`recall-rewrite` absent could mean "the feature never ran" or "it ran and was useless". Four releases
(4.4.0鈥?.4.5) were spent on exactly that confusion, so the rule is applied here before it can cost
anything:

- `recall-rewrite` 鈥?ran, found entries;
- `recall-rewrite-empty` 鈥?ran, the model's alternatives matched nothing;
- `recall-rewrite-skip` 鈥?ran, and the model route or its reply was not usable, with the reason.

No behaviour change. The distinction is what makes the next step diagnosable: if ordinary use shows
`recall-rewrite-empty` far more often than `recall-rewrite`, the hints offered to the rewriter or the
number of alternatives needs attention, and that is a tuning question with data behind it rather than
a guess.

## [4.5.0] 鈥?2026-11-16

Recall gets a second chance in the model's own words. The last piece of "蹇?.

### The measured gap this closes

The lexical slice misses about **40%** of reworded questions at 600 entries, and no admission
threshold fixes it: `atlas 瑕佸彂鏂扮増鏈琡 and `atlas 鏈嶅姟涓婄嚎鍏堣蛋鐏板害` share exactly one token. A
tokenizer cannot bridge that gap. A model can 鈥?it knows those are the same question and can say so
in the words the store already uses.

Measured with an **oracle** rather than a fixture (`scripts/eval-memory.mjs`, part A3), because a
fixture would measure the fixture: of the questions the slice missed, **100%** would be recovered by
a correct rewrite 鈥?76 of 76 at 200 entries, 115 of 115 at 600. The ceiling is an upper bound, not a
result, and it settles the design question: rewriting is sufficient in principle, so the remaining
work is only how close a real model gets.

### How it works, and why it is shaped this way

The ordering in the Host is what makes this possible at all: `systemPrompt.assemble` runs **before**
the `agent/pre-step` waterfall. A prompt section's `text` is synchronous and its context carries no
session, so the section cannot ask a model anything. It can, however, leave a note 鈥?and the
waterfall, which *can* await, acts on that note in time for the same turn.

- **`recordLastSlice` / `lastSliceOf`** 鈥?the note: what tier the render reached and what was asked.
  Bounded and short-lived, because it is a handoff, not state.
- **`rewriteQuery`** 鈥?turns the question into up to three alternative phrasings, with the store's
  own vocabulary offered as a hint. The original is excluded.
- **`rescueMiss`** 鈥?the guards, which matter more than the feature: **only on a genuine miss** (a
  rewrite when the slice answered would spend a call to second-guess a correct answer), **once per
  turn**, and the rescue is **added**, never substituted for what the section already said.
- **`recallRewrite: 'on-miss' | 'off'`**, default `on-miss`. The cost is one model call per missed
  turn and nothing at all on a hit.

### Rejected shapes

- A paragraph-long "query": rejected by length, because a rewrite is a search string and a
  paragraph is a sign the model did something else.
- A single line of prose: rejected, because it means the model declined 鈥?turning "no idea" into a
  search would spend a retrieval to learn nothing. A multi-line list is still accepted.
- Rewriting on every turn: rejected on cost, and on the risk of replacing a right answer.

### Honest boundary

The rescue is measured against an oracle, not a live model. Whether the deployed model rewrites as
well as the oracle is a separate question, answered empirically by whether `recall-rewrite` audit
rows appear with non-zero ids in ordinary use.

287 tests, coverage lines 89.1 / branches 70.1 / functions 83.0.

## [4.4.5] 鈥?2026-11-16

The empty reply, and the line that caused it.

`rawHead` came back empty, which moved the fault from parsing to the call itself. The marker written
beside it said why:

```
llm_selection_error    cannot get property "agent" without inject
```

The plugin has no agent of its own, so `child.agent` throws. Both `provider` and `model` were
therefore `undefined`, the request named no route, and the service returned an empty stream 鈥?which
the parser then reported as "reply is not JSON", sending three releases of diagnosis after the wrong
subsystem.

### Fixed

- **The model selection now comes from `agentDefaultModel`**, injected alongside `llm`. That is the
  correct source for a background pass: there is no conversation to inherit a model from, and the
  default selection is exactly what "run this outside a turn" means.
- **The stream is counted.** `llm_frames` records how many frames arrived and what shape they had,
  because "the service streamed nothing" and "frames arrived that this code could not read" are
  different faults with different fixes.

### What this cost, stated plainly

Four releases (4.4.0鈥?.4.5) to get one model call working, and the deciding information was a single
error string that only became visible when the diagnostic was added *inside* the failing expression
rather than next to it. The lesson is narrower than "log more": a helper that swallows its own
reason for failing will send every later investigation to the wrong place.

## [4.4.4] 鈥?2026-11-16

The model answered, and the parser threw the answer away.

With the route fixed, the probe ran and came back `reply is not JSON`. The model had produced a
correct object wrapped in a sentence. The contract says "JSON only", so the strict parser was
right on the letter and wrong on the outcome: an entire conversation's memory was discarded over a
courtesy phrase.

### Changed

- **`extractJsonObject`** finds the first balanced JSON object in a reply. It is string-aware, so a
  brace inside a title ("a {b} title") cannot end the object early, and it reads exactly one object
  rather than greedily matching to the last brace.
- **The drift is recorded.** `parseCuratorReply` returns `extracted: true` when the fallback was
  needed, so a model moving away from the contract stays visible even when the memory is recovered.
- **The probe keeps the first 320 characters of the raw reply.** "reply is not JSON" is a diagnosis
  with no next step; the head of the reply says whether the model ignored the shape, the request was
  truncated, or something else answered.

Strict parsing still governs the fields: an unknown kind, an oversized field, or a quote that is not
verbatim drops the item. Tolerance applies to the envelope, not to the contents.

277 tests, coverage lines 88.8 / branches 69.9 / functions 82.2.

## [4.4.3] 鈥?2026-11-16

The model route, rebuilt so its failure is visible 鈥?and the latent fault behind four silent releases.

### What the diagnostics proved

Instrumenting the route showed `llm_route_seen` written on every boot and **nothing after it**.
Execution stopped at the line that built the call function. That fault was not new: it had been in
the plugin since the extractor was written, and because `extractMode` is off by default nothing
ever exercised it 鈥?it simply made every consumer of the route inert, silently.

### Changed

- **`createCompleter`** replaces the shared helper for the curator's path. It wraps every step that
  can throw 鈥?reading a property off a traced service is itself a throw site, which is why the old
  `typeof llm.stream === 'function'` expression was where execution died 鈥?and returns a reason
  rather than `undefined` alone.
- **Each step is recorded**: `llm_route_seen`, `llm_selection` (which provider/model it resolved),
  `llm_stream`, `llm_complete`. Four markers instead of one, because "no call function" and "no
  route" need different fixes and the previous releases could not tell them apart.
- The model selection is read defensively: a getter on a traced context can throw, and a throw
  there aborted the whole callback.

### The rule that comes out of this

Four releases (4.4.0鈥?.4.3) went to one failure mode: **a silent no-op that reads as success**.
The standing rule is now explicit 鈥?an optional integration must record that it did not run, and
where it stopped. Absence is not agreement.

## [4.4.2] 鈥?2026-11-16

Two more facts recorded, because the previous release narrowed the silence but did not end it.

4.4.1 made it possible to tell "the route never appeared" from "the route appeared and the pass
failed". Installing it proved the route appears 鈥?`llm_route_seen` was written seconds after boot 鈥?while the probe still produced nothing. That leaves the next distinction:

1. `completeViaHost` produced no call function (the service has no `stream`), so every downstream
   consumer is inert; or
2. the probe ran and declined for a reason it did not record.

Both are now recorded: `llm_complete` says `function` or `undefined`, and a skipped probe writes
`curator_probe_skipped` with its reason and the version that skipped it. A probe that throws writes
`curator_probe_error`.

Still no behaviour change. Four releases have now been spent on the same failure mode 鈥?a silent
no-op that reads as success 鈥?and the pattern is consistent enough to state plainly: **an optional
integration must record that it did not run**, or its absence will be mistaken for agreement.

## [4.4.1] 鈥?2026-11-16

A diagnostic for the one thing 4.4.0 could not tell apart.

After installing 4.4.0 the curator probe had produced no record, and neither the audit log nor the
store showed a single curation event. Two very different faults look identical from there:

1. the `llm` route never appeared, so the injected callback never ran; or
2. the route appeared and the pass failed.

They have different fixes, so the plugin now writes `llm_route_seen` into `meta` the moment the
route resolves, before touching it. A missing marker means the route never resolved; a present
marker with no probe means the pass itself is at fault.

This release changes no behaviour. It exists because "nothing happened" is not a diagnosis, and the
last three defects in this project were all of that shape 鈥?a silent no-op that read as success.

## [4.4.0] 鈥?2026-11-16

A model now decides what to remember, and its judgement is measured.

### Changed

- **`curatorMode` defaults to `session-end`.** When a conversation ends, one curation pass reads
  the transcript, asks a model what was durable, and writes what survives validation. The rule
  extractor stops being the only writer.
  The reason is measured: rules score **100% precision and 50% recall** 鈥?a good filter, a bad
  judge 鈥?so leaving them as the sole writer means half of what a careful reader keeps is never
  recorded. Cost is one model call per finished conversation; the pass spends nothing when there is
  nothing to read, and refuses delegated steps.

### Added 鈥?the judgement is now observable

- **`runCuratorProbe`** runs one real curation pass at activation, over a fixed transcript, and
  stores the outcome in `meta` and in the audit log. It writes no memory 鈥?measuring the judgement
  by polluting the store would be the product testing itself with itself.
- The transcript is deliberately the case the rules lose (`浠ュ悗閮ㄧ讲鍏堣蛋鐏板害`,
  `姘歌繙涓嶈鍦ㄥ懆浜斿彂鐗坄) plus noise that must not be kept (`鎸夐挳棰滆壊`). A test asserts those exact
  sentences are still there, because replacing them with ones the extractor matches would let the
  probe pass while proving nothing.
- It runs **once per plugin version**, so it costs one model call rather than one per activation,
  and it reports a wrong judgement as wrong: a model that keeps the noise and misses the rule comes
  back `ok: false` with `missed: [...]`.

### Why a self-test rather than a benchmark

The honest statement before this release was "the contract, the validation and the write path are
tested; the model's actual judgement is unknown". A fixture would have measured the fixture. Running
the real route once, on a case chosen for its failure mode, turns an assumption into a record.

274 tests, coverage lines 88.7 / branches 69.5 / functions 81.7.

## [4.3.0] 鈥?2026-11-16

Memory can flow again. S4 of the v4 architecture.

### The decision this release makes

Approval belongs to **boundaries**, not to memory. A memory confined to the conversation it was
recorded in can only reach that conversation, so asking a person to click for it adds no
information 鈥?and demanding it is exactly what froze this product. On the live store thirteen
captured candidates could never be reviewed (review covers rule/semantic/procedural and does not
accept the episodic or session-scoped writes that make up most captures), so nothing was ever
promoted and **exactly one entry ever reached a prompt** 鈥?a fact invented for an end-to-end test.

A memory that leaves its conversation is a different matter: once it is in the project or the
workspace, a wrong one follows every other conversation into its prompt. That still needs a person.

Measured, same claims written to two destinations (`scripts/eval-memory.mjs`, part C):

| destination | written | injectable | approvals required |
|---|---|---|---|
| workspace (crosses a boundary) | 120 | 0 | **120** |
| session (stays in its conversation) | 120 | 0 鈫?**120** | **0** |

### Changed

- **A conversation-scoped write is trusted without a click**, controlled by
  `autoVerifyConversationMemory` (default on, reversible in config).
- **Promotion re-opens the gate by construction.** There is no separate "promote" rule that could
  drift: changing an entry's scope makes `sameScope` false on the next write, which drops it back
  to `candidate`. A fact that travels has to earn the trip.

### Not changed

- **Instruction-shaped text is still excluded entirely.** The layer model relaxes *who approves*,
  never *what may be injected*: a memory that reads like an order lands `disputed` in every
  scope, and the prompt section stays `interpolate: false` with its "never instructions" note.
- The quote gate is untouched. Grounding still buys a boundary crossing; it is simply no longer
  the only way in.

### Why this is the right trade

The old rule was defensible and wrong: it treated every memory as if it could reach everything.
The measured consequence was not extra safety, it was zero memory 鈥?thirteen entries nobody could
review, one entry in the prompt, and a `Latest` line frozen for ten releases. Safety that makes
the feature inert is not safety.

267 tests, coverage lines 88.6 / branches 69.5 / functions 81.7.

## [4.2.0] 鈥?2026-11-16

Rules propose; a model decides. S3 of the v4 architecture.

### Why the rule extractor is no longer the decision

Measured (`scripts/eval-memory.mjs`, part B) on eight transcripts: the rule extractor scores
**100% precision and 50% recall**. It never fires on chatter or on questions 鈥?and it misses half
of what a careful reader keeps: `浠ュ悗閮ㄧ讲鍏堣蛋鐏板害`, `绾﹀畾鍙戝竷绐楀彛鏄懆涓塦, `姘歌繙涓嶈鍦ㄥ懆浜斿彂鐗坄.
It is safe and blind, which is a fine property for a filter and a bad one for a judge.

### Added 鈥?`src/host/record/`

- **`prefilter`** 鈥?deliberately permissive. Its only decision is that a question cannot be a
  constraint; everything else is handed on. Measured: **prefilter recall 100%** against the same
  corpus, so a model sees every durable sentence the rules missed. If it dropped them, the
  layering would be decorative.
- **`CURATOR_CONTRACT`** 鈥?the shape the model must return, kept in code so it cannot drift from
  the parser: one JSON object, `keep`/`drop`, `evidenceQuote` copied verbatim.
- **`parseCuratorReply`** 鈥?the model's reply is untrusted input that will be written to a store
  and later injected into a prompt, so every field is validated: unknown kinds rejected rather
  than coerced, sizes checked against the store's limits, and an `evidenceQuote` that is not
  verbatim in the transcript drops the item. A fenced JSON block is tolerated, because discarding
  a correct decision over a formatting mistake loses real memory.
- **`createCurationTrigger`** 鈥?the "sleep" half: one pass when a conversation is disposed.
  Refuses delegated steps (a subagent's transcript is working state, not testimony), spends no
  model call when there is nothing to read, and cannot throw into a disposal path where nobody is
  left to catch it.
- **`curatorMode: 'off' | 'session-end'`**, default `off`. The transport reuses the existing
  `llm` injection and `completeViaHost` 鈥?one model route, two consumers 鈥?and the dispose
  listener is registered whenever that route exists, so enabling the mode later takes effect
  without a reload.

### Trust

A curated item is written through the ordinary path, with no privileged door: the same quote gate
a tool-supplied quote passes, the same audit trail. Grounding in the user's own words is the trust
signal, not a click 鈥?an item whose quote is verbatim lands `verified`; anything else lands as a
`candidate` and waits for a person.

### Fixed

- `evidence` was passed as a bare quote string, so the gate read `evidence.quote` as undefined and
  **every curated item silently became a candidate** 鈥?indistinguishable from "the model judged
  nothing". It is `{quote, sessionId}` now, and a test pins the difference.

---

265 tests, coverage lines 88.6 / branches 69.4 / functions 81.7. `curatorMode` stays off, so this
release changes no behaviour until it is switched on.

## [4.1.0] 鈥?2026-11-16

The memory manager can no longer be shaped by the memory it manages. S2 of the v4 architecture.

### The constraint

A conversation that curates, merges, verifies or deletes memories must never have those same
memories injected into its own prompt. Otherwise it judges the content through a prompt the
content already shaped 鈥?a closed loop whose bias is invisible from inside.

Its access to memory is the tools (`loci_search`, `loci_get`, `loci_write`). That is reading.
The prompt section is the thing that would write into it.

### What was wrong before

The property held **by accident**. `resolveContext` returned `undefined` when
`delegationDepth > 0`, so a manager implemented as a subagent was never injected 鈥?but that is a
fact about how the manager was launched, not about what it is. A manager running as a top-level
session would have received the full section and nothing would have reported it.

An invariant that holds by coincidence is not an invariant.

### Changed

- **`injection_exempt` (schema v6)** 鈥?a stored table of sessions that receive no memory
  section, with the reason recorded. Stored rather than inferred so a restart, a resume, or a
  different code path cannot lose it.
- **Both injection surfaces consult it**: the per-request section and the once-per-session recall
  assist. Covering only the section would have left the manager shaped by the assist, which is
  the same failure through a side door.
- **The manager receives nothing at all** 鈥?not even the "N more entries in scope" pointer. A
  pointer is a hint about the corpus, and the point is that the manager's view of the corpus is
  not the model's view of it.
- `dsh-loci exempt --session <id> [--reason <text>] [--allow]` to declare or lift the exemption,
  and `dsh-loci exempt` with no session to list them.

### Note on the check

`scripts/check-swallowed.mjs` now also flags a fabricated newline before a comment
continuation. Those are harmless where they land, but they mean the file was edited by the
mechanism that produces the harmful case 鈥?and it found one in the CLI help text that had been
there for several releases.

---

245 tests, coverage lines 88.3 / branches 69.2 / functions 81.6.

## [4.0.0] 鈥?2026-11-16

The section is composed per question instead of being a fixed list. This is the first release of
the v4 architecture (`docs/ARCHITECTURE-V4.md`).

### Changed 鈥?what the model is shown

The memory section used to be a fixed index of the first N entries: **the same bytes on every
request**, whatever the store held and whatever was being asked. Measured with a 40-fact corpus
that grew to 600 (`scripts/eval-memory.mjs`):

| store | section | entry in section | reworded question found | reworded: nothing at all |
|---|---|---|---|---|
| 40 | 3278 B | 87.5% | **0%** | 92.5% |
| 200 | 3281 B | 17.5% | **0%** | 92.0% |
| 600 | 3281 B | 12.2% | **0%** | 91.7% |

The new section has three parts, each with a job:

- **core** 鈥?rules and pinned facts only, hard 500 B cap. What a person would put on a sticky
  note. (A first draft also admitted every `semantic` entry ordered by recency, which put six
  pieces of unrelated filler at the top of the prompt under the heading "Always applies".)
- **slice** 鈥?entries retrieved from the user's current message, capped at 1200 B. Two tiers: a
  strict pass requiring a contiguous 3-character run (the same admission the full search uses,
  which is what keeps precision), and a loose pass that only runs when the strict pass returns
  nothing.
- **pointer** 鈥?`>N more entries in scope; loci_search looks them up.` Without it a slice looks
  like the whole store and the model never thinks to search.

Same corpus, same questions, after:

| store | section | entry in section | reworded question found | reworded: nothing at all |
|---|---|---|---|---|
| 40 | 932 B | 100% | **70.0%** | **0%** |
| 200 | 969 B | 100% | **62.0%** | **0%** |
| 600 | 966 B | 100% | **60.1%** | **0%** |

Bytes fall ~70%, natural-phrasing recall stops degrading as the store grows, and a reworded
question goes from never found to found about two thirds of the time.

### Fixed

- **The section could be empty exactly when it should have spoken.** The early return fired when
  the core and slice were both empty, so "the store holds an entry you did not match" produced
  byte-identical output to "there is no memory at all" 鈥?the one case the pointer exists for.
  Silence now requires an empty store *and* nothing pending.
- **The loose tier scanned the newest 400 rows.** The window filled with whatever was written most
  recently, so an older matching entry was never examined; found-rate fell to 18% at 600 entries
  with half the questions matching nothing. The filter is in SQL by term now.
- The pending-review notice is carried into the new section. Dropping it would have removed the
  only line that distinguishes "you never saved that" from "I saved it and it is waiting for you".

### Added

- `recallMode: 'slice' | 'index'`, default `slice`. `index` keeps the previous behaviour as a
  rollback, and one test pins it so the old path cannot rot unnoticed.
- `Capture.lastUserText(sessionId)` 鈥?a prompt section's `text` receives only `{scope, signal}`
  and cannot see the conversation, so the question has to be handed in. Capture already buffers
  user messages and does so regardless of `captureMode`.

### Known limitation, measured not assumed

About 40% of reworded questions still miss at 600 entries, and no admission threshold fixes it:
`atlas 瑕佸彂鏂扮増鏈琡 and `atlas 鏈嶅姟涓婄嚎鍏堣蛋鐏板害` share exactly one token. Semantic retrieval needs
an embedding channel (`vectorMode` exists, the recall path does not use it yet).

238 tests, coverage lines 88.2 / branches 68.9 / functions 81.4.

## [3.9.0] 鈥?2026-11-16

`doctor` can now answer "is memory actually reaching the model".

### Added

- **An `injection` row** reporting the last prompt assembly: bytes, entries listed, when, and
  which surface produced it, plus how many entries are verified and how many await review.
  Every other row reported storage; none reported delivery, so the question was answered by
  writing a diagnostic script. Zero bytes with verified entries present is reported as `fail`,
  not as a quiet empty state.

- **A `review queue` row** for a dead end that took a hand-written probe to find: the capture
  layer records episodic session summaries, review covers `rule`, `semantic` and `procedural`
  only, so on a live store with 13 candidates the Review tab stays empty forever and nothing can
  ever be promoted. The row says so in those words.

### Why this matters more than a missing row

Running it on the live store produced an uncomfortable answer, recorded here rather than only
in the log:

```
[ok]   injection: 323 bytes, 1 entry listed at 2026-11-15 17:22 (section) 路 1 verified 路 0 awaiting review
[warn] review queue: 13 candidates can never be reviewed: they are captured session summaries
       (episodic) and review covers rule, semantic, procedural only 鈥?so nothing here can be
       promoted into the prompt
```

One entry has ever reached the prompt, and it is a fact invented for an end-to-end test. The
card's `Latest` line reads `/knowledge`, which filters `status = 'verified'`, so it has been
frozen on that same line for every release since 鈥?not a caching bug, but the only verified
entry there is.

This release does not fix that; it makes it visible. The fix is a change to when a human must
approve, which is a decision about the product's central claim, not a patch.

## [3.8.0] 鈥?2026-11-16

Memory now has an explicit boundary per conversation, and stops sharing by default.

### Changed

- **A write with no explicit scope no longer lands in the whole workspace.** The old rule was
  `workspace`, which is right only when one directory holds one project. On `invictus` the
  directory `default-workspace` carries six independent repositories
  (`alicat-flow-console`, `codex-advisor`, `dsh-loci`, `dsh-multiview`, `ustc-quota-plugin`,
  `winmedic-skill`) and is not itself a repository, so every session opened there reported the
  same cwd and shared one bucket. Measured before the change: five sessions had injected
  182,868 bytes together, the gas-flow-control session carried 13,243 of them over 41 calls,
  and a fact written by a throwaway test session reached `inject_count` 326.

  The new rule is `auto`: **the project when the directory really is inside one, otherwise
  this conversation.** Switching the default to `project` alone would not have helped 鈥?the
  project search finds nothing here, which is exactly why the fallback is `session` and not
  `workspace`.

- **The read set is unchanged**: session + workspace + project + global. Nothing already
  stored became invisible; what changed is where new writes go.

### Added

- **A memory-boundary selector in the panel**, next to the title. It reports the mode in force
  and, for `Automatic`, the scope it resolved to 鈥?because "Automatic" alone does not tell
  anyone where the memory actually goes. Choices: automatic, this project, this conversation
  only, whole workspace, everywhere. The choice is stored per session and survives restarts.

- `GET`/`POST /api/loci/scope`. The panel is global chrome with no session of its own, so both
  act on the conversation the Host last assembled a prompt for.

### Schema v5

- `session_scope(session_id, mode, updated_at)` 鈥?the remembered choice. `auto` is stored as
  the absence of a row, so a future default change is not masked by a stale "auto" row.
- `request_stat.cwd` 鈥?the directory each assembly served. A scope key is a hash and cannot be
  reversed, so without this a surface outside the session could not resolve the same scopes.
  Rows written before v5 have `NULL` and report `directoryKnown: false` until the next request.

### Fixed

- `readScopeKeys` no longer repeats a key. A non-repository directory maps `project` and
  `workspace` onto the same path, and a repeated key made every downstream count report double.
- Auto-captured episodic summaries follow the same boundary as an explicit write. They were
  pinned to `workspace`, which put one product's conversation summaries in another product's
  bucket 鈥?harmless for the prompt (captures are candidates and never injected) but wrong in
  the panel and the export, where they read as shared facts.

### Note

The automatic rule is a judgement, not a measurement: "this directory is inside a repository"
is evidence of a project boundary, and its absence is *not* evidence that everything belongs
together. When the evidence is missing the fallback is the narrow scope, and widening it is one
click.

## [3.7.0] 鈥?2026-11-16

The panel was unreadable, and one of its views had been blank since a bad patch.

### Fixed

- **The detail view rendered nothing, and had for several releases.** A patch that meant to
  insert a newline wrote the two characters \n instead, so a comment and the statement after
  it became one physical line: `const entry = ...` was inside the comment. The component then
  threw on its first reference to `entry`, React unmounted it, and clicking the row's arrow
  showed an empty panel. It compiled, and every gate passed.

  `scripts/check-swallowed.mjs` now fails on that exact signature, and `npm test` runs it
  first, so the class of bug cannot come back silently.

- **The panel was a notch smaller than its neighbours.** Measured from the installed
  plugin-manager stylesheet: page title 20px, group and card titles 14px/500, descriptions
  13px, buttons 13px, status tags 10px, hints 12px, column 960px. Memory had a 14px title,
  11px meta, 12px snippets, 11px pills and an 860px column. All of it now matches.

### Changed

- **A row is clickable as a whole.** Only a small arrow at the right edge opened the detail
  view, which made the arrow read as decoration next to a dead row.

- **The Feed tab explains its own tags.** "I don't understand anything in here 鈥?what does
  added/verified mean, does it mean it entered memory?" is a fair reading of a bare tag, so
  the tab now opens with one line per state:

  | tag | meaning |
  |---|---|
  | `added` | saved, but the model cannot see it yet |
  | `verified` | approved by a person, so it is in the model's prompt |
  | `disputed` | marked wrong, kept in history, never injected |

- **The sidebar mark is the quill, everywhere.** It had been a quill on the card and stacked
  layers in the menu; asked to unify I unified onto the wrong one. The quill is what the
  product is for, so the menu, the card and the collapsed rail all draw it now.

### Added

- `scripts/shot-panel.mjs`: renders the panel from the real stylesheet, because the blank
  detail view is exactly the kind of defect a passing test suite does not show.

## [3.6.0] 鈥?2026-11-15

One product, one mark.

### Fixed

- **The sidebar menu and the footer card drew two different symbols.** The menu showed a
  layers glyph, the card showed a leaf, and both are visible at the same time. The layers
  glyph is the one already tuned to the native menu's optical weight (3鈥?1 inside a 24 viewBox
  at stroke 1.8), so it became the product's single mark: `LociMark` now owns the path data and
  the menu, the card and the collapsed rail all render it, differing only in size.

  The rail variant had a third symbol 鈥?three horizontal lines with a dot 鈥?which is gone too.

### Added

- `scripts/diag/scope-sharing.mjs`: reports which session wrote each entry and which sessions
  received it. Written to answer "is this memory per-conversation or shared?" with the database
  instead of with a description of the code.

  The answer, from the live store: **shared within a directory.** An entry written in session
  `db604d73` was injected into `317525bd` and `3e48f83b`; entries written in `317525bd` were
  injected into `4c45fb3c`. All four sessions sit in `default-workspace`, and every entry is
  stored under one key, `workspace:d9d179cb鈥.

## [3.5.0] 鈥?2026-11-15

The CLI could not tell "nothing to review" apart from "wrong directory".

### Fixed

- **`dsh-loci review` printed `candidates 0 路 disputed 0` without saying which scope it
  looked at.** `review`, `verify` and `stats --session` resolve their scope from
  `process.cwd()`, which is correct for a terminal command 鈥?it describes the directory it
  runs in. But the output never named that directory, so the same command returned `0` from
  the repository and `5` from the workspace, and both looked like an answer.

  Observed for real while verifying an entry: five candidates in the store, `review` said
  zero, and the difference was only the directory. The scope is now printed, and `--all`
  shows every scope from anywhere.

### Found while verifying the injection chain

The full chain was exercised end to end for the first time, with a real model tool call in a
fresh session:

1. the model called `loci_write` with an `evidenceQuote` that is **not** verbatim in any user
   message 鈫?the entry landed as `candidate`, which is the gate doing its job;
2. `dsh-loci verify --id` promoted it to `verified` 鈥?the human step;
3. the next prompt assembly carried the entry: `section_bytes = 323`, `entries_listed = 1`,
   `memory_usage.inject_count = 1`, and the rendered section contained
   `- m_01M7鈥?路 procedural 路 2026-11-15 路 鍥炴粴绐楀彛鏄笁鍗佸垎閽焋.

Before verification the same surface carried 354 bytes of pending notice with `listed = 0`,
so the two states are distinguishable rather than merely non-zero.

### Added

- `scripts/diag/live-store.mjs` and `scripts/diag/render-section.mjs`: print the live store
  summary and the exact section the model receives. Both are read-only and exist because
  "0 bytes" and "the entry is there" were being argued about instead of looked at.

## [3.4.0] 鈥?2026-11-15

The index-byte bar had no visible track.

### Fixed

- **The bar's track was one theme layer step**, `--dsw-alias-bg-layer-2` against a
  `--dsw-alias-bg-layer-1` card 鈥?#f1f1f4 on #ffffff, which is almost nothing. The bar read
  as a floating blue sliver: you could see how much was used and not what the whole was, which
  is the only reason a bar beats a number here. The track is now `--dsw-alias-border-l1` with
  an inset ring, and the groove is 5px so the unfilled part is legible.
- A non-zero section gets at least a 2% fill so a nearly-empty index still shows *something*
  against the groove rather than looking empty.

## [3.3.0] 鈥?2026-11-15

R23 and R24: the card now describes *this* conversation, and the panel explains itself.

### Fixed 鈥?R23: the card showed the whole store

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
  assembly, and falls back to every stored scope when nothing has been assembled yet 鈥?with
  no history there is no "current", and saying "everything" is the honest answer.
- `/api/loci/stats` and `/api/loci/knowledge` default to it. `?all=1` keeps the admin view,
  and an explicit `?cwd=` / `?session=` still wins.

**Known limit, stated rather than hidden:** switching conversations without sending a message
leaves the card showing the previous conversation's scope, because nothing has been assembled
for the new one yet. It is a summary of what the agent was last given, which is what it says
on the tin.

### Fixed 鈥?R24: the panel did not explain itself

Five tabs, one of which said what it was for. The first complaint about the panel was
literally "I don't know how to review". Now:

- every tab opens with one line of purpose, in the same place the Feed tab already used;
- every row action carries a `title` that says what it does rather than what it is called 鈥?  *"Approve: this entry can now be injected into the prompt"* rather than "Verify",
  *"Mark as wrong or unsafe: kept in history, never injected"* rather than "Dispute".

## [3.2.0] 鈥?2026-11-15

The sidebar was sending people to an empty room. Found in the live store, not in a test.

### Fixed

- **"N item(s) waiting for you in Review" counted rows Review hides.** The card read
  `stats.pendingCandidates`, which counted every candidate and disputed row in scope; the
  Review tab lists only the kinds that can reach the prompt (`rule`, `semantic`,
  `procedural`). Episodic session summaries are candidates *by design* 鈥?they are history,
  not claims 鈥?so on a normal day the entire count was composed of rows Review deliberately
  excludes.

  Live evidence, after one afternoon of use: **3 pending rows, all `episodic`**, and the
  sidebar offering to review them somewhere it would not. The count is now `0` and Review
  shows `0`.

  `REVIEWABLE_KINDS` is one exported list. `countPending`, `stats.pendingCandidates`,
  `stats.disputed` and the panel's request all use it, so the badge and the list cannot drift
  apart again. `byStatus` stays complete 鈥?that is a data view, not a to-do.

- **`stats.pendingCandidates` ignored `valid_to`** while `countPending` honoured it, so a
  candidate closed by maintenance stayed in the badge. Both now exclude expired rows.

### Why this matters beyond the cosmetic

The card was telling the user to do something that could not be done, which reads as "the
tool is broken" rather than "there is nothing to do". A number with a door is a promise.

### Not fixed, recorded

Episodic summaries still accumulate as candidates and are only removed by the 30-day
candidate TTL. They are visible in the Feed tab, which is where history belongs, but nothing
says so. That is part of R24 (the panel explains almost nothing about itself).

## [3.1.0] 鈥?2026-11-15

Four things from looking at the live sidebar and panel.

### Changed

- **The sidebar icon now has the same weight as the menu it sits in.** Native
  `sidebar.panellist` entries receive `{ size, active }`; this one used `size` correctly but
  drew inside 4鈥?0 of a 24 viewBox with a small off-centre dot, so beside the shipped icons
  it read thinner and smaller. Redrawn as a symmetric **layers** glyph spanning 3鈥?1 at
  stroke 1.8 鈥?the optical weight of its neighbours, and a shape that says layered memory.

- **The panel is a readable column, not edge-to-edge text.** The scroll container's
  horizontal padding became `max(16px, calc((100% - 860px) / 2))`, so rows sit in a centred
  measure on a wide window without touching any tab component.

- **"N item(s) waiting for you in Review" is now a way in.** It was a sentence telling a
  person to go somewhere else and find the tab. It is a button: it opens the panel already
  on Review. The card and the panel mount separately, so the request travels through module
  scope and is consumed once.

- **The card says what it knows, not only how much.** Commit `4065c98` (2026-11-13) recorded
  the brief for this surface: *"not a dashboard 鈥?read the card and think 'it got that, it
  recorded that, we agreed on that'"*, with one short paragraph of what the agent
  understands in this project and pending work as one quiet line, never a number. 3.0.0
  replaced that paragraph with counters. The counters stay 鈥?they were asked for and they
  are useful 鈥?and one line of content goes back under them: a `Latest` row showing the most
  recently trusted entry, from `GET /api/loci/knowledge?limit=1`.

### Not changed

- `docs/PRIOR-ART.md` still records that the card should be scoped to **this project's read
  set** rather than every scope. It currently is not: `/stats` and `/knowledge` called
  without parameters enumerate the whole store, and the sidebar card has no access to the
  session's cwd. Scoping the card is a real open item, not something to assert.

## [3.0.1] 鈥?2026-11-15

The 3.0.0 card was correct markup with no stylesheet, and the screenshot showed it.

### Fixed

- **The card was never styled outside the panel.** Every `.loci-*` rule lives in one CSS
  template string that only `MemoryPanel` and `SettingsSection` render as a `<style>`
  element. In the sidebar, with the panel closed, no `<style>` existed 鈥?so the card's DOM
  was right and its layout was simply absent. That is what "bare text in the sidebar"
  looked like, and it predates 3.0.0: the first screenshot showed it too. The card now
  renders the stylesheet itself, and so does its rail variant.

- **`card.pending` was defined twice.** The old value was the sentence
  `'{n} still need your review'`; 3.0.0 added a bare `'Pending'` label for the metric row,
  and the later definition won 鈥?so the card printed the sentence with an unsubstituted
  `{n}`. The sentence is now `card.pendingSentence` and the label stays `Pending`.

- **The version chip rendered as `v3. 0. 0`.** The chip used
  `ui-monospace, SFMono-Regular, Menlo, monospace`, which on Windows falls back to a
  monospace face whose period is centred in a wide advance; at 8.5px that reads as gaps
  between the digits. Measured with `getComputedStyle`: `letter-spacing: normal`,
  `word-spacing: 0`, width 25.50 鈥?the spacing was correct, the **glyph** was not. The chip
  now inherits the UI font with tabular figures, at 9px.

### Added

- **`scripts/shot-card.mjs`** renders the sidebar card to a PNG using the stylesheet
  extracted from `client.js` and the DOM the component produces, through headless Edge. It
  cannot catch a logic mistake, only a drawing one 鈥?but a drawing mistake is exactly what
  shipped twice, and a screenshot is the only review that shows it.

### Not added

Four guard files from the previous draft (a separate client-i18n test, an English-only test,
a CSS-shape assertion and a manifest check) were collapsed into **one** test file and one
manifest assertion. Guards that outnumber the behaviour they protect get deleted by the next
person, which is worse than not having them.

### Corrected in the record

The 3.0.0 log entry said the card had been verified. It had not been looked at. The entry
above records what the screenshot showed.

## [3.0.0] 鈥?2026-11-15

The sidebar card was not a card, and the plugin had a second language it did not need.

### Changed 鈥?the card

The screenshot that prompted this showed three plugin cards in a row: two with white
rounded shells, a status dot, a version chip and numeric rows; one 鈥?this one 鈥?as bare
text on the sidebar background, two sentences of prose and nothing clickable.

The difference was measurable, not aesthetic. `dsh-ustc-quota`'s shell carries
`box-shadow: 0 3px 12px`, `flex: 0 0 100%`, `order: 1`, `grid-column: 1 / -1`,
`border-radius: 12px` and `font-variant-numeric: tabular-nums`. This card had none of them,
so it sat in the same visual plane as the sidebar and looked like a note pasted over it.

Now:

- **Shell** 鈥?the same box model the neighbouring plugins use, so three cards in one column
  read as three cards.
- **Header** 鈥?title, a dim monospace version chip, a 5px status dot (brand / warn / error),
  and a right-aligned `updated <time>` that truncates instead of wrapping.
- **Numbers** 鈥?`Verified / Pending / Disputed` in a three-column grid, tabular figures,
  amber for pending and red for disputed.
- **Budget** 鈥?a thin bar of index bytes against `sectionMaxBytes`, turning amber past 85%.
- **Usage** 鈥?`Injected / Opened / Dead` (the last one only when non-zero), which is the row
  that makes schema v2's counters visible where a person will actually see them.
- **Empty state** 鈥?one line and one instruction instead of two sentences of apology.

This reverses the earlier "a page of notes, not a dashboard" stance *for this surface*. The
audit had already called that stance out: an aesthetic refusal to interrupt, applied to the
one place where a person must act. The panel keeps the prose; the card gets the numbers.

### Changed 鈥?one language

Chinese was not in the client because anyone chose it; the client shipped a full `ZH`
dictionary, so a browser whose locale resolved to `zh` rendered the UI in Chinese. The
English dictionary was already complete. The second dictionary was the only reason the
product had a language at all.

- `client.js`: the 128-line `ZH` dictionary is gone, the locale registration is `{ en: EN }`,
  and four Chinese comments are rewritten.
- `locale/zh.json`: deleted; `locale/en.json` is the only locale file.
- `package.json` / `manifests`: no longer advertise a second language. `README.md` loses the
  `璁板繂瀹` gloss and the `鏇存柊浜巂 label description; the Chinese *examples* of stored
  content stay, because they demonstrate CJK retrieval.
- `scripts/capture-panel.mjs`: its panel selector matched `璁板繂|Memory` and can only ever
  match the latter now.

Kept, deliberately: the Chinese regexes in `capture.js` (they match Chinese input) and in
`sanitize.js` (they match Chinese prompt-injection phrasings). Deleting those would disable
the features for the language most of the user's memories are written in. They are pattern
data, not output.

### Added

- `test/unit/client-i18n.test.mjs` 鈥?no Chinese in `client.js`, no `ZH` dictionary, no
  `locale/zh.json`, every `t()` key defined, and the card still has its shell/metric pieces.
- `test/unit/english-only.test.mjs` 鈥?no Chinese in emitted strings under `src/` outside a
  two-file allowlist, and the allowlisted files must still contain their patterns (a guard
  that silently allows a file would hide the deletion it exists to catch).
- `scripts/check-manifest.mjs` now **fails if `locale/zh.json` reappears**, so the language
  cannot come back in a version that never touched `client.js`.

### Still Chinese, on purpose

`README.zh.md`, `docs/*.md`, and the `titleZh`/`descriptionZh` fields in
`marketplace/entry.json` are documentation and storefront metadata, not output the plugin
emits at runtime. They were left alone rather than deleted; if they should go too, that is a
separate decision about the deliverable, not about the product's language.

## [2.11.0] 鈥?2026-11-15

One fix, made because it is the last thing that could put another project's facts into a
conversation.

### Fixed

- **A session with no `cwd` borrowed the Host process directory as its scope.**
  `resolveScopes` fell back to `process.cwd()` whenever the host did not supply
  `session.header.cwd`. Every such session and every panel request therefore shared one
  workspace key 鈥?the directory the Host process was started in, which for a packaged
  install is the install directory. Two consequences: memories written there belonged to no
  project, and any two cwd-less sessions could read each other's entries.

  A missing cwd now yields an explicit `workspace:unresolved` / `project:unresolved`. It
  collides with no real workspace, appears in no other session's read set, and the panel
  labels it "unresolved workspace" 鈥?visible rather than quiet.

  The trade is deliberate: a cwd-less session loses access to workspace memories instead of
  being handed someone else's. That is the direction the I4鈥?invariant points.

### Docs

- `PRIOR-ART.md` I4鈥?and its expiry table said the process-cwd fallback was "a known risk,
  not a guarantee". It is now a stated behaviour with a test, and the remaining half of that
  risk (project-scope collapse past 12 ancestor directories, no `doctor` check on scope
  identity) is named as still open.

## [2.10.1] 鈥?2026-11-15

Three more ways a scope mistake could have answered with the wrong data. Found by checking
the last unverified claims from the audit instead of trusting the previous pass.

### Fixed

- **`/api/loci/preview?cwd=鈥 returned 400.** The route read `resolved.readKeys` and
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

## [2.10.0] 鈥?2026-11-15

The last four findings from the audit. All four are the same shape: an operation that
trusted an input it should have checked.

### Fixed

- **`snapshot --label` could write outside the memory root.** The label came from the
  command line and was joined straight into a path, so `--label ../../tmp/x` produced a
  database outside `$DSH_HOME/memory/loci/`. `SECURITY.md` said `assertInside` guarded
  every generated path; this one was not guarded. The label is now reduced to a filename
  *and* the resolved path is asserted.

- **`loci_get` and `loci_forget` ignored the scope set.** Every read in the product binds
  an explicit scope-key set except these two, which took an id and used it 鈥?so an id
  pasted from another project's chat returned that entry's body, or soft-deleted it. Both
  now refuse an entry outside the session's read set. A miss and a foreign hit answer the
  same way, so the refusal does not confirm what exists elsewhere.

- **An MCP write with no scope pooled in `session:unknown`.** `readScopeKeys(scopes, {
  scope: undefined })[0]` is the *session* key, and a facade has no session 鈥?so every MCP
  server on the machine shared that one key while no Host session ever read it. Proposals
  were invisible to the review tab. A scope-less write now lands in the workspace the
  facade is serving.

- **Capture turned ordinary sentences into verified rules.** Bare `鍒玚 matched inside
  绾у埆, 鐗瑰埆, 璇嗗埆, 鍖哄埆 and 鍒嗗埆, and `瑕佷笉瑕佲€︼紵` matched the 涓嶈 rule. Measured before
  the change: *"鎴戠壒鍒兂鐪?diff"*, *"涓よ€呭尯鍒笉澶э紝闅忎究閫?*, *"鎴戜滑鍒嗗埆璇曚簡涓ょ鏂规"*,
  *"璇嗗埆杩欑被閿欒瑕侀潬鏃ュ織"*, *"杩欎釜 bug 鐨勭骇鍒槸 P1锛屽厛澶勭悊瀹?* 鈥?five false positives, each
  of which becomes a `verified` line in `Rules (must follow)` with the default
  `autoVerifyCaptured`. An imperative must now open a clause, and a sentence ending in `锛焋
  is never a statement.

  Verified against 8 negatives (all rejected) and 10 positives (all captured with the right
  kind: 浠ュ悗閮界敤鈥? 涓嶈鍐嶆敼鈥? 鍒妸瀵嗛挜鈥? 绂佹鈥? 蹇呴』鍏堚€? 鎴戜滑鐨勭害瀹氭槸鈥? 璁颁綇鈥? 鍙戝竷娴佺▼鏄€? 浠ュ悗涓€寰嬧€? 涓嬫鍒€?.

### Docs

- `DESIGN.md` said "every captured row is a `candidate`". That stopped being true when
  `autoVerifyCaptured` shipped and the sentence survived several releases; it now states the
  two doors into the prompt and what the flag controls.

## [2.9.0] 鈥?2026-11-15

R3 was the last rule the product stated and did not keep.

### Fixed

- **The recall assist was not reproducible.** R3 requires the conditional path to evaluate
  over a reproducible snapshot: the same session replayed must produce the same result, and
  the outcome must not drift with a moving clock. `search` already accepted a `now` for its
  recency term and its time-window filter 鈥?but `renderAssistBlock` never passed one, so it
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

All five rules in 搂2.1 of `docs/PRIOR-ART.md` are now marked against the code 鈥?R1 and R2 as
written-down exceptions, R3 and R4 as enforced since 2.9.0 and 2.8.0, R5 as always true.
Two of the five were violations when the audit found them, and both were fixed rather than
re-worded.

## [2.8.0] 鈥?2026-11-15

Two real defects, both found by measuring rather than reading: search returned nothing for
normal questions, and the one conditional injection path recorded nothing at all.

### Fixed

- **`loci_search` returned nothing for sentences.** A CJK run is matched as an FTS5 phrase,
  which requires it to appear contiguously 鈥?so one word the store had never seen zeroed the
  whole query. Measured: `鍥炴粴绐楀彛` found the entry, `鍥炴粴绐楀彛澶氫箙锛焋 found nothing. People
  type sentences, so this made the tool useless for its main use.
  Two changes: the run's bigrams are also offered as individual OR terms, and admission now
  accepts a **contiguous** stretch of 鈮? characters instead of requiring the whole run.
  A 2-character stretch needs to be a non-hub token *in the title*, which keeps the original
  false positive out 鈥?`瀹屽叏鏃犲叧鐨勯棶棰榒 used to be admitted by an entry whose body happened to
  contain `闂`.

  Effect on `scripts/acceptance-v2.mjs`, same 30 facts, same questions, no corpus change:
  **lexical top-1 went 0/30 鈫?8/30, top-3 0/30 鈫?9/30.** The remaining 21 misses share no
  bigram at all with their target 鈥?a genuine vocabulary gap that no lexical method closes,
  which is why the index is the primary channel.

- **`recallAssist` recorded nothing.** The only conditional injection in the product wrote no
  `request_stat` row, bumped no per-entry counter, put no ids in the audit line, and did not
  even pass a session id to its own search 鈥?so the panel could not answer "why did this
  entry appear in that session", which is the project's own R4 rule. `renderAssistBlock` now
  returns `{text, ids, bytes}`, and the injection is recorded with `source: 'assist'`, its
  ids, and the usual per-entry counters. Recording failures are caught: a logging problem
  must never break the turn it is recording.

### Schema

- **v4** adds `request_stat.source` (`section` | `assist`), with the migration marking
  existing rows `section` 鈥?which is what they were, since nothing but the index wrote to
  that table before. `ALTER TABLE 鈥?DROP COLUMN` re-parses the stored statement, so the
  column's comment lives outside the `CREATE TABLE` body.

## [2.7.1] 鈥?2026-11-15

A correction, and a decision not to ship something.

### Corrected

2.7.0's acceptance note said the index does not scale 鈥?"arm C asked for 12/12 ids, so at 200
entries the model pulls the whole store". **That was wrong, and the error was in the
experiment.** Arm C asked **12 questions about 12 different entries**; fetching 12 bodies is
the correct answer to 12 questions. Concluding "it over-fetches" from `questions == fetches`
was a mistake in the arm's design, not a property of the product.

The fair version 鈥?**one** question against many candidates:

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
resource 鈥?a sentence that changes no behaviour is pure cost.

The lesson is worth more than the fix would have been: **a measurement that counts fetches
against questions must keep those two numbers independent.** `docs/ACCEPTANCE.md` now carries
the correction in place, rather than quietly deleting the wrong claim.

## [2.7.0] 鈥?2026-11-15

The acceptance was measuring less than it claimed. This release re-runs it properly and
writes down the answer, including the part that is uncomfortable.

### The measurement

`scripts/acceptance-v2.mjs` 鈥?30 facts, each question written so it shares **no character
bigram** with its target title (checked, not assumed). Seeded into a throwaway store, never
placed where the model could read it.

| Channel | Result |
|---|---|
| lexical search (`loci_search`) | **0/30 top-1 路 0/30 top-3 路 30 missed** |
| injected index | **30/30 present** |
| section cost | 0 entries 鈫?0 B 路 10 鈫?1,081 B 路 30 鈫?2,781 B |

Three blind answer arms on 20 questions about a fictional project whose facts exist nowhere
in this repo:

| Arm | Correct | Behaviour |
|---|---|---|
| no memory | **0/20** | answered `UNKNOWN` 20/20 鈥?abstained instead of confabulating |
| index only, titles carry the fact | **20/20** | exact values |
| index + fetch, titles are summaries | requested **12/12** ids | did not discriminate 鈥?pulled the whole index |

**What this means:** memory demonstrably changes answers (0/20 鈫?20/20 on identical
questions, nothing else varied). It also shows that a paraphrase with no shared vocabulary
is **invisible to lexical search 鈥?not degraded, zero** 鈥?so the index, not search, is the
channel that carries facts. And arm C is the warning: when titles are summaries, a model's
response to ambiguity is to fetch everything, which is fine at 12 entries and untenable at
200. Narrowing that is a design problem, not a formatting problem.

### Fixed

- **Two e2e checks were `record(..., true)`** 鈥?literal `pass: true`, structurally unable to
  fail. Replaced with real assertions on `lastInjection.bytes` and `listed`.
- `scripts/acceptance-v2.mjs` gives each store size its own home and asserts the seed count;
  the v1.0.0 harness created a scratch home and discarded it (`void scratch`) and called
  `seedCorpus(...).slice(count)`, which does not limit seeding.

### Docs

- `docs/ACCEPTANCE.md` rewritten into two clearly separated sections: 搂A the historical
  v1.0.0 record with the four defects that limited it, 搂B the 2.6.0 re-run. Where they
  disagree, 搂B wins.
- **Not measured, and stated as such**: whether the model answers correctly *inside a real
  DSH session* (the arms pasted the index into a prompt), tokens per answered question, and
  long-run queue behaviour.

## [2.6.0] 鈥?2026-11-15

The rest of the boundary audit: three silent-wrongness bugs, and the invariants rewritten
to say what the code actually does.

### Fixed

- **The review filter was ignored.** The panel sent `kinds=rule,semantic,procedural`
  while the route read `kind`, so every session summary appeared in a queue designed to
  exclude them. The route now accepts both spellings.
- **"N items await review" could never reach zero.** `countPending` ignored `valid_to`,
  so candidates closed by maintenance stayed counted in the injected notice forever 鈥?  a permanent nag that cost bytes and named rows no review list would show.
- **`/loci review` pointed at an operation that does not exist** (`loci_write op:"verify"`).
  Fixed by adding the door that was actually missing: **`dsh-loci verify --id <id>
  [--status disputed]`**. The tool surface still has no verify, on purpose 鈥?the model
  must never grant trust 鈥?but a terminal-only user could previously create candidates
  forever and never promote one.

### Changed

- **The invariants now state what is enforced, and when each one expires.**
  - I2 became **I2鈥?*: no write reorders or rewrites an existing line; re-evaluation
    happens at session/day boundaries only. The old "byte-identical with no writes" was
    false 鈥?the footer carries a date, so it changed daily by design.
  - I4 became **I4鈥?*: session reads bind an explicit key set; the panel and export
    enumerate every scope, which is an administrative view rather than a session read.
  - I1 no longer says "verified requires a human": it says the store derives status, and
    verified comes from a human action **or** a quote that is present and related.
  - R1 and R2 were rewritten because the project violated them: `recallAssist` selects by
    body text (now an explicit, bounded exception), and the pending count deliberately
    changes mid-session (now stated as an informed cost, not denied).
  - New **搂0.1** gives every invariant its category (structural / contingent /
    preference), what it depends on, and the event that should trigger re-evaluation.
    搂2.1 had expiry signals for the one thing the project *rejected* and none for the
    four things it *relies on*; that asymmetry is the most reusable finding of the audit.

- **PRIVACY said "two things can reach the network". It was three.** Session extraction
  sends up to 12 KB of conversation through the Host's own model service. Not a third
  party, but the count was wrong and the page now names all three. The prose test grew a
  check for the third path so the count cannot drift again.

## [2.5.0] 鈥?2026-11-15

The rest of the boundary audit: one real hole in the trust gate, one check that could
never fail, and a number that was being read as more than it is.

### Fixed

- **A real quote could certify an unrelated claim.** The gate asked only "did the user
  say this"; it never asked "is the claim about what they said". Quoting any real
  sentence 鈥?"濂界殑锛岀户缁惂" 鈥?was enough to launder a fabricated fact into the prompt.
  `evidenceSupports` was written for exactly this and had no caller. It is now part of
  the gate, and its threshold is **measured** rather than inherited: on Chinese text a
  legitimate paraphrase scores 0.083鈥?.364 and a laundered claim scores 0.000, so the
  bar is 0.05. The old 0.15 would have rejected "鐢ㄦ埛鍋忓ソ涓枃" from "浠ュ悗閮界敤涓枃鍥炲鎴?.

- **`loci doctor`'s host row could never warn.** It printed `[ok]` for any recorded
  version, including one outside `engines.dsh`. It now compares against the declared
  range and warns when outside, degrading to `ok` (not a failure) when the range cannot
  be parsed.

### Changed

- **The acceptance numbers are qualified, not deleted.** Every measurement in
  `docs/ACCEPTANCE.md` was taken on **v1.0.0**; the tree is 2.5.0. Worse, the
  acceptance question contains the entry title verbatim (`acceptance-e2e.mjs:94`), the
  corpus fixture is readable from the agent's workspace, and there is no no-memory arm 鈥?  so "49/50" measures lookup, not memory effect. The page now says so at the top and on
  the row itself. A re-acceptance on 2.5.x with held-out facts and a control arm is an
  open item, not something a doc edit can settle.

## [2.4.1] 鈥?2026-11-15

Three fixes from an independent boundary audit. All three were verified by running the
code, not by reading it.

### Fixed

- **The CLI bypassed the hard-delete gate.** `scripts/cli.mjs` constructed the store
  with `live: () => true`, so every gate that reads a live value evaluated to open:
  with `allowHardDelete: false` the store refused `purge` and the command deleted
  anyway, `--allow-hard-delete` was decorative, and a comment directly above the code
  said the opposite. Measured before and after. `test/integration/cli-gate.test.mjs`
  now runs the real command line, which is the surface that broke 鈥?the store-level
  test passed throughout.

- **The panel write route accepted a caller-supplied `status`.** `POST /api/loci/write`
  forwarded `status` verbatim and defaulted it to `'verified'`, which also skipped the
  instruction-like quarantine: instruction-shaped text sent through the panel landed as
  `verified` instead of `disputed`. The field is gone; every write goes through the
  store's derivation like the rest of the system.

- **`SECURITY.md` claimed a self-test probe that did not exist.** The T2 row said "a
  self-test probe keeps this honest" and the string `self-test` appeared nowhere else
  in the repository. Rather than delete the sentence, `loci doctor` now runs the probe:
  it renders hostile text (`{{鈥}`, a closing fence, a script tag, bare angle brackets)
  and fails if anything survives, and it checks that a known instruction shape is still
  detected.

### Note

The audit also found that the acceptance numbers are from **v1.0.0** while the tree is
2.4.x, and that the acceptance question contains the entry title verbatim 鈥?so the
"98% recall" figure measures lookup, not memory effect. That is a measurement problem,
not a bug, and it is not addressed in this patch; it needs a re-run, not an edit.

## [2.4.0] 鈥?2026-11-15

Three items from `docs/PRIOR-ART.md` 鈥?the systematic pass over what the field does
better, judged against this plugin's four invariants rather than by popularity.

### Added

- **Lesson shape (`pattern` / `fix` / `prevents` / `whenCondition`)**, schema v3. A
  lesson stored as free text is unreadable six months later: you remember the rule but
  not why it exists. `prevents` is where that answer lives, and it is the one clause
  appended to the index line for `procedural` entries 鈥?a rule without its consequence
  gets ignored. Ordinary facts render byte-identically to before, and the fields never
  raise trust.

- **`conflicts` / `extends` relations.** `memory_edge` has always had a `relation`
  column but only ever held `supersedes`, so every correction was a full replacement.
  Real corrections are partial 鈥?"the rollback window is 45 minutes now, but database
  changes still get 30" contradicts one clause and confirms another. Now a caller can
  declare a weaker relation, both entries stay readable, and `loci_get` shows the link.

- **Touched files in the episodic summary.** "Where were we last time" was a question
  this project had to answer by hand. File paths are now extracted from tool-call
  arguments and recorded on the session summary, which is never injected 鈥?so it costs
  the prompt nothing and only helps `loci_search`.

### Migration

Schema v2 鈫?v3 adds four nullable columns; no row can be lost and every existing entry
simply has no lesson shape yet. The integration test now walks the whole shipped chain
v1 鈫?v3 rather than a single step.

### Not done, on purpose

Auto-triggered injection (`when` matching decides what gets injected) stays rejected:
it breaks prefix stability and lets memory content decide its own admission. The
condition is **stored and shown, never used to select**. Recorded with the rest of the
rejections in `docs/PRIOR-ART.md` 搂2.

## [2.3.1] 鈥?2026-11-15

### Fixed

- **A corrupted line in the config schema.** `2.3.0` failed in CI at
  `.number().n .step(1)` 鈥?a patch script wrote a literal `.n` where a newline was
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

## [2.3.0] 鈥?2026-11-15

The last open item from the blind review, and the one a heavy daily user called the
biggest product hole: between "deterministic rules" and "ask the model every turn"
there was no middle. Per-turn extraction asks for one review decision per turn until
the queue is abandoned; rules alone miss anything stated in passing.

### Added

- **`extractMode: 'session'`** 鈥?one digest per session, run when the session ends,
  proposing at most `extractSessionMaxCandidates` (5) items. Same rules as before:
  candidates only, verbatim-quote grounding, hourly budget, timeout, silent failure.
  `'on'`/`'turn'` keep the per-turn behaviour for anyone who wants it.

- **Review groups a digest.** List rows now carry `sourceSession`, and the review tab
  shows "N proposed together" with one button to verify that batch 鈥?the shape the
  reviewer asked for, instead of five identical rows and five decisions.

### Notes

- The digest runs independently of the episodic summary, so a user can want one
  without the other, and a failing model cannot break the session release.
- The buffer is copied before the asynchronous call: releasing it at dispose must
  not race with the model reading it.

## [2.2.0] 鈥?2026-11-15

Four reviewers of an independent blind review named the same risk: `engines.dsh`
admits the whole `>=0.2.2-rc.1 <0.3.0-0` range, but the only version ever booted was
`0.2.2-rc.1`. A range is a promise nobody tested.

### Added

- **`scripts/compat-probe.mjs`** 鈥?reads the *installed* Host out of its `app.asar`
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

- `dshReleases` gained a `0.2.2-rc.3` row with status `api-surface-verified` 鈥?a
  deliberate third status between "verified" (booted) and "untested", so a range
  entry can never again imply more than was actually checked.

## [2.1.0] 鈥?2026-11-15

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
  saved" looks exactly like "saved but gated". When 鈥?and only when 鈥?something is
  waiting, the footer now carries one line with the count and says those items are
  deliberately absent. An empty queue still costs exactly 0 bytes, and the count is
  part of the render cache key so a new candidate appears on the next request.

- **Per-entry usage counters (schema v2).** `memory_usage` records `inject_count`,
  `read_count`, `last_injected_at`, `last_read_at` per memory, so "which line spends
  prompt bytes and is never opened" becomes answerable. The panel's Stats tab lists
  that dead weight; `loci_get` records a read.

### Migration

Schema v1 鈫?v2 adds one table. It runs through the existing migration runner: a
`VACUUM INTO` snapshot first, then one immediate transaction, then a row-count guard
over every pre-existing table. Rollback stays "restore the snapshot". This is the
first real migration this project has shipped, so `test/integration/migrate.test.mjs`
now exercises both the rehearsal step and the shipped one.

### Note

The same review found two things worth stating openly rather than burying: the
plugin is **not yet in the DSH plugin catalog** (the catalog snapshot predates its
publication), and it has been verified on `0.2.2-rc.1` only, while `engines.dsh`
admits the whole `0.2.2-rc.1 <0.3.0-0` range. Both are tracked as open work.

## [2.0.3] 鈥?2026-11-14

### Fixed

- `dsh-loci --version` (and `-v`, and the bare `version` word) prints the version.
  It fell through to the help text before, because the version was only read for
  the store's metadata and never wired to an argument. `test/unit/cli-version.test.mjs`
  keeps it from regressing, including the "flag before command" position.

## [2.0.2] 鈥?2026-11-14

### Fixed

- The manifest gate now checks the `bin` entry: bare relative path, target exists,
  shebang present, covered by `files`. No user-visible behaviour changed 鈥?measured
  on the published builds, `bin` was already correct in both 2.0.0 and 2.0.1
  (`node_modules/.bin/dsh-loci` is created and `npx dsh-loci help` works).

  The reason for the guard: npm rewrites a bin path that starts with `./` and prints
  `script name 鈥?was invalid and removed`, which reads like the binary was dropped.
  It was not. The value is now canonical so that warning cannot hide a real problem
  next time.

## [2.0.1] 鈥?2026-11-14

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

## [2.0.0] 鈥?2026-11-14

### Added

- **`loci doctor` now looks for near-duplicates.** Two entries that say the same
  thing split the ranking, each take an index line, and force a correction to be
  applied twice. The check reports groups with their ids and a similarity score, and
  leaves the merge to a person (the store can already do it: `loci_write op:'merge'`).

  The metric is `max(Jaccard, containment)` over character bigrams. Jaccard alone
  scores a restated Chinese title at 0.55 鈥?under any useful threshold 鈥?because the
  two titles share most of the *shorter* one rather than most of the union. The scan
  is bounded (verified heads only, 鈮?000 entries, candidate pairs from shared tags
  and title windows, report capped at 5 groups).

- `test/unit/duplicates.test.mjs`: the metric, the verified-only rule, the clean
  store, the caps, and the doctor row.

### Changed

- `publishConfig.access: "public"` is set in the manifest, so a direct `npm publish`
  cannot accidentally create a private package.

### Note

This is the last item from the audit's "ten improvements" list: rows 1鈥? and 5鈥?0
are done, and row 2's remaining gap (duplicate detection) closed here. The version
jumps to 2.0.0 because the feature set that list described is complete, not because
anything in the on-disk format broke 鈥?schemas and the tool surface are unchanged.

## [1.9.0] 鈥?2026-11-14

### Added

- **Candidate-only background extraction** (`extractMode: 'on'`, **off by default**).
  The deterministic capture layer only records statements that announce themselves
  ("always", "never", "we agreed"). A preference stated in passing 鈥?"honestly I'd
  rather see the diff first" 鈥?carries no such marker and was lost. With the feature
  on, the recent conversation is sent to the configured model at turn end and the
  answers land as **candidates** for review.

  Four rules keep it from becoming the feature a user turns off:
  - off unless `extractMode: 'on'`, and inert when the profile has no `llm` route
    (reports `no-model`, writes nothing);
  - candidates only 鈥?an extracted preference can never reach the prompt by itself;
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
  records `model-error` and stays out of the way 鈥?it does not write junk.

## [1.8.0] 鈥?2026-11-14

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

## [1.7.0] 鈥?2026-11-14

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

## [1.6.0] 鈥?2026-11-14

### Added

- **`merge`** (`loci_write` with `op:'merge'`, `store.merge()`, `POST /api/loci/merge`).
  Two entries that say the same thing in different words split the ranking, each
  take an index line, and force a correction to be applied twice. Write-time dedupe
  only catches byte-identical or same-title writes, so the realistic case 鈥?written
  months apart, different wording 鈥?now has an explicit operation:
  - the sources are **superseded, never deleted**: their history stays readable and
    `loci_get` keeps working;
  - tags and entities are unioned, so the merged entry keeps both entries'
    searchability;
  - an optional `expectedRevisions` list aborts the whole merge on a stale
    expectation, before anything is written;
  - a merge that changes the text re-opens verification (the target lands as a
    candidate), because trust is bound to the words that were confirmed;
  - one `merge` audit line names both sides.

## [1.5.0] 鈥?2026-11-14

### Fixed

- **`--json doctor` printed the help text and exited 2.** Flags are now
  position-independent: `--json doctor` and `doctor --json` are the same thing.
- **`snapshots` was unreachable** 鈥?its block sat after the switch, so it never ran.
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

## [1.4.0] 鈥?2026-11-14

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
  entry. `POST /api/loci/forget-all` exposes it, and **Settings 鈫?Delete
  everything** asks for the phrase before running.
- `test/unit/export.test.mjs` (round trip, scope restore, path guard) and
  `test/unit/forget-all.test.mjs` (confirmation, hard-delete gate, scope limit).

## [1.3.0] 鈥?2026-11-14

### Changed

- **A captured statement verifies itself.** With capture on by default, every
  durable-sounding sentence the user said landed in the review queue and was never
  injected 鈥?while the same words, written by the model with a quote, went straight
  through. A captured statement now passes the same quote gate as a model-supplied
  quote: if its sentence is still in the session buffer it is verified, otherwise it
  stays a candidate. Imports and session summaries never verify themselves.
- `autoVerifyCaptured` (default `true`) keeps the old behaviour for a cautious user.
- The review queue lists only the kinds that could be injected, so past-session
  summaries stop pretending to be pending decisions.

### Added

- Reject, verify-all, and a visible error line in the review queue; a failed click
  now says so instead of disappearing into `console.warn`.

## [1.2.0] 鈥?2026-11-14

### Changed

- **The sidebar card is a page of notes, not a dashboard.** Counters ("4 today",
  "4 this week") are gone. The card now shows `鏇存柊浜?<time>` over one short
  paragraph made of the few things the agent currently understands in this
  project 鈥?a consensus, a lesson, a fact 鈥?so reading it answers "did it
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

## [1.1.0] 鈥?2026-11-13

### Added

- **Sidebar mirror** (`sidebar.footer.action`): a flat card beside Settings that
  shows what memory changed today and in the last seven days, the last three
  changes as one-line entries, pending-review count, the installed version in small
  text, and an explicit "check for updates" that is the only path that touches the
  network.
- **Feed tab** in the panel: every add, revision, verification, pin, deletion,
  restore, import and maintenance pass, newest first, with the entry it touched.
- **`/api/loci/activity`**, **`/api/loci/update`**, **`/api/loci/version`** 鈥?the
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

## [1.0.0] 鈥?2026-11-13

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
