#!/usr/bin/env python3
"""Correct my own false claim: the collaboration center is a PRIVATE repo.

Evidence (2026-11-14 22:30 +0800):
  E19  `gh repo view Awenforever/hermes-collab-center --json isPrivate,visibility`
       -> {"isPrivate": true, "visibility": "PRIVATE"}
  E20  anonymous `GET https://api.github.com/repos/Awenforever/hermes-collab-center`
       -> HTTP 404 (the normal answer for a private repo to an unauthenticated caller)
  E21  control: `gh repo view Awenforever/dsh-loci` -> {"isPrivate": false, "visibility": "PUBLIC"}

The prohibition on storing the token still stands, but the reason I wrote down was
wrong. GOVERNANCE §0.6 / K11 forbids secrets in documents on its own terms; git
history is also permanent and the repository could become public later.
"""
from pathlib import Path

AGENTS = Path.home() / "CollabCenter" / "AGENTS.md"
backup = AGENTS.with_suffix(".md.bak-20261114-visibility")
text = AGENTS.read_text(encoding="utf-8")
original = text

OLD = "**凭据放哪里（2026-11-14，K11）**：token **不进协作中心**——本仓库是公开的（`github.com/Awenforever/hermes-collab-center`），写进来等于公开。落点只有三处，按场景选："
NEW = """**凭据放哪里（2026-11-14，K11）**：token **不进协作中心**。

> **更正 2026-11-14 22:30（E19–E21）**：同日早先的条目写"本仓库是公开的"，那是**错的**。实测 `gh repo view Awenforever/hermes-collab-center --json isPrivate,visibility` → `{"isPrivate": true, "visibility": "PRIVATE"}`，匿名 `api.github.com` 对该仓库返回 404；对照产品仓库 `Awenforever/dsh-loci` 才是 `PUBLIC`。
> 不写入的理由**与可见性无关**，而是 K11 本身：文档不含密钥。补充两条工程理由——git 历史不可回收（写过就永久留在历史里），仓库未来可能变成公开或被整份 clone 到别处。

落点只有三处，按场景选："""

if OLD in text:
    text = text.replace(OLD, NEW, 1)
else:
    print("MISS: the sentence with the wrong claim was not found")
    raise SystemExit(1)

backup.write_text(original, encoding="utf-8")
AGENTS.write_text(text, encoding="utf-8")
print(f"corrected; backup {backup.name}")
