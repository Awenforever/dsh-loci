# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0.0.

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
