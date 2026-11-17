# dsh-loci 生产运行手册

> 读者：维护这个插件的人（现在与将来的）。
> 用途：**回答"它现在健康吗"，以及在它不对劲时按步骤恢复**，而不是凭记忆重新推导。

## 1. 三条命令与它们的分工

| 命令 | 回答什么 | 频率 |
|---|---|---|
| `node scripts/report-production.mjs` | **它现在健康吗**——忆/记/时钟三块聚合，末尾一行结论 | 每次改动后、每天 |
| `node scripts/cli.mjs doctor` | 存储本身是否完好（schema、行数、μ 分布、向量通道） | 同上 |
| `node scripts/eval-memory.mjs` | 两个半边的**能力**有没有退化（召回/改述/换词上限/记/门/μ 分布） | 每个版本 |

`report-production.mjs --json` 输出机器可读版本，供后续趋势分析。

**结论行的判读顺序**（按"会让产品变错"而非"看起来闲"排序）：审计行损坏 → 失败事件 → 忆完全静默 →
记从未触发 → 冷带增长且退役关闭 → 换词只触发从不命中 → 健康。

## 2. 一条必须区分的界线

**墙钟只用于分组活动，不用于做决定。**

- 报表里的"最近 24 小时"是**运维口径**，用来区分"正在跑"与"三天前停了"；
- 产品内部**没有任何**按日历决定的行为：过期、排序、呈现全部用记忆单位（见 `docs/MEMORY-UNITS.md`）。

改代码时若看到 `Date.now()` 参与"该不该保留 / 该不该排前 / 该显示多旧"的判断，那就是 bug。

## 3. 已知非原子操作：`remove_bundle`

**`remove_bundle` 不是原子的。** 实测两次：它报 `application: failed`，但插件条目、`package.json` 的
`dsh.profile.bundles` 项、`cordis.patch.yml` 条目**已经删掉了**。

因此：**每次 `remove_bundle` 之后立刻查完整性，不要等 install 之后再查。**

```powershell
node scripts/diag/profile-state.mjs
# 期望：current bundles 14 / duplicates [] / loci in bundles true / loci spec <ver>
```

三项都要满足才算注册完整：

| 检查点 | 位置 | 缺了会怎样 |
|---|---|---|
| `dependencies['dsh-loci']` | `~/.dsh/profiles/desktop/package.json` | pnpm 不知道要装 |
| `dsh.profile.bundles` 含 `dsh-loci` | 同上 | **能加载但不算 bundle**（中间态） |
| `- id: dsh-loci` 条目 | `cordis.patch.yml` | 完全不加载 |

### 恢复步骤（网络受限时也可用）

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"

# 1. 备份三件套
Copy-Item "$prof\package.json"      "$prof\package.json.bak-$(Get-Date -f yyyyMMddHHmm)"
Copy-Item "$prof\cordis.patch.yml"  "$prof\cordis.patch.yml.bak-$(Get-Date -f yyyyMMddHHmm)"

# 2. 补 cordis.patch.yml 条目（放在任一同类条目旁）
#    - id: dsh-loci
#      name: dsh-loci

# 3. 把 dsh-loci 插回 bundles 数组
node -e "const fs=require('fs'),p=process.argv[1]+'/package.json';const j=JSON.parse(fs.readFileSync(p));const b=j.dsh.profile.bundles;if(!b.includes('dsh-loci')){b.splice(b.indexOf('dsh-codex-advisor'),0,'dsh-loci');fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');}" $prof

# 4. 验证
node scripts/diag/profile-state.mjs
node scripts/cli.mjs doctor
```

## 4. 部署完整性：磁盘内容是否等于发布制品

手工同步过后必须验证，否则"跑的是 5.0.3"只是声明而非事实：

```powershell
# 下载发布 tarball 并与已安装目录逐文件比对
node scripts/diag/deploy-integrity.mjs
```

判据：**安装目录与 tarball 的文件集合与 SHA256 完全一致**（实测 5.0.3：62 文件，0 差异，0 多余）。

## 5. 网络与 pnpm 策略

两个反复出现的坑：

1. **`minimumReleaseAge` 在解析阶段直接失败**（`RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`），
   显示为内部错误而不是"版本太新"。根因常是**别的会话升过的版本**不在 `pnpm-workspace.yaml` 的
   `minimumReleaseAgeExclude` 里。新版本发布后需要手工把版本加进去。
2. **codex-advisor 的 GitHub tarball 间歇失败**会让任何一次 pnpm 操作失败，包括**删除一个无关
   插件**。预热要打 **pnpm 真正取的那个 URL**：
   `https://github.com/Awenforever/dsh-codex-advisor/archive/refs/tags/<tag>.tar.gz`
   （不是 `codeload.` 那个）。

## 6. 版本发布的机械步骤

1. `package.json` / `src/host/index.js` 的 `VERSION` / `src/mcp/store-facade.js` 的 `pluginVersion` 三处同时改
2. `npm install --package-lock-only --no-audit --no-fund`
3. `node scripts/check-swallowed.mjs && npm test && node scripts/check-manifest.mjs`
4. 提交 → 推 main → 打 tag → **推 tag 之后等 20 秒再查 workflow**（tag 与 main 相差数秒会让
   release 报 `the tag must be on main`；用 `gh run rerun <id>` 重跑即可）
5. 把新版本加入 `minimumReleaseAgeExclude`

## 6.1 回滚：版本退回去会发生什么

**惯例是"能退回去才算能投产"**，所以这一节是实测的，不是推测。验证脚本：
`node scripts/diag/rollback-check.mjs`（在**副本**上跑，不碰生产库）。

### 两种退法，代价不同

**A. 只退插件版本、不退 schema**（推荐）

SQLite 忽略不认识的列，所以旧的 5.1.x 能正常读写一个 v8 库——实测旧式 SELECT 正常返回。
唯一的风险是**旧版本不认识 `applies`**，于是 core 退回"所有 rule 都常驻"的旧行为。

> 代价：回到每轮塞满规则的旧观感，但**数据无损**。

**B. 连 schema 一起退**

必须**先删索引再删列**。顺序错了会卡在中间态：

```
DROP COLUMN applies  →  error in index ix_memory_applies
                      →  列没删掉，于是再 ADD COLUMN 报 duplicate column
```

正确步骤（已在副本上验证通过）：

```sql
DROP INDEX IF EXISTS ix_memory_applies;      -- 必须先
ALTER TABLE memory DROP COLUMN applies;      -- 再删列
UPDATE meta SET value = '7' WHERE key = 'schema_version';
PRAGMA user_version = 7;
```

> 代价有两个，都要先知道：
> 1. **分类全部丢失**：重新迁移回来时 52 条全是 `topic`，4 条 `always` 需要手工重新标注；
> 2. 回滚本身可逆（再走一次 v7→v8 迁移即可），但**只有内容无损，判断有损**。

所以除非库已经坏到读不出来，**优先用 A**。

## 7. 隐私与边界（不可越过）

- 只有 `verified` 条目进入提示词；`disputed` 留档但永不注入。
- 信任来自**引文接地**（逐字出现在用户消息里），不来自点击。
- 记忆管理者自己**不接受任何注入**（`injection_exempt` 是存储事实）。
- 指令形状的文本在任何作用域都保持 `disputed`；提示词段永远 `interpolate:false`。
- 审计记录**不含正文**；`curate` 失败时记 `rawHead`（截断 160 字符），是形状而非转录。

## 8. 当前已知缺口（生产可接受，但要知道）

| 缺口 | 影响 | 计划 |
|---|---|---|
| **模型是否真的会填 `applies`，尚无证据** | 若答案是"不会"，`applies` 会变成第二个 `importance`：字段在、参与排序、恒为默认值 | `supplied` 审计字段 5.2.2 起记录；等一次真实写入即可判定 |
| `CORE_MAX_ENTRIES=6` 未校准 | core 能放几条是拍的；`applies` 上线前的统计都是旧系统产物，不能当依据 | 用 `applies` 上线后的干净样本测 |
| `importance` 自动修正未实现 | 判定只能靠写入时的猜测 | 需真实的 update/forget 信号（现有的 5 条 revision>1 全是迁移造成） |
| 四带边界与 `muRetireAfter=0` 未校准 | 冷带增长时无自动压缩，库单向增长 | 边界已改为按分布推导；退役**按规则拒绝**推导（见 `MEMORY-UNITS.md` §7） |
| 压缩动力学未实现 | 同上 | 另立目标（`docs/MEMORY-UNITS.md` §5.2）；判据已明确：**不能依赖 `read_count`** |
| 「忆多少」预算无收益测量（R27） | 方向已修正：预算不是瓶颈（实测 core 823 B / 上限 1500，slice 从没用满） | 真正该测的是候选召回率，不是上限 |
| 答案质量与 token 成本（R18） | 已有首组数字：记忆把 wrong 变成 correct（2/2），成本 +318~637 B | 样本仍小；控制题显示模型会编造，须并报 |

