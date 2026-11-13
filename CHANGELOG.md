# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0.0.

## [1.1.0] — unreleased

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
