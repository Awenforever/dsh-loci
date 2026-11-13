# COMPATIBILITY — verified Hosts and the API surface relied on

## Matrix

| DSH | Node | OS | Result | Evidence |
|---|---|---|---|---|
| 0.2.2-rc.1 | 24.13.0 | Windows 11 | **verified** — install, activate, write, cross-session recall, restart, panel + settings via CDP | `docs/ACCEPTANCE.md` §7 |
| 0.2.2-rc.1 (host) | 22.23.0 | Ubuntu 24.04 (WSL2) | **verified for the store and the suite** — 38/38 tests × 3 consecutive runs, coverage gate 82.85%, benchmark p95 9.87 ms at 2k | this round: `node --test` + `scripts/check-coverage.mjs` |
| 0.2.2-rc.1 | 24 | Ubuntu (GitHub Actions) | matrix job written, not executed from this machine | `.github/workflows/ci.yml` |
| other 0.2.x | — | — | not verified | — |

The Linux run used the Ubuntu 24.04 WSL distribution's Node 22.23.0, which is below
the declared `engines.node` floor (`>=24.9.0`). It proves the store, retrieval,
concurrency, migration and security paths are portable — no Windows-only assumption
in the code — but it is **not** a substitute for the Node 24 CI job, which is why
both rows are listed. The Node floor comes from the Harness, not from a feature Loci
needs beyond `node:sqlite`.

`package.json` declares the range the loader honours:

```json
"engines": { "node": ">=24.9.0", "dsh": ">=0.2.2-rc.1 <0.3.0-0" }
```

`dsh-app-boot` treats an own `engines.dsh` range as authoritative and ignores
peerDependencies when it is present (`lib/index.js:1099-1103`). The `dshReleases`
array in `package.json` records what was actually exercised, so a range is never
the only claim.

## API surface relied on

Every entry below was read out of the installed 0.2.2-rc.1 build.

| API | File:line | If it changes |
|---|---|---|
| `systemPrompt.section({name,order,text,interpolate})` | `dsh-system-prompt/lib/index.js:255-258` | activation self-check fails loudly; no tools are registered |
| section text function receives `{agent, scope, signal, modelSelection, toolSet}` | `dsh-agent/lib/index.js:407-413` | per-request byte accounting and per-scope index stop working |
| `interpolate: false` bypass | `dsh-system-prompt/lib/index.js:120,386-394` | `{{}}` defence falls back to the render-time neutralization only |
| `tools.register(definition)` + `output.schema/render` | `dsh-tools/lib/index.js:433-444` | all five tools refuse to register |
| supported JSON-Schema subset | `dsh-tools/lib/types/json-schema.js` | parameter schemas must be simplified |
| `agent/pre-step` waterfall `(payload, next)` | `dsh-agent/lib/index.js:232-242` | the optional recall assist stops injecting (tools still work) |
| `session/event` `(session, event)` | `dsh-session/lib/index.js:1589-1601` | deterministic capture stops (tools still work) |
| `agent/disposed` `{agent}` | `dsh-agent/lib/index.js:681-691` | session summaries stop |
| `connection.fetch.register({path,methods,requestBody,fetch})` | `dsh-client-connection/lib/index.js:732-734,840-853` | the panel and settings page lose their data source |
| `commands.register` | `dsh-commands/README.md` | `/loci` disappears |
| `dsh.client` + `window.__ModuleLoader__` | `dsh-client-modules/README.md` | the UI half does not load; host features unaffected |
| `slots` ids `settings.section`, `sidebar.panellist`, `main` | live `cordis_inspect_query` | UI registrations land nowhere; host features unaffected |

The plugin degrades by feature, not by death: a missing `connection` service means no
panel API (logged once), a missing `commands` service means no `/loci`, a missing
vector endpoint means lexical retrieval. Only the first two rows are hard
requirements, and they are checked at activation.

## Node

`node:sqlite` is built in from Node 22.5; Loci requires the same floor as the
Harness (`>=24.9.0`) and was measured on 24.13.0 with SQLite 3.50.4 and FTS5
compiled in. No native module, no build step, no post-install script.

## SQLite features used

- WAL mode, `busy_timeout`, `PRAGMA optimize` (3.18+).
- FTS5 with the `unicode61` tokenizer and `remove_diacritics` (3.9+).
- `VACUUM INTO` for snapshots (3.27+).
- `json_each` for tag filtering (JSON1, built in since Node's SQLite).
- Partial-index-free schema; `AUTOINCREMENT` rowids.

## Client

The browser bundle uses only `require('react')` from the shell's module table and
`fetch` against the same origin. No `@deepseek-ai/dsh-client-ui-*` import: those
packages change without notice and a plain-JS plugin has no type check to catch it.

## Upgrading from 0.0.x

There was no public 0.0.x release of `dsh-loci`. If you used a local checkout, the
database schema version is checked on open and a snapshot is taken before any
migration.
