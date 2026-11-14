# OPERATIONS — install, upgrade, roll back, back up, troubleshoot

Everything here is about the plugin's own data. The Harness owns the profile; Loci
owns `$DSH_HOME/memory/loci/` and nothing else.

---

## 1. Install

```text
# inside the harness profile that should have memory
dsh plugin --profile <profile> add dsh-loci
```

or, from inside the running Harness, install the bundle from Settings → Plugins.
Restart the Harness after installing: the Host half loads at boot and a replacement
of an already-installed package needs a fresh process to pick up new JavaScript.

Verify after restart:

1. `Settings → Loci` exists and shows values.
2. The sidebar shows a **Memory** note card; clicking it opens the panel (Feed, Index,
   Search, Review, Stats).
3. The CLI reports healthy — see the note below on how to invoke it.
4. Start one chat and ask it to remember something. The audit file gains a `write`
   line and the next request's `inject` line carries `bytes > 0`.

### Invoking the CLI

`dsh plugin ... add` installs the package into the profile, so its `bin` lands in
`<profile>/node_modules/.bin` — **not** on your `PATH`. Either call it through the
profile, or use the absolute path:

```text
# from anywhere, with <profile> being the profile you installed into (e.g. desktop)
node "$HOME/.dsh/profiles/<profile>/node_modules/dsh-loci/scripts/cli.mjs" doctor --json

# or add the profile's bin directory to PATH for the session
export PATH="$HOME/.dsh/profiles/<profile>/node_modules/.bin:$PATH"
dsh-loci doctor --json
```

On Windows the same path is `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-loci\scripts\cli.mjs`.
Options may appear before or after the command (`--json doctor` and `doctor --json`
are equivalent).

There are also zero-token slash commands inside a chat: `/loci`, `/loci review`,
`/loci doctor`, `/loci export`. They call the same store without a model turn.

## 2. Upgrade

Upgrades are additive by contract: a newer build either keeps the schema version or
migrates it forward after taking a snapshot.

```text
dsh plugin --profile <profile> add dsh-loci@<version>
# restart the Harness
node scripts/cli.mjs doctor   # schema version, index coverage, integrity
```

If the build expects a newer schema, `Store.open` runs the migration itself:

1. assert no maintenance lock is held,
2. `VACUUM INTO backups/pre-v<N>-<timestamp>.db`,
3. apply each migration step in one transaction,
4. compare row counts before/after, then `PRAGMA user_version`.

A failed step rolls back the transaction and leaves the snapshot in place. Five
snapshots are retained.

## 3. Roll back

Rollback is **restore the snapshot**, never a down-migration:

```text
# stop every Harness instance that shares this DSH_HOME
dsh-loci rollback                     # newest snapshot
dsh-loci rollback --from <snapshot>   # a specific one
dsh-loci doctor
```

`rollback` refuses to run while a `-wal` file exists, because that means a process
still has the database open.

To roll the *plugin* back without touching data:

```text
dsh plugin --profile <profile> add dsh-loci@<previous-version>
```

The database is forward-compatible with the previous minor only if the older build
declares the same schema version; otherwise restore the snapshot that the upgrade
took.

## 4. Backup

Three layers, cheapest first:

| What | When | Command |
|---|---|---|
| snapshot | before every migration, on demand | `dsh-loci snapshot` → `backups/<label>-<ts>.db` (one consistent file, produced by SQLite `VACUUM INTO`); `migrate` also snapshots automatically |
| Markdown export | any time | `dsh-loci export` → `markdown/<scope>/<kind>/*.md`; `dsh-loci import` reads exactly that tree back, restoring each entry's original scope |
| file copy | machine-level backup | copy `$DSH_HOME/memory/loci/` while the Harness is stopped, or `memory.db` + `memory.db-wal` while it runs |

The Markdown projection is lossy in one direction by design: it carries the head
revision, tags, entities, status and evidence note. Importing it produces
**candidates**, so a restored file can never silently become prompt text.

### Coming from another memory plugin

Two on-disk formats are read directly, so a user switching plugins does not start
from zero:

```text
# dsh-auto-memory: $DSH_HOME/memory/{_user,--<project>--}/*.md
dsh-loci import --from auto-memory --dir "$DSH_HOME/memory"

# Claude Code memory: a directory holding MEMORY.md plus topic files
dsh-loci import --from claude --dir "$HOME/.claude/memory"

# see what would be imported, without writing
dsh-loci import --from auto-memory --dir <path> --dry-run
```

What the bridge preserves and what it deliberately does not:

- `_user/` entries become **global** scope; `--<project>--/` entries keep their
  project folder as the scope key, so two projects do not merge into one.
- auto-memory `type: feedback` maps to `procedural`, `user`/`reference` to
  `semantic`; `disabled: true` and already-superseded entries are skipped.
- every imported entry is a **candidate**. The other plugin's trust level is not
  evidence here: only a verbatim quote from this session, or a person, promotes an
  entry.
- the source file is recorded as `sourceRef` (`auto-memory:_user/foo.md`) so the
  original is one click away.

`@tr1v3r/dsh-ltm` is not read directly: its store is a private SQLite schema, and
guessing at it would be worse than asking. Export from ltm as JSON and convert, or
keep both plugins installed.

## 5. Inspect and repair

```text
dsh-loci stats          # counts, budget use, last injection, channel health
dsh-loci review         # candidates and disputed entries
dsh-loci search <text>  # the same engine the model uses
dsh-loci reindex        # rebuild full-text + token statistics
dsh-loci maintenance    # one pass: TTLs, index repair, PRAGMA optimize
dsh-loci doctor         # three-state health report, exit code 1 on failure
```

`doctor` checks: database open, `quick_check`, `integrity_check`, schema version,
full-text coverage gap, data/export directory writability, WAL size, stale lock
file, snapshot presence, vector endpoint configuration, audit size.

## 6. Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Settings page missing | client half not loaded | `cordis_inspect_query` client `Slots` for `settings.section` occupants; restart the Harness |
| Panel empty but `loci_stats` shows entries | the panel lists every scope, so this is unlikely; check the tab filter | `/api/loci/list` directly |
| Injected bytes stay 0 with entries present | nothing is `verified` yet, or everything is outside this session's scopes | `dsh-loci review`; confirm the entry's scope |
| `database is locked` | a maintenance or import transaction is running | retry; the plugin already retries six times with backoff |
| Recall misses a fact you can find with `dsh-loci search` | the query path differs: the model may not have called the tool | `loci_stats` shows the last injection; the index only holds the first N entries by tier |
| Vector channel unhealthy | endpoint down or slow | `loci_stats` → `vector.lastError`; it parks itself for 5 minutes after three failures |
| Plugin refuses to activate | Host lacks `systemPrompt.section` or `tools.register` | `docs/COMPATIBILITY.md` |

## 7. Uninstall

```text
dsh plugin --profile <profile> remove dsh-loci
```

The data directory is **not** removed: an uninstall is not a decision to forget. To
delete memory:

```text
dsh-loci export                 # keep a copy first
# then delete $DSH_HOME/memory/loci with the same care as any other data directory
```

## 8. Optional MCP facade

Another agent (or another Harness) can read the same store over stdio:

```yaml
- insert:
    - id: mcp-loci
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: loci
        transport: stdio
        command: node
        args: ['<absolute path to dsh-loci>/src/mcp/server.js']
```

The facade opens the database **read-only** by default. `--allow-write` adds
`loci_write`, which stores a *candidate*: an external agent may propose a memory,
never certify one.
