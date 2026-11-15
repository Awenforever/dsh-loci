# PRIOR ART — 我们从别人那里借鉴什么、拒绝什么，以及为什么

- 状态：living（每次评估新插件后更新）
- 读者：本项目维护者与后续 agent（内部设计文档）
- 用途：把「看过哪些实现、为什么采纳/拒绝」记在一处，避免重复调研，也避免我凭印象做决定。

> 这份文档的存在原因：本项目一度是"用户提一个、我做一个"的反应式开发。
> 2026-11-15 的一次反问（"不要我说一个你就搞一个"）之后补上系统性盘点。

## 0. 评估基准（loci 的四条硬不变量）

一条设计值不值得抄，先过这四关。违反任何一条的，无论多流行，都不抄：

| # | 不变量 | 含义 |
|---|---|---|
| **I1** | 注入闸门 | 只有 `verified` 进提示词；candidate 必须经人核实 |
| **I2** | 前缀稳定 | 无写入时，注入段字节级不变（保 KV/prefix cache） |
| **I3** | 默认零网络 | 除两条可选出网路径外不发请求 |
| **I4** | 作用域显式 | 读永不越界；不存在"猜出来的"作用域 |

## 1. 已采纳（2026-11 三次发布）

| 来源 | 借鉴点 | 我们怎么落地 | 版本 |
|---|---|---|---|
| Claude Code memory | 索引 + 主题文件两层；正文永不入提示词 | 索引段只放 id/kind/日期/标题，正文靠 `loci_get` | 1.0 |
| mem0 | 注入字节数作为一等指标 | `request_stat.section_bytes` + 面板注入记录 | 1.0 |
| mem0 | 截断要吵，不能静默 | `total`/`hasMore`/`cursor` + "还有 N 条" | 1.x |
| supermemory | 推断事实要人审（approve/decline） | 待审队列 + `verified` 只能人工授予 | 1.3 |
| dsh-auto-memory | 4 态信任机 + 逐字证据 | candidate/verified/disputed/superseded + quote 闸门 | 1.3 |
| dsh-ltm | 修订 CAS、迁移前快照 | `expectedRevision` + `VACUUM INTO` | 1.x |
| Letta / mem0 | 用量是一等事实（不是装饰） | `memory_usage` 表：inject/read 计数 | 2.1 |
| Claude Code memory | 索引超限要显式告知 | 待审提示行（"N 条待审，故意不在此处"） | 2.1 |
| mem0 | 抽取异步、不占用户延迟 | 会话结束一次性 digest，仅写候选 | 2.3 |

## 2. 值得借鉴、尚未做（按性价比排序）

### A 级 — 建议下一版做

**A1. 教训的结构化形态（`pattern` / `fix` / `prevents`）**
- 来源：`dsh-project-memory` 的 `save_lesson`
- 问题：loci 的 `procedural` 是自由文本。半年后只看到一句话，看不出"不做会怎样"。
- 落地：schema v3 加可空列 `pattern`/`fix`/`prevents`/`when_condition`；索引行对 procedural 追加 `— prevents: …`（受 `indexLineMaxChars` 约束，默认 120）。
- 风险：索引行变长 → 触发 I2 退化？不会：只在写入时改变一次，之后字节稳定。
- 成本：低（一次迁移 + 一处渲染）。

**A2. 按活跃度淘汰"注入了但从未读"的条目**
- 来源：`dsh-memory-tiers`（六层 + "忘"是流程的一步）、`mem0`（decay 只在检索时生效）、`dsh-fish-memory`（逐条衰减）
- 问题：我们 2.1 装了电表（inject/read 计数），却没有任何策略消费它。
- 落地：`procedural` 类中 `read_count = 0 且 inject_count ≥ N` 者从索引段降级（仍可 `loci_search`），`doctor` 单列一行。
- 风险：误伤"读了但没 `loci_get`（索引行已够用）"的条目 → 用 `read_count + 被引用次数` 双阈值，并先只影响 procedural。
- 成本：中（策略 + 统计口径）。

**A3. 冲突的显式表达（而不只是 supersede）**
- 来源：`memory-eternal` / `supermemory`（`updates`/`extends`/`derives` 边 + `isLatest`）
- 问题：我们现在**只能**"新条目取代旧条目"。真实场景常是"这条改了一半"——例如"回滚窗口 30 分钟"→"回滚窗口 45 分钟，但数据库变更仍是 30 分钟"。
- 落地：`memory_edge` 表已有 `relation` 字段，但**全库只用了一个取值** `supersedes`（`store.js:405`）；补 `conflicts`/`extends` 两种即可复用现有表与索引，无需迁移。`loci_get` 显示"与 m_yyy 冲突/延伸"；注入段不改（仍旧一条），冲突在面板里呈现。
- 风险：低（只增边，不改注入）。
- 成本：中。

### B 级 — 有价值，但需要先想清楚

**B1. 报告"记忆缺失"的能力**
- 来源：`dsh-auto-memory` 的 recall funnel（注入了但从没被读）、`mem0` 的 mean tokens/query
- 想法：区分"没有这条记忆"和"有但没召回"。我们已经有 `loci_search` 的 `matchedTotal: null`，但没有"这次会话模型查了什么、没查到什么"的视图。
- 需要想清楚：这属于诊断还是产品？会不会变成又一个用户不看的统计页？

**B2. 导入/导出与跨工具互通**
- 来源：`dsh-cross-memory`（一个库接 DSH/Claude/Codex/Cursor）、Claude Code 的 `@path` 导入
- 现状：我们只做了 auto-memory 与 Claude memory 的**单向导入**。
- 需要想清楚：双向同步会引入冲突解决，而冲突解决正是 A3 还没做的。→ 先做 A3，再谈互通。

**B3. 常驻"画像"层（persona）**
- 来源：`dsh-cross-memory` 的 `persona/human.md`（会话开始注入快照，可锁定防后台改写）
- 想法：把我们散在 `global` scope 的偏好收敛成一个可锁定的小块。
- 顾虑：与索引段功能重叠；且"画像被改写"是用户最敏感的失败。**倾向不做**，除非有真实需求。

### C 级 — 明确拒绝（并记录理由）

| 拒绝项 | 来源 | 理由 |
|---|---|---|
| 条件注入（`when`/`guard` 自动触发） | `dsh-project-memory`、`supermemory` | 违反 **I2**：每步都可能改段内容，KV 前缀失效；也违反"可预测"的产品承诺。可选折中：`when_condition` 只存不判，供检索与面板显示 |
| 写入时自动 cosine 合并（0.9 覆盖） | `dsh-project-memory` | 0.9 相似也可能语义相反（"必须做 X" vs "不许做 X"）。我们保留手动 `merge` + 乐观锁 |
| 空闲"做梦"式整合 | `meow-memory`、Letta `dreaming`、`zzerx` | 后台无监督改写记忆，是"我明明没改它却变了"的来源。**必须有人在场** |
| 自动 scope 晋升（task→project→global） | `dsh-project-memory` 的两/三次晋升 | 违反 **I4**：作用域由使用次数漂移，跨项目泄漏风险不可接受 |
| 每轮全量抽取 | `zzerx`、`dsh-cross-memory` 后台抽取 | 每轮一次模型调用 + 每轮一条待审，实测会让人放弃审阅（2.3 的 digest 就是为此而生） |
| 把语料正文当注入触发源 | 多家 | 正文可被污染 → 等于让记忆内容决定自己是否入提示词 |
| 外部记忆服务（Hindsight / Honcho / supermemory 云） | `dsh-hindsight`、mnemon providers | 违反 **I3**；且我们权衡过：一次网络往返换来的召回提升不值得把记忆送出去 |
| 常驻大块（resident USER.md/MEMORY.md 全文注入） | `dsh-mnemon` | 提示词成本不可控；索引 + 按需取正文是更省的形状 |

## 3. 一条元教训（比上面任何功能都重要）

看过的 8 个 DSH 记忆插件里，**只有 2 个把"未核实不进提示词"做成代码级不变量**（loci 与 auto-memory），其余的都靠 prompt 里的劝说或干脆没有这层。
也就是说：这个品类里"功能更多"几乎总是意味着"闸门更松"。**我们不追功能数量，追的是"它出错时最坏能坏到什么程度"。**

## 4. 未覆盖的部分（诚实边界）

- 只用第一手材料评估了 7 个 DSH 插件（本地有 README/源码）+ 5 个成熟产品（文档级）。
- DSH 目录里 memory 类约 473 条，其中 `meow-memory`(~36k 下载)、`dsh-plugin-memory`(~41k)、`dsh-memento`、`dsh-prime-memory`、`dsh-fish-memory` 只从二手报告里见过描述，**未读源码**。
- 因此本表是"有依据的取舍"，不是"穷尽式技术扫描"。新插件出现后按同一张不变量表复评。
