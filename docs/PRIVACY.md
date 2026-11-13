# PRIVACY — what is stored, where it goes, and how to delete it

## What is stored

| Data | Contents | Default retention |
|---|---|---|
| Memory entries | title, body, tags, entity names, status, evidence quote, source session id | until deleted |
| Revision history | every prior version of an entry | with the entry |
| Audit log | event name, timestamp, memory id, byte counts, session id | 5 generations × 8 MB |
| Request statistics | per-request injected bytes, listed/hidden counts | 90 days |
| Session summaries | a deterministic digest of the last 24 messages of a finished session | as an entry |

Never stored: tool results, full transcripts, model reasoning, credentials, or
anything from a session that is not the root session of a conversation.

## Where it is

`$DSH_HOME/memory/loci/` — nothing outside it. The location is printed by
`dsh-loci doctor` and by `loci_stats`.

## What leaves the machine

Nothing, by default. There is no telemetry, no analytics, and no network call in the
plugin's normal path.

Two things can reach the network, and both are opt-in:

| Path | When | What is sent | How to disable |
|---|---|---|---|
| Update check | only when you press "check for updates" on the sidebar card | one `GET https://registry.npmjs.org/dsh-loci/latest`; no query string, no identifier | `updateCheck: false`, or simply never press it |
| Embedding channel | only when `vectorMode` is `http` and an endpoint is configured | the text of the memory being embedded | leave `vectorMode` at `off` |

Opening the panel or the card does **not** contact the registry - the version
badge renders what is installed, and the update answer is served from a local
cache that only a press populates. `updateRegistry` exists for people behind a
slow or blocked route (`https://registry.npmmirror.com` works); it is a config
value, never something a project file can set.

Optional and off by default:

- **`vectorMode: 'http'`** sends the entry text (at write time) and the query text
  (at search time) to the endpoint you configure. Set it to your own
  `llama-server`/embedding gateway if you want vectors without a third party.
- The MCP facade, if you compose it, is a local stdio process; it makes no network
  calls itself.

The model provider already sees the injected index, because that is what a prompt
is. The index contains titles, kinds and dates — not bodies. Bodies reach the model
only when a tool returns them for a specific query.

## What a model sees

1. **Every request**: the index (default budget 3,584 bytes ≈ 1.2k tokens), plus the
   rules block. Titles only.
2. **On demand**: `loci_search` snippets and `loci_get` bodies, for the entries the
   model chose to fetch.
3. **Never**: candidates, disputed entries, deleted entries, superseded revisions,
   or history — unless a tool asks for them explicitly.

## User control

| Want | Where |
|---|---|
| See everything | Memory panel → Index / Stats; `dsh-loci stats` |
| See what is waiting | Memory panel → Review; `dsh-loci review` |
| Approve or reject | Review tab: Verify / Dispute |
| Delete a fact | entry detail → Delete (soft; history retained) |
| Delete permanently | `dsh-loci purge --id <id> --confirm <id>` (requires `allowHardDelete: true`) |
| Turn capture off | Settings → Session capture → off |
| Turn injection off | set `sectionMaxBytes` to its minimum and keep everything unverified, or disable the bundle |
| Export a copy | `dsh-loci export` |
| Stop everything | remove the bundle and delete `$DSH_HOME/memory/loci/` |

## Retention details

- **Deletion is soft by default**: the head revision is marked `deleted`, excluded
  from search and injection, and the history stays readable by id. `purge` removes
  every revision, the full-text rows, entity links and embeddings, and writes one
  audit line.
- **Expiry is time-based, not destructive**: `valid_to` in the past means "no longer
  current"; the row remains queryable with `asOf`.
- **Candidates** older than 30 days are closed by maintenance (still readable, no
  longer counted as pending).
- **Audit** rotates at 8 MB and keeps 5 generations; its lines contain ids and counts,
  never text.
- **Request statistics** are pruned after 90 days.

## Data a third party could infer

If someone obtains `memory.db`, they obtain the memory. If they obtain
`audit.jsonl`, they obtain the *pattern* of activity (when memory was written or
searched, how many bytes were injected, which memory ids), not its content. Treat
both as private files; neither is encrypted by Loci.
