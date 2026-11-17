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

## 7. 隐私与边界（不可越过）

- 只有 `verified` 条目进入提示词；`disputed` 留档但永不注入。
- 信任来自**引文接地**（逐字出现在用户消息里），不来自点击。
- 记忆管理者自己**不接受任何注入**（`injection_exempt` 是存储事实）。
- 指令形状的文本在任何作用域都保持 `disputed`；提示词段永远 `interpolate:false`。
- 审计记录**不含正文**；`curate` 失败时记 `rawHead`（截断 160 字符），是形状而非转录。

## 8. 当前已知缺口（生产可接受，但要知道）

| 缺口 | 影响 | 计划 |
|---|---|---|
| 四带边界 5/50/500 与 `muRetireAfter=0` 未校准 | 冷带增长时无自动压缩，库单向增长 | 用真实分布校准（`report-production` 的 bands） |
| 压缩动力学未实现 | 同上 | 另立目标（`docs/MEMORY-UNITS.md` §5.2） |
| 「忆多少」预算无收益测量（R27） | 1200 B / 8 条是拍的 | 需 A/B 测量 |
| 答案质量与 token 成本未测（R18） | 不知道记忆对答案的贡献 | 本目标的第 4 项 |
