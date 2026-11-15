# ACCEPTANCE — measured results

> **Two sections, two versions, and they must not be mixed.**
> §A is the original v1.0.0 acceptance. §B is the 2.6.0 re-run, which exists because §A
> turned out to measure something narrower than its headline claimed. Where they disagree,
> §B is the current answer.

---

# A. v1.0.0 (historical)

Everything below was measured on **v1.0.0**. The tree is 2.6.x: schema v3, auto-verified
capture, the pending-review notice, lesson fields, the review-kind filter and the two-part
quote gate all landed afterwards. Treat this as a record of what was true then.

## A.1 The claims that were overstated

The row below used to read `Recall accuracy — PASS — single 49/50 = 98%`. That sentence
was doing more work than the experiment behind it:

- **The question contained the entry title verbatim.** `singleQuestion()` built
  `根据长期记忆回答：${entry.title}这条约定的具体内容是什么？`, and the title is exactly what
  the injected index lists. A model could succeed by pattern-matching the index, or by
  searching for words the question had just handed it.
- **The corpus fixture was readable from the agent's workspace.** `test/fixtures/corpus.mjs`
  holds every body and every expected keyword, and the harness spawned sessions from the
  repo with no `cwd` override.
- **There was no no-memory arm.** Every run had the plugin on, so nothing distinguished
  "the answer came from memory" from "the model already knew, or looked at the fixture".
- **Two of the e2e "checks" were `record(..., true)`** — literal `pass: true`, unable to
  fail.

## A.2 The v1.0.0 table, kept for the record

| # | Area | v1.0.0 result | Status now |
|---|---|---|---|
| 1 | Seeded-corpus keyword recall (**not** an evaluation of whether memory helps) | single 49/50, multi 10/10, broad 50/50 — see A.1 for what limits this | **superseded by §B** |
| 2 | Injection cost | 0 B empty; 3,450–3,507 B steady; ~1.2k tokens (prose only, never an artifact) | re-measured in §B.3 |
| 3 | Concurrency and crash | 200/200 rows, 0 lock errors, kill -9 recoverable | unchanged, still valid |
| 4 | Migration and rollback | rehearsal upgrade + snapshot restore, row-identical | unchanged, still valid |
| 5 | Security | secrets redacted, instruction text quarantined, `{{}}` inert | re-checked by `loci doctor` on every run since 2.4.1 |
| 6 | Platform | Windows 11 (Node 24.13) + Ubuntu 24.04 (Node 24.22, WSL) both green | unchanged, still valid |

---

# B. 2.6.0 re-run

Produced by `scripts/acceptance-v2.mjs` (deterministic half) plus three blind answer arms.
Reproduce the deterministic half with:

```
node scripts/acceptance-v2.mjs [--json]
```

## B.1 What changed in the method

| Defect in the v1.0.0 harness | What the re-run does instead |
|---|---|
| question contains the title | every question avoids both the title and the answer |
| corpus readable from the workspace | corpus is generated in memory and seeded straight into a throwaway store |
| `void scratch` — a temp home created and discarded, so levels shared one store | each level gets its own home, and the seed count is asserted |
| `seedCorpus(...).slice(count)` does not limit seeding (a "20 entry" row had 51) | asserted on `memory_head` before measuring |
| no no-memory arm | an explicit no-memory arm (§B.4) |
| `record(..., true)` | both replaced with real assertions |

## B.2 Retrieval is two channels, not one score

30 facts. Each question was written so it shares **no character bigram** with its target
title — verified directly: for `"我们每周哪个时间段可以做上线？"` against
`"发布窗口固定在周四凌晨两点"` the shared-token set is empty.

| Channel | What it is | Result |
|---|---|---|
| **A. lexical search** | what a tool call (`loci_search`) sees | **0/30 top-1, 0/30 top-3, 30 missed** |
| **B. injected index** | what the model reads on every request | **30/30 present** |

This is the finding that matters, and it cuts both ways:

- **A paraphrase with no shared vocabulary cannot be found by search.** Not degraded — 
  zero. The v1.0.0 number hid this completely.
- **The index is the channel that carries the fact**, which is the entire reason the
  product injects titles and puts bodies behind a lookup. Search is not the primary path.

## B.3 Cost

| Entries | Section bytes |
|---|---|
| 0 | **0** |
| 10 | 1,081 |
| 30 | 2,781 |

The byte budget holds (`sectionMaxBytes` default 3,584). Token counts are **not** reported
here: the only token figures in this repo are prose (`§A.2`), no committed artifact or code
path measures them, and the Host's own `cacheReadTokens`/`cacheWriteTokens` are not read by
anything in this plugin.

## B.4 Does the index actually let a model answer?

Three blind arms, 20 questions about a fictional project whose facts exist **nowhere in this
repository**, so the model cannot read them. Same model family as the Host session.
Each arm answered in one turn with no tools.

| Arm | What the model got | Correct | Behaviour |
|---|---|---|---|
| **A — no memory** | the 20 questions only | **0/20** | answered `UNKNOWN` to all 20 — it abstained rather than hallucinating |
| **B — index only** | the 20 questions + 20 index lines whose titles *are* the facts | **20/20** | answered every question with the exact value |
| **C — index + fetch** | 12 index lines whose titles are *summaries*; the values are only in bodies; allowed to request ids | asked for **12/12** ids | did not discriminate — requested the whole index |

Read honestly:

- **Memory is worth something measurable.** A is 0/20 and B is 20/20 on the same questions.
  The difference is the index, and nothing else varied.
- **The abstention in arm A is a good sign.** The model did not invent values; a
  memory-less assistant says "I don't know" instead of confabulating. So the value here is
  recall, not anti-hallucination.
- **Arm C is the warning.** When titles are summaries, a model facing 12 entries fetches all
  12. That is fine at 12 and untenable at 200: the "index keeps the prompt small" argument
  collapses if the model's response to ambiguity is to pull the whole store. Narrowing that
  is a design problem, not a formatting problem.

## B.5 What §B still does not measure

- **The Host's real injection path.** The three arms were run with the index text pasted
  into a prompt, not through a `dsh` session. The forwarding, ordering and byte budget are
  covered by unit tests and the §A.3 concurrency run, but "the model answers inside DSH"
  was not re-observed end to end here.
- **Tokens per answered question.** The decisive cost number (index-only vs bodies, including
  the extra tool turn) needs a Host session with usage reporting. Not measured.
- **Long-run behaviour.** One store size, one session's worth of interaction. Whether a
  reviewed queue actually stays reviewed over weeks is a usage study, not a benchmark.
- **Retrieval on real user vocabulary.** The corpus and the questions were written by the
  same author, which is a confound even though the vocabulary was deliberately disjoint.
