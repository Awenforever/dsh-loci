# dsh-loci · Loci 记忆宫殿

**给 DeepSeek Harness 的长期记忆：提示词里只放「宫殿的索引」，每个房间按需推门。**

[English](README.md) · [设计](docs/DESIGN.md) · [调研](docs/RESEARCH.md) · [运维](docs/OPERATIONS.md) · [安全](docs/SECURITY.md) · [验收](docs/ACCEPTANCE.md)

```
系统提示：  约 1.3k tokens，稳定，一条记忆一行
你问：      → loci_search "发布顺序"  → total=3，一次调用
要细节：    → loci_get m_01J…         → 全文 + 历史 + 逐字证据
```

## 为什么需要它

本机实测过的记忆插件，要么在每次请求上交固定「税」（mnemon：系统提示 +4.8KB、16 个工具），要么无界增长（ledger-memory：每轮 7KB 涨到 27KB）。便宜的又都在静默截断召回（mnemon 要 20 条只回 4 条；auto-memory 的索引约 27 条中文就触顶）。

Loci 只有一条规则：**提示词里放索引，不放记忆。**

- 空库 → **注入 0 字节**，没有标题、没有说明、什么都没有。
- 100 条 → 仍是同一段，硬字节预算，超出时明确写出「… 还有 N 条」。
- 只读回合 → 段内容逐字节不变，前缀缓存得以保留。
- 宽泛提问 → `loci_search` 返回 `total` 和 cursor，「列出全部」真的能列完。

## 它记什么

| 层 | kind | 是否注入 | 例子 |
|---|---|---|---|
| 硬约束 | `rule` | 是，排最前 | 「删除前必须做路径断言」 |
| 事实 | `semantic` | 是，索引一行 | 「生产机是 prod-01」 |
| 流程 | `procedural` | 是，索引一行 | 「发布顺序 staging → canary → 全量」 |
| 经历 | `episodic` | 是，索引一行 | 「2026-11-13 会话摘要」 |
| 工作记忆 | `working` | 否 | 只在本次会话有效的草稿事实 |

只有 `verified` 会被注入。写入时若没有来自对话的逐字引文，条目落为 **candidate**，在面板里等你点一下。

## 安装

在需要有记忆的 profile 里：

```text
设置 → 插件 → 从目录或市场条目安装，或
dsh plugin --profile <名字> add dsh-loci
```

bundle 会插入一行 Host 插件（`dsh-loci`）和一个 Client 半边。重启 Harness，然后打开 **设置 → Loci** 或侧栏的 **记忆** 面板。

侧栏底部还有一张**便签**（和额度、advisor 卡片并排），它不是看板：顶上 `更新于 <时间>`，下面一小段话，是它此刻真正理解的东西——达成的共识、踩过的经验、事实。没有数字，看到的就是"它有没有把这件事接住"。

要求：DSH `>=0.2.2-rc.1 <0.3.0-0`，Node `>=24.9.0`（Harness 自带）。无服务、无原生模块。

包里还带一个小 CLI（`snapshot`/`export`/`import`/`doctor`/`stats`/`review`/`purge`/`migrate`/`rollback`）。插件安装后它不在 PATH 上，按 profile 调用：

```text
node "$HOME/.dsh/profiles/<profile>/node_modules/dsh-loci/scripts/cli.mjs" doctor --json
```

会话里还有零 token 的斜杠命令：`/loci`、`/loci review`、`/loci doctor`、`/loci export`。

## 五个工具

| 工具 | 用途 |
|---|---|
| `loci_write` | 写入/更新一条事实。`evidenceQuote` 必须逐字；没有就落为候选。 |
| `loci_search` | 混合检索，返回 `total`、`hasMore`、`cursor`；`detail` 可选 snippet/overview/full。 |
| `loci_get` | 全文 + 修订历史 + 证据引文。 |
| `loci_forget` | 软删除（历史保留）或恢复。 |
| `loci_stats` | 计数、预算占用、通道健康、库位置。 |

工具名用 `loci_` 前缀是有意的：`ctx.tools.register` 同名会抛错，两个记忆插件都叫 `memory_search` 必然坏一个。

## 配置

配置只存在于插件自己的 Loader 行；Loci **不读项目内配置文件**。设置页里标注「即时」的字段无需重启。

| 键 | 默认 | 含义 |
|---|---|---|
| `sectionMaxBytes` | `3584` | 注入段的硬字节预算（上限 16384） |
| `rulesMaxBytes` | `1024` | 段内规则块的字节上限 |
| `defaultScope` | `workspace` | 未显式指定时的写入作用域 |
| `captureMode` | `rules` | 规则型捕获用户的明确约定 |
| `recallAssist` | `off` | 每会话一次、有上限的首轮辅助召回块 |
| `maintenanceMode` | `sweep` | 每 6 小时做 TTL、索引修复、向量补齐 |
| `secretPolicy` | `redact` | 高置信密钥脱敏，或直接拒绝写入 |
| `vectorMode` | `off` | 可选 HTTP 向量通道；词法检索始终可用 |
| `allowHardDelete` | `false` | 是否允许 CLI/面板里的 `purge` |

## 它明确不做

- v1.0 的自动路径里没有模型调用 —— 捕获与摘要是确定性的，成本可见且为零。
- 无云、无遥测；除非你配置 `vectorMode: 'http'`，否则不出网。
- 不跨项目串味：读取用显式 scope-key 集合，从不通配。
- 默认不物理删除；`purge` 需要配置开关 + 确认 + 留审计。

## 数据位置

只在 `$DSH_HOME/memory/loci/`：

```
memory.db            SQLite（WAL），事务真源
audit.jsonl          追加写：inject / recall / write / verify / delete
backups/             迁移前与手动快照（VACUUM INTO）
markdown/            人类可读投影
exports/             导出包与导入投递目录
```

卸载插件不会删除这个目录（有意为之）；真要删请自己动手。

## 许可

MIT。每个机制的研究出处见 [NOTICE](NOTICE)。
