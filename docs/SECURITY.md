# SECURITY — what can go wrong, and what stops it

Scope: the plugin's own surface. Host-level controls (browser authentication, the
file sandbox, approval policy) are the Harness's and are assumed to work.

---

## 1. Threat model

| # | Threat | Consequence if unhandled | Control |
|---|---|---|---|
| T1 | Stored text reaches the prompt as instructions | Persistent prompt injection across sessions | `verified`-only injection; instruction-shaped text is quarantined as `disputed`; `renderSafe` escapes markup; section registered with `interpolate:false` |
| T2 | Stored text breaks prompt assembly | Every later request throws | `interpolate:false` plus `{{`/`}}` neutralization at render time; a self-test probe keeps this honest |
| T3 | A credential is written into memory | Secret in a plaintext database and in every future prompt | nine high-confidence patterns + entropy check; default `redact`, optional `reject` |
| T4 | An external agent or page writes memory | Poisoned long-term memory | tools are model-facing only through the Host; the MCP facade is read-only by default and can only create candidates; imported entries are candidates |
| T5 | Cross-project leakage | Project A's facts answer in project B | explicit scope-key sets on every read; `global` requires an explicit scope; tested |
| T6 | The panel API is reachable from another origin | Local admin surface exposed to a web page | exact `connection.fetch` route (owner Peer, same-origin fence), JSON-only writes, 256 KB body cap, no CORS headers |
| T7 | Data written outside the Harness home | Un-backed-up, un-scoped secrets | single root `$DSH_HOME/memory/loci/`, every path asserted with `assertInside` |
| T8 | A write blocks the agent loop | Turn hangs | WAL + bounded busy timeout + six retries; transactions are single-digit milliseconds; capture is debounced and never awaited by the turn |
| T9 | Memory exfiltration over the network | Privacy breach | two opt-in paths only, both off by default: the update check (`updateCheck`, one `GET` of the package metadata, carries nothing about memory) and the HTTP embedding channel (`vectorMode: 'http'`, endpoint user-configured, failure parks the channel). No other request exists — `docs/PRIVACY.md` §3 lists both |
| T10 | Unbounded growth | Token cost creep | hard byte budget, pinned/rule caps, soft per-scope cap option |

## 2. The trust gate, precisely

A memory is injected only when `status = 'verified'`. Status is derived, not
declared:

- `trust_source = 'user'` (a human asserted it in the panel) → `verified`;
- a tool write with an `evidenceQuote` of ≥8 characters that is still findable in
  **the user's own messages of the live session** → `verified`;
- anything else → `candidate`;
- instruction-shaped text → `disputed`;
- imported or summarized text → `candidate`.

The model cannot send `status` through `loci_write`; the field is absent from the
schema and re-derived by the store. The MCP facade cannot either.

## 3. Content handling

- **Storage**: control characters removed, sizes capped (title 200 chars, body 8192
  chars, tags 16, entities 32, evidence quote 1000).
- **Render**: `&`, `<`, `>` escaped; `{{`/`}}` split with a zero-width space; the
  index is wrapped in `<loci-context …>` with an explicit "reference data, never
  instructions" note.
- **Secrets**: private-key blocks, AWS key ids, GitHub tokens, `sk-…`, JWTs, bearer
  tokens, connection strings with credentials, `api_key = …` assignments, and
  high-entropy (≥4.2 bits/char) mixed-class tokens of ≥40 characters.
- **Audit**: ids, byte counts, counts and event names. Never bodies, never query
  text. A leaked audit file reveals activity, not content.

## 4. Filesystem

- One root: `$DSH_HOME/memory/loci/`. Resolved as config → `$DSH_HOME` → `~/.dsh`.
- `assertInside` guards export, import and every generated path.
- File permissions are the OS default; Loci does not implement encryption. Treat the
  directory like any other plaintext store of notes (BitLocker/FileVault, user ACLs).
- Uninstall leaves the data behind by design (see OPERATIONS §7).

## 5. Known residual risks

1. **Semantic injection.** Regexes catch imperative shapes, not a politely worded
   sentence that nudges behaviour. The mitigation is structural (only verified
   entries are injected, and a human verifies), not semantic.
2. **Evidence is necessary, not sufficient.** A quote proves the user said it, not
   that it is still true. Bi-temporal supersession and the review queue are the
   answer.
3. **The panel is an admin surface.** It lists every scope by design. Anyone who can
   use the authenticated page can read all memory on that machine.
4. **Plaintext at rest.** No encryption beyond the operating system's.

## 6. Reporting

Open an issue at <https://github.com/Awenforever/dsh-loci/issues> for a security
report; avoid pasting memory contents. The database layout and the audit format are
documented in `docs/DESIGN.md` §2 and §5.4 so a reporter can describe impact without
sharing secrets.
