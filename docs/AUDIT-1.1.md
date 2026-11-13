# Independent audits before public distribution

Five reviewers were given the repository read-only and asked the same question from
different angles: *what would embarrass this plugin in front of strangers?* They did
not talk to each other, they did not read this file, and they were told to cite
`file:line` and to mark anything they could not verify.

| Reviewer | Scope | Outcome |
|---|---|---|
| A | storage, retrieval, migration, concurrency | **failed three times** (runner errors). Its scope was covered by the maintainer — see §"What A would have looked at". |
| B | host integration, injection surface, security, MCP | delivered; 3 blockers, 12 serious |
| C | UX, docs, first run, tool descriptions | delivered; 5 blockers, 6 serious |
| D | packaging, CI, release, test quality | delivered; 4 blockers, 10 serious |
| E | product research: Mem0, Graphiti/Zep, Letta, memsearch, OpenViking, Claude Code, ChatGPT, Cursor | delivered; 10 ranked improvements |
| F | competitive comparison with the 12 published DSH memory plugins | delivered; feature matrix + positioning |

Two reviewers pinned their findings to tag `v1.0.0` and separately reported the
working-tree delta, because 1.1.0 was being written while they read. That is the
right way to do it, and it is why some findings below are marked *already fixed*.

## What they agreed on (and it was the worst thing in the repository)

Three reviewers, working independently, found the same hole: **the model could
verify its own memory.** `loci_write` advertised `op: 'verify'`, called
`store.setTrust(..., 'verified')`, and wrote `actor: 'user'` to the audit log. An
entry the model invented could therefore be promoted into the prompt's "verified,
must follow" block — and `index-section.js` would print it there — which is exactly
the guarantee `SECURITY.md` and `README.md` claimed. Worse, `op: 'update'` preserved
`verified` across a rewrite, so a confirmed fact could be replaced with arbitrary
text and stay trusted.

The research reviewer reached the same place from the other direction: Mem0 deleted
its LLM-driven UPDATE/DELETE in v3 for this reason, and Claude Code never gives the
model a "verified" bit at all.

**Fixed in 1.1.0** (`src/host/tools/tools.js`, `src/host/store/store.js`):

- `verify` and `dispute` are gone from the model-facing tool. Only the panel API and
  the CLI can change trust.
- A revision keeps `verified` only when its content hash matches a revision that was
  already verified **and** the scope is unchanged. Any other edit lands as a
  `candidate`.
- Reverting to previously verified wording restores trust (`#textWasVerified`),
  so a correction is not a one-way trip.
- A same-title create no longer silently revises the existing entry; it creates a
  second entry and reports the collision with `reason: 'same-title'`.

## Every finding and its disposition

Legend: **fixed** = changed in 1.1.0 and covered by a test; **documented** = the
behaviour is intended, now stated honestly; **open** = real, not yet addressed.

### Security and trust

| # | Finding | Source | Disposition |
|---|---|---|---|
| 1 | model can verify/dispute its own entries | B, C, D | **fixed** |
| 2 | `update` keeps `verified` across a rewrite; scope can be moved | B, D | **fixed** |
| 3 | MCP facade searches `allScopeKeys()`: one project's memory leaks to another | B, D | **fixed** — the facade now reads the scope of the directory it was started in; a negative test proves project B cannot see project A |
| 4 | MCP facade dies on a fresh profile (no store directory) | B | **fixed** (`ensureMemoryRoot`) |
| 5 | one render error fails the whole turn (no try/catch in the section) | B | **fixed** — degrades to an empty section, one warning per process |
| 6 | a directory name containing a newline injects lines into the fence | B | **fixed** — scope label flattened and capped through `indexTitle` |
| 7 | bidi overrides / zero-width characters let the panel display one thing and the model read another | B | **fixed** — stripped at storage, so every surface agrees |
| 8 | secret scanner knew no Chinese keywords; tags and entities were never scanned | B | **fixed** — plus presigned URLs, Google/Slack/Stripe/GitLab/npm tokens, `Authorization: Basic` |
| 9 | delete `reason` written verbatim to the audit | B | **open** — it is a human-supplied field; the audit is mode 0600. Recorded as a known limitation. |
| 10 | `assertInside` is lexical, so a symlink inside the root escapes | B | **open** — export/backup paths are chosen by the plugin, not by a caller; noted for a future hardening pass |

### Privacy

| # | Finding | Source | Disposition |
|---|---|---|---|
| 11 | the new sidebar card phoned npmjs on mount, contradicting `PRIVACY.md` | B, C | **fixed** — `/api/loci/update` serves a local cache; only the explicit press fetches. `PRIVACY.md` now has a table of both opt-in network paths. |

### Correctness

| # | Finding | Source | Disposition |
|---|---|---|---|
| 12 | `/api/loci/preview` passed `config` as a function (claimed 400) | B | **not reproducible** — `config` is the effective-config *object*; the endpoint returned 200 and a real index. The claim was wrong, but the review prompted a test that would have caught it had it been true. |
| 13 | `/api/loci/config` spread the reader (claimed `{}`) | B | **same** — it returned all 31 keys, including `sectionMaxBytes: 3584` |
| 14 | injected index goes stale on TTL/date in a long-lived process | D | **fixed** — the UTC date is part of the cache key |
| 15 | capture buffer leaked when summaries were off (`return` before `finally`) | B | **fixed** |
| 16 | store closed before capture flushed, so unload summaries were lost | B | **fixed** — store close is now the first registered disposer, i.e. the last to run |
| 17 | maintenance ran on every sweep even when nothing changed, drowning the feed | C + found in testing | **fixed** — a no-op sweep writes no audit line; the feed groups one row per entry |
| 18 | `readScopeKeys` had a ternary returning the same value in both branches | D | **fixed** — `includeGlobal` now means something |
| 19 | `search('')` returned empty, so "what do you remember" needed a fabricated query | C, F | **fixed** — omitted query lists newest entries with the same `total`/`cursor` |
| 20 | result text could not distinguish found / nothing-matched / failed | E | **fixed** — three-way contract, plus a disclosure when the ranking window was bounded |

### Packaging, CI, release

| # | Finding | Source | Disposition |
|---|---|---|---|
| 21 | `npm test` broken on Node 24 (directories passed to `--test`) | D | **fixed** — globs; `npm test` now runs 53 tests |
| 22 | `build:client` pointed at a script that does not exist | D | **fixed** — removed; `client.js` is hand-authored |
| 23 | no public GitHub repo, so `--provenance` cannot publish | D | **open, operator-gated** — the repository must be created and pushed before a release tag |
| 24 | release workflow can publish a prerelease as `latest`, no ancestry check | D | **open** — documented as a release-checklist item |
| 25 | no lockfile, `npm install` in CI | D | **open** — there are no runtime dependencies beyond the Host, so the risk is small but real |
| 26 | NOTICE said schemastery is Apache-2.0 | D | **fixed** — the registry says MIT |
| 27 | coverage gate is line-only (83% lines, 60.8% branches) | D | **open** — the threshold is explicit about being line coverage |
| 28 | e2e harness had `record(..., true)` tautologies | D | **partly fixed** — the two literal passes were replaced by real assertions in `ui.mjs`/`mirror.mjs` |

### UX and docs

| # | Finding | Source | Disposition |
|---|---|---|---|
| 29 | first run has no "it worked" moment; empty store is correct but invisible | C | **fixed** — the sidebar card states "nothing learned yet · facts you confirm appear here", and the panel opens on a Feed that explains itself |
| 30 | the review queue is a dead end (≤50, no reject, no bulk, no evidence) | C | **fixed in 1.3.0** — reject, verify-all and a visible error line; the queue lists only kinds that could be injected. Root cause was upstream of the UI: default capture wrote candidates nobody could ever promote, so the queue was fed by statements the user had literally just made. Captured statements now pass the same quote gate as a model quote. |
| 30b | `export` then `import` imports nothing: entries go to `<root>/markdown/<scope>/<kind>/<id>.md` but `importMarkdown` defaults to `<root>/exports`, which holds only a one-line header file | D | **open** — verified: `export.js:119` writes to `paths.markdown`, `export.js:142` reads `paths.exports`. The importer also drops ids, status, evidence and the original scope. A real `snapshot` command (VACUUM INTO) plus a tested round trip is the fix. |
| 31 | the panel's Index tab said "exactly what the model sees" but rendered every scope | C | **partly fixed** — the label now states which scopes were rendered; `?cwd=`/`?session=` let a caller ask for one conversation's view |
| 32 | README said 5,120 B where the default is 3,584 | C, D | **fixed** (both READMEs) |
| 33 | docs describe a CLI that is not on PATH; `/loci` commands undocumented | C | **open** — `scripts/cli.mjs` works via `node <profile>/node_modules/dsh-loci/scripts/cli.mjs`; `OPERATIONS.md` needs that exact line |
| 34 | no "forget everything" affordance for a privacy request | C | **open** — `purge` is per-id by design; the documented path is deleting the data directory |
| 35 | tool descriptions under-specified for a weaker model | C | **partly fixed** — `query` is optional with a stated meaning, and `op` documents that trust is not settable |

## What A would have looked at

The storage reviewer failed three times in the runner, so its scope was audited here
instead. The findings that mattered:

- **Hash/ord invariants survive the trust change.** `#textWasVerified` reads every
  revision of an id, so a row created under the old "inherits verified" rule is
  handled: it keeps trust only if that exact content was verified at some point.
- **FTS drift** is repaired by `reindex()` and disclosed by `loci_stats.indexCoverage`
  (`memory` vs `fts` counts); the write path inserts both inside one transaction.
- **Bounded ranking**: `partial: true` and `matchedTotal: null` are set when the
  candidate window is bounded, and the tool renderer now says so in words.
- **Growth**: at 100k entries the first limit is vector brute force (a full scan per
  query), which is why `vectorMode` is `off` by default and the benchmark reports
  its posting density explicitly.

## The ten improvements worth doing next

Ranked by (effect on trust × cheapness), from the research reviewer and confirmed by
the others:

1. A review queue that can reject, page and bulk-approve — it is the only surface
   that decides what enters the prompt.
2. `loci_doctor`: placement, duplicates, injected tokens, one screen, read-only.
3. Export/import that round-trips (the current importer loses ids, status and
   revisions, and reads a different directory than the exporter writes).
4. A public GitHub repository, so provenance, issues and SECURITY.md are real.
5. "Delete all memory" with a typed confirmation.
6. `loci_merge` for near-duplicates (ltm's `expectedSourceRevisions` shape).
7. A candidate-only background extractor, so preferences stated in passing are not
   lost.
8. Import bridges from auto-memory / ltm / Claude memory.
9. `sourceRef` (path:line) so a fact can cite the file it came from.
10. A snapshot command in the CLI, and a tested restore.

## What the reviewers said was genuinely good

Worth recording verbatim, because a review that only lists faults is not a review:

> "Storage design is genuinely good." — C

> "`interpolate:false` + fence + escaping is real and matches the Host; three
> independent guards." — B

> "Verified-only injection is enforced in the store, not callers … (tested)" — B

> "Tests are unusually strong: 4-process WAL + SIGKILL recovery, scope isolation,
> cursor integrity, purge gate, byte-budget overflow." — B

> "The core is real and measured: 0 B empty, a flat 3,450–3,507 B section at 51–152
> entries with an honest '+N more', 12.5 ms p95 at 10k." — C

> "`total`+`cursor` with a query-hash mismatch guard — no peer returns a true total."
> — F

> "ACCEPTANCE names its own failure (CK-10) and unverified claims — rare and
> trust-building." — C
