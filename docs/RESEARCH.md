# RESEARCH — what Loci borrowed, what it refused, and why

Status: v1.0.0 · Research window 2026-11-13 · Author: Awei (Awenforever)

This document is the evidence trail for the design. Every borrowed mechanism names
the product and the primary source that documents it; every rejected pattern names
either a measured failure in this workspace (`.agent-audit/memory-eval3/`) or a
documented footgun in the product that shipped it.

Two rules kept the list honest:

1. **No benchmark number is quoted without its source and its caveat.** Three of the
   six products publish numbers their own documentation later qualifies.
2. **A pattern only qualifies as "borrowed" if it survives the DSH constraints** — one
   Node process, one SQLite file, a hard prompt budget, no server, no cloud.

---

## 1. Method and evidence boundary

- Local evidence: the three-plugin acceptance run in `.agent-audit/memory-eval3/`
  (`ACCEPTANCE.md`, `SUMMARY.md`, `LONGRUN.md`) and the three source reviews
  (`auto-memory-design.md`, `mnemon-design.md`, `dsh-memory-design.md`), plus the
  ledger trial in `.agent-audit/memory-eval/dsh-ledger-memory/TRIAL-CHECKLIST.md`.
- Host evidence: the installed DSH 0.2.2-rc.1 build (`app.asar`), inspected for the
  extension points Loci uses; every API claim in `docs/DESIGN.md` cites a file and
  line from that build.
- External evidence: primary documentation and papers fetched 2026-11-13. GitHub raw
  access was unavailable from this network, so "shipped code" claims for the hosted
  products rest on their official documentation's own statements, not on reading
  their source trees. That limitation is repeated in the source list.

---

## 2. What Loci borrowed

### 2.1 Bi-temporal facts: four timestamps, invalidate instead of delete

- **Source**: Graphiti / Zep, arXiv 2501.13956 (§2.2.3 "edge invalidation"); the
  mechanism is documented as two timelines — event time `T` and ingestion time `T'` —
  with four stamps per edge: `t_valid`, `t_invalid`, `t_created`, `t_expired`.
  <https://arxiv.org/abs/2501.13956> · <https://help.getzep.com/graphiti/core-concepts>
- **Mechanism**: a contradicting fact does not overwrite its predecessor. The old
  edge's `t_invalid` is set to the new edge's `t_valid`; the row stays readable.
  Following `T'` guarantees the newest ingestion wins.
- **Why it fits DSH**: "what did we believe last week" is a real question in long
  projects, and the cost is a schema, not a graph database. It also removes the
  single most destructive operation in a memory store — `UPDATE`.
- **How Loci implements it**: `memory.valid_from / valid_to` (event time) and
  `memory.recorded_at` (transaction time); a revision closes with
  `status='superseded'`, `superseded_by='id@rev'`, and `valid_to=now`. `loci_search`
  answers "current", `asOf` answers "then". See `docs/DESIGN.md` §3.

### 2.2 Retrieval as rank fusion of independent cheap signals

- **Source**: Mem0 evaluation documentation — four signals (semantic, BM25, entity
  match, temporal intent) fused by rank, with BM25 explicitly "a boost signal, not a
  recall expander" and temporal "additive … semantic relevance always dominates".
  <https://docs.mem0.ai/core-concepts/memory-evaluation> · paper: arXiv 2504.19413
  §2.1, §2.2.
- **Source (fusion weight)**: Graphiti §3 uses reciprocal rank fusion among rerankers
  <https://arxiv.org/abs/2501.13956>; the local MemOS plugin documents "RRF + MMR"
  over vector/FTS5/keyword/error-signature channels
  <https://memos-docs.openmem.net/openclaw/local_plugin>.
- **Why it fits DSH**: rank fusion needs no score calibration between a BM25 value and
  a cosine value, and it degrades gracefully — a missing channel contributes nothing
  instead of distorting the ranking.
- **How Loci implements it**: four channels (`lexical`, `entity`, `vector`, `recency`),
  `Σ w_c / (60 + rank_c)`, weights 1.0 / 0.8 / 1.0 / 0.3. `recency` is `boostOnly`:
  it can only re-rank candidates another channel found, so a query never degenerates
  into "everything". See `src/host/store/search.js`.

### 2.3 The index is the prompt; the body is fetched

- **Source**: ReMe's DSH integration injects "guidance only — not every historical
  memory"; memories enter context only through a read-only `reme_search`
  (default limit 5, 1–50). <https://reme.agentscope.io/en/integrations/dsh>
- **Source**: memsearch's DSH plugin adds one per-turn reminder on `agent/pre-step`
  step 1 and stores Markdown as truth with a rebuildable shadow index.
  <https://github.com/zilliztech/memsearch> (`plugins/dsh/README.md`)
- **Source (budget discipline)**: OpenViking's Claude Code integration caps the
  SessionStart block at 9,500 bytes (under Claude Code's 10,000-character hook
  limit), per-recall at 2,000 tokens / 10 items, and externalizes tool output above
  20,000 characters. <https://docs.openviking.ai/en/agent-integrations/02-claude-code>
- **Why it fits DSH**: it is the only shape that satisfies both "zero cost on an empty
  store" and "cost does not grow with the store" — and it is already the winning shape
  among the DSH plugins that shipped.
- **How Loci implements it**: one system-prompt section (`loci:index`, order 4000,
  `interpolate:false`, default 5,120-byte cap, hard ceiling 16,384), one line per
  entry, full text via `loci_get`. Empty store returns `''`, so the section vanishes.

### 2.4 L0/L1 summaries at 256 / 4000 characters

- **Source**: OpenViking context layers — `.abstract.md` defaults to 256 characters,
  `.overview.md` to 4,000, with the raw body as L2.
  <https://docs.openviking.ai/en/concepts/03-context-layers>
- **Why it fits DSH**: a one-line abstract is exactly what an index line is; having a
  named tier between "one line" and "whole body" keeps the tool able to answer without
  paying for the full text.
- **How Loci implements it**: `detail: 'snippet'` (240 chars, default) →
  `'overview'` (800) → `'full'`. The index line is the L0.

### 2.5 Markdown as a projection; the index must be rebuildable

- **Source**: ReMe (Markdown workspace, rebuildable `metadata/`), memsearch (Markdown
  is truth, Milvus is a "shadow index"), Letta MemFS (a git repo per agent projected
  on disk). <https://github.com/agentscope-ai/ReMe> ·
  <https://zilliztech.github.io/memsearch/home/configuration/> ·
  <https://docs.letta.com/concepts/memfs/index.md>
- **Why it fits DSH**: users want their memory in files they can read, diff, and back
  up — but a file-per-fact truth makes every write a directory-level index rebuild
  (exactly the auto-memory failure in §3.3).
- **How Loci implements it**: SQLite is the transactional truth; `markdown/<scope>/<kind>/<id>.md`
  and `exports/*.md` are generated projections; `reindex` rebuilds FTS/token stats from
  the rows, and `doctor` reports the coverage gap.

### 2.6 Scope on a stable project identity, not on the shell's cwd

- **Source**: Claude Code keys auto-memory to the git repository so worktrees share one
  memory directory <https://code.claude.com/docs/en/memory.md>; OpenViking derives a
  peer from the origin URL. Counter-example: memsearch derives a Milvus collection per
  repository path, and its own documentation flags the worktree divergence as a
  footgun.
- **How Loci implements it**: `workspace:<sha16(realpath cwd)>`, `project:<sha16(git root)>`
  (the nearest ancestor with `.git`), `session:<id>`, `global:`. Reads are an explicit
  key set — never a wildcard. See `src/host/scope.js`.

### 2.7 Deterministic extraction beats a model call per session

- **Source**: ReMe `auto_memory` runs every 5 completed turns; memsearch summarizes the
  turn on a Stop hook; both are model calls whose cost appears only in the bill.
  Loci's local evidence shows why that matters: mnemon spawned one task-agent session
  per `remember`, and the ledger plugin forced a write on every turn including empty
  ones (`.agent-audit/memory-eval3/LONGRUN.md:19`,
  `.agent-audit/memory-eval/dsh-ledger-memory/TRIAL-CHECKLIST.md:115`).
- **How Loci implements it**: rules-only capture of explicit durable statements plus a
  deterministic episodic summary on root-agent dispose. No background model call in
  v1.0; the review queue is the price, and it costs zero prompt tokens.

### 2.8 Trust is a gate on injection, not a label

- **Source (the failure)**: auto-memory writes model-authored entries with no status
  and injects them immediately (`auto-memory-design.md:32`).
- **Source (the pattern)**: Cognee marks facts `current / superseded / conflicting` and
  keeps the conflict node; Graphiti invalidates rather than deletes.
- **How Loci implements it**: only `status='verified'` is injected. A write with a
  verbatim quote that is still findable in the live session buffer is verified;
  anything else is a candidate. Instruction-shaped text is quarantined as `disputed`.
  See §4.2 of the design.

### 2.9 A tool surface small enough to keep

- **Source (the failure)**: mnemon ships 16 memory tools, and 10 of them are dead
  without a separately installed CLI (`mnemon-design.md:70`); the ledger plugin adds
  22 (`TRIAL-CHECKLIST.md:117`); auto-memory adds 7.
- **How Loci implements it**: five tools — `loci_write`, `loci_search`, `loci_get`,
  `loci_forget`, `loci_stats` — and `loci_` prefixes so a second memory plugin cannot
  collide on `memory_*` registration.

### 2.10 Project-level configuration is a security surface

- **Source**: memsearch restricts project-level `.memsearch.toml` to low-risk indexing
  keys; provider routing, endpoints, API keys and prompts must live in global config
  or explicit CLI flags (since v0.4.11).
  <https://zilliztech.github.io/memsearch/home/configuration/>
- **How Loci implements it**: Loci reads configuration only from its own Loader row.
  It never reads a project file, so a cloned repository cannot redirect memory to an
  attacker-controlled endpoint.

---

## 3. What Loci refused, with the evidence

### 3.1 Per-turn full injection that grows

- Ledger trial: first turn 7,139 characters, later 27,253 characters per turn
  (`TRIAL-CHECKLIST.md:113`), measured cost 7–27 KB per turn, about 2.4–9k tokens
  (`:117`).
- **Refused because**: the cost is unbounded in exactly the sessions where memory
  matters most, and it rewrites the prompt prefix on every turn.

### 3.2 A forced write at the end of every turn

- Ledger trial: empty turns still wrote "本轮无实质更新", growing the ledger 30 → 47
  lines in a short run (`TRIAL-CHECKLIST.md:115`).
- **Refused because**: it manufactures noise and pays for it twice (generation and
  retrieval).

### 3.3 Rebuilding the index on every write

- auto-memory rebuilds `MEMORY.md` on every write, so the system-prompt prefix changes
  after any write and the prefix cache is lost (`auto-memory-design.md:24`).
- **Refused because**: a write should invalidate at most the tail of the section.
  Loci keeps the header count-free, orders by immutable keys, appends within a tier,
  and only bumps `index_rev` for writes that can change the injected set.

### 3.4 An index whose true capacity is a few dozen entries

- auto-memory's 4,096-byte budget leaves a net 2,702 bytes for the index, about 27
  Chinese entries before truncation (`auto-memory-design.md:21`).
- **Refused because**: an index that silently stops covering the store is worse than
  no index. Loci states the hidden count in the section and makes `total` exact in
  `loci_search`.

### 3.5 Silent truncation in recall

- mnemon: `limit=20` returned 4 rows; the broad "list all constraints" probe returned
  4–6 of 12; a five-question recall answered 2/5 correctly
  (`.agent-audit/memory-eval3/longrun/recallD.log`,
  `.agent-audit/memory-eval3/LONGRUN.md:16-18`).
- **Refused because**: the caller cannot tell "not remembered" from "not returned".
  Loci always returns `total`, `hasMore`, and a cursor.

### 3.6 Injecting unverified or imported memory

- auto-memory's `memory_write` leaves `status` undefined and the index filter does not
  exclude it, so model-written and imported entries are injected directly
  (`auto-memory-design.md:32`).
- **Refused because**: a poisoned web page or a wrong model guess must not become a
  persistent instruction. Candidates and imports are shown as a count, never as text.

### 3.7 Template interpolation over stored text

- dsh-memory did not set `interpolate:false`, so a memory containing `{{name}}` made
  every later assembly throw; the model could not even call `memory_forget`
  (`dsh-memory-design.md:20`).
- **Refused because**: it is a one-line fix with a three-line defence. Loci registers
  the section with `interpolate: false` **and** neutralizes `{{` / `}}` in every
  rendering.

### 3.8 Default global scope

- mnemon's `storageScope` defaults to `global` (`mnemon-design.md:19`); dsh-memory has
  no project column at all (`dsh-memory-design.md:12`).
- **Refused because**: a fact about project A must never answer a question in project
  B. Loci defaults to `workspace` and requires an explicit `scope:'global'`.

### 3.9 Data outside `$DSH_HOME`

- mnemon wrote to `C:\Users\author\.mnemon` and ignored `DSH_HOME`
  (`.agent-audit/memory-eval3/ACCEPTANCE.md:17`).
- **Refused because**: a store outside the Harness home is outside its backups and
  every test that isolates `DSH_HOME`. Loci writes only under
  `$DSH_HOME/memory/loci/`.

### 3.10 A compatibility range that excludes the running Host

- dsh-memory 0.1.0 declared peers on `^0.1.0-rc.6` and was skipped by 0.2.2-rc.1
  (`ACCEPTANCE.md:21`).
- **Refused because**: `engines.dsh` is authoritative in `dsh-app-boot`
  (`lib/index.js:1099-1103`); Loci declares it and adds a runtime capability check at
  activation.

### 3.11 SQLite without WAL or a busy timeout

- dsh-memory set neither, so a second writer got `database is locked` immediately
  (`dsh-memory-design.md:27`).
- **Refused because**: the GUI and a headless run share one home. Loci sets WAL,
  `busy_timeout=3000`, `BEGIN IMMEDIATE`, and bounded retries; measured with four
  processes × 50 writes in `test/integration/concurrency.test.mjs`.

### 3.12 A memory plugin that silently dies without an optional backend

- mnemon's default backend needs an extra CLI; without it 10 of 16 tools fail
  (`mnemon-design.md:70`).
- **Refused because**: optional capabilities must disappear, not rot. Loci's vector
  channel is off by default, parks itself after three failures, and reports
  `vector: off` in `loci_stats`.

### 3.13 English tokenization applied to Chinese

- dsh-memory used `unicode61`, so `用户` never matched `用户偏好`
  (`dsh-memory-design.md:31`).
- **Refused because**: CJK has no spaces. Loci pre-tokenizes into overlapping bigrams
  and queries with FTS5 phrases; `路径断言` and `迁移` both match, proven in
  `test/unit/store.test.mjs`.

### 3.14 A write path that spawns an agent

- mnemon derived a task-agent session per `remember` — 12 writes produced 12 sessions
  (`LONGRUN.md:19`).
- **Refused because**: memory writes must be local and cheap. Loci's write path is one
  SQLite transaction.

### 3.15 Benchmark claims that do not survive reading

- Mem0's documentation states its scores "reflect Mem0's managed platform, which
  includes proprietary optimizations not available in the open-source SDK", and quotes
  two different OSS LoCoMo numbers (91.6 vs 92.5).
  <https://docs.mem0.ai/core-concepts/memory-evaluation>
- Cognee's own evaluation page says BEAM is "fully public… informed the prompts", the
  100K/10M scores are "not a controlled comparison", and LoCoMo "is not held out".
  <https://docs.cognee.ai/core-concepts/evaluation-and-efficiency/accuracy-benchmarks>
- Graphiti's DMR improvement is described by its authors as "marginal … over the
  full-conversation baseline" on 60-message conversations.
- **Refused because**: Loci's acceptance numbers are produced by its own scripts on
  this machine, with the exact command in `docs/ACCEPTANCE.md` — and the benchmark
  itself is committed, so a reader can rerun it.

### 3.16 Small but sharp footguns worth naming

- ReMe: a positive `min_score` above the hybrid scale's `1/61` deletes every hit
  (documented by ReMe). Loci therefore exposes **no** `minScore` parameter; the floor
  is internal and the cursor is the only paging contract.
- memsearch: per-repository-derived collections diverge across worktrees. Loci keys
  `project` on the git root.
- OpenViking: `search()` applies `limit` per planned query with "no guaranteed
  deduplication across queries"; Loci fuses into one ranked list and dedupes by id
  before `total` is computed.
- Cursor: the former "Memories" documentation path now redirects to Rules, and the
  current page documents no automatic capture; treat "Cursor remembers" as unverified
  marketing. <https://cursor.com/docs/rules>
- ChatGPT: the injection policy is opaque ("ChatGPT decides which available information
  is relevant"), with no published budget — unverified, and not a model to copy.

---

## 4. How the constraints shaped the list

| DSH constraint | Consequence for the design | Borrowed / refused |
|---|---|---|
| one Node process, no server | no graph DB, no vector service, brute-force cosine | borrowed Mem0's "vectors are optional"; refused Neo4j/FalkorDB |
| hard prompt budget | index-only injection, byte cap, hidden-count footer | borrowed OpenViking's 9.5 KB discipline; refused per-turn dumps |
| prefix caching | stable order, count-free header, `index_rev` | refused auto-memory's rebuild-on-write |
| shared SQLite file across GUI + headless | WAL + busy timeout + retries | refused dsh-memory's default pragmas |
| session log is the only source of truth | memory rows cite `source_session/event`; no custom session events | refused mnemon's derived agent sessions |
| plugin code may not append new event types | capture observes `session/event`, stores elsewhere | — |
| `engines.dsh` gate | declare it, ignore peers, self-check at activation | refused dsh-memory's peer-only declaration |
| user data under one root | `$DSH_HOME/memory/loci/` only | refused mnemon's home-directory store |

---

## 5. Sources

Primary, fetched 2026-11-13:

1. Mem0 paper — <https://arxiv.org/abs/2504.19413> · evaluation docs —
   <https://docs.mem0.ai/core-concepts/memory-evaluation> · OSS v2→v3 migration —
   <https://docs.mem0.ai/migration/oss-v2-to-v3>
2. Graphiti / Zep paper — <https://arxiv.org/abs/2501.13956> · Graphiti docs —
   <https://help.getzep.com/graphiti/core-concepts>
3. Cognee local stack — <https://docs.cognee.ai/setup-configuration/overview> ·
   `improve()` — <https://docs.cognee.ai/core-concepts/main-operations/improve> ·
   benchmarks — <https://docs.cognee.ai/core-concepts/evaluation-and-efficiency/accuracy-benchmarks>
4. MemOS position paper — <https://arxiv.org/abs/2505.22101> · paper —
   <https://arxiv.org/abs/2507.03724> · local plugin —
   <https://memos-docs.openmem.net/openclaw/local_plugin>
5. OpenViking storage — <https://docs.openviking.ai/en/concepts/05-storage> ·
   context layers — <https://docs.openviking.ai/en/concepts/03-context-layers> ·
   Claude Code integration — <https://docs.openviking.ai/en/agent-integrations/02-claude-code>
6. ReMe repository — <https://github.com/agentscope-ai/ReMe> · DSH integration —
   <https://reme.agentscope.io/en/integrations/dsh> · memory search —
   <https://reme.agentscope.io/en/memory_search>
7. Letta MemFS — <https://docs.letta.com/concepts/memfs/index.md> · agent memory —
   <https://docs.letta.com/agent-sdk/memory/index.md>
8. memsearch — <https://github.com/zilliztech/memsearch> · configuration —
   <https://zilliztech.github.io/memsearch/home/configuration/>
9. Claude Code memory — <https://code.claude.com/docs/en/memory.md>
10. Cursor rules — <https://cursor.com/docs/rules>
11. ChatGPT memory — <https://help.openai.com/en/articles/8590148-memory-in-chatgpt>

Local evidence:

12. `.agent-audit/memory-eval3/ACCEPTANCE.md`, `SUMMARY.md`, `LONGRUN.md`
13. `.agent-audit/memory-eval3/auto-memory-design.md`, `mnemon-design.md`, `dsh-memory-design.md`
14. `.agent-audit/memory-eval3/longrun/recallD.log`, `store-status.json`
15. `.agent-audit/memory-eval/dsh-ledger-memory/TRIAL-CHECKLIST.md`
16. Host build `app.asar` (DSH 0.2.2-rc.1): `dsh-system-prompt`, `dsh-tools`,
    `dsh-agent`, `dsh-session`, `dsh-client-connection`, `dsh-app-boot`.

Known limitation: for Mem0, Graphiti, Cognee, MemOS, OpenViking and Letta, the
"shipped behaviour" claims come from official documentation and papers, not from this
machine's source inspection. Anything that could not be confirmed is marked
"unverified" in the section that mentions it.
