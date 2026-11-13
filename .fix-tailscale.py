#!/usr/bin/env python3
"""Correct stale proxy facts in ~/Work/Tailscale/README.md.

Every replacement is a *factual* field update backed by a command run on
invictus (DESKTOP-KFSCV8C, 100.126.54.11) at 2026-11-14 00:50–01:05 +0800:

  E1  Get-NetTCPConnection -State Listen -LocalPort 7892 -> jilianyunCore (pid 22908)
  E2  Win32_Service jilianyunHelperService: Running / Auto / D:\\Programs\\jilianyun\\jilianyunHelperService.exe
  E3  Yinyun 1.2.8 (YinYun.Ltd) running from %LOCALAPPDATA%\\Programs\\yinyun-windows,
      started 2026-10-27, does NOT hold 7892
  E4  HKCU Run electron.app.Yinyun -> Yinyun.exe (still autostarts)
  E5  HKCU Internet Settings ProxyServer = 127.0.0.1:7892, ProxyEnable = 1
  E6  tailscale serve status -> tcp://100.126.54.11:17897 --> tcp://127.0.0.1:7892
  E7  netsh portproxy: 127.0.0.1:3799 -> 127.0.0.1:7892 ; 192.168.231.1:18897 -> 127.0.0.1:7892
  E8  curl -x http://127.0.0.1:3799 https://api.ipify.org -> 23.146.72.151
  E9  system-proxy-follow.log last write 2026-11-13 20:50:23; Get-ScheduledTask shows no
      SystemProxyFollow task for this user; schtasks /query is Access denied without elevation
      -> task registration state UNVERIFIED from a non-elevated shell

GOVERNANCE §8 allows a factual correction by any agent that can show evidence.
Structural edits are not made here. The dated line is appended, the old claim is
replaced in place, and nothing else in the document is touched.
"""
from pathlib import Path

README = Path.home() / "Work" / "Tailscale" / "README.md"
backup = README.with_suffix(".md.bak-20261114-proxycli")
text = README.read_text(encoding="utf-8")
original = text

REPLACEMENTS = [
    # §1.1 node table
    (
        "| 代理出口 Yinyun + `tailscale serve 17897`；VMnet8 桥 `18897` |",
        "| 代理出口 **jilianyun（极联云）** + `tailscale serve 17897`；VMnet8 桥 `18897` |",
    ),
    # §1.2 key endpoints
    (
        "| 宿主机当前实际上游 | `tcp://127.0.0.1:<动态端口>` | Yinyun 的系统代理端口,每次重启变化;用 `tailscale serve status` 读 |",
        "| 宿主机当前实际上游 | `tcp://127.0.0.1:<动态端口>` | 当前代理核心的系统代理端口（2026-11-14 实测 `7892`，jilianyunCore）;每次重启可能变化,用 `tailscale serve status` 或注册表读 |",
    ),
    # §2.1 data-flow diagram
    (
        "Yinyun 系统代理 127.0.0.1:<动态端口>",
        "代理核心系统代理 127.0.0.1:<动态端口>（现:jilianyun 7892）",
    ),
    # §3.1 the client section itself
    (
        """### 3.1 真实代理客户端:Yinyun

- 可执行文件:`%LOCALAPPDATA%\\Programs\\yinyun-windows\\Yinyun.exe`
- 配置:`%APPDATA%\\yinyun-windows\\config.yml`(协议 zerowall,`direct_countries: CN`)
- 接管时把 **Windows 系统代理**设为 `127.0.0.1:<随机端口>`;**该端口每次 Yinyun 重启都会变**。
- 分流/选节点全部在 Yinyun 内部完成;tailnet 客户端只负责把境外流量送到 17897。""",
        """### 3.1 真实代理客户端:jilianyun(极联云);Yinyun 为遗留安装

> 更正 2026-11-14 01:00 +0800（E1–E5）。旧版本本节写"真实代理客户端:Yinyun",已不成立。

- **当前持有系统代理端口的是 jilianyun**:`7892` 监听属 `jilianyunCore`(pid 22908,2026-11-10 14:47 启动);服务 `jilianyunHelperService` = Running / Auto,镜像 `D:\\Programs\\jilianyun\\jilianyunHelperService.exe`(E1/E2)。
- 配置目录:`%APPDATA%\\jilianyun`、`%LOCALAPPDATA%\\jilianyun`(E2)。
- 系统代理:`HKCU\\...\\Internet Settings` = `127.0.0.1:7892`,`ProxyEnable=1`(E5)。端口仍可能随核心重启变化,读注册表或 `tailscale serve status` 为准。
- **Yinyun 仍在运行且仍自启动**:`Yinyun.exe` 1.2.8(YinYun.Ltd,`%LOCALAPPDATA%\\Programs\\yinyun-windows`),2026-10-27 起常驻,`HKCU\\...\\Run\\electron.app.Yinyun` 仍在(E3/E4);但它**不再持有 7892**。两个客户端并存,接管冲突时先看谁持有系统代理端口,不要按进程名判断。
- 分流/选节点在代理客户端内部完成;tailnet 客户端只负责把境外流量送到 17897。
- 出口实测:`curl -x http://127.0.0.1:3799 https://api.ipify.org` → `23.146.72.151`(E8)。""",
    ),
    # §5 inventory table
    (
        "| `%LOCALAPPDATA%\\Programs\\yinyun-windows\\Yinyun.exe` | 真实代理客户端 | LIVE(经 serve 间接) |",
        "| `D:\\Programs\\jilianyun\\jilianyunCore.exe` | 真实代理客户端核心(持有 7892) | LIVE |\n| `%LOCALAPPDATA%\\Programs\\yinyun-windows\\Yinyun.exe` | 遗留代理客户端(仍自启动、不持有 7892) | LIVE(闲置) |",
    ),
    # §12.3 troubleshooting
    (
        "- 上游:`tailscale serve status` 看 17897 是否指向当前 Yinyun 端口;Yinyun 是否在跑。",
        "- 上游:`tailscale serve status` 看 17897 是否指向当前系统代理端口(2026-11-14 为 `127.0.0.1:7892`);再用 `Get-NetTCPConnection -LocalPort 7892` 确认**哪个**客户端持有它——现为 `jilianyunCore`,`Yinyun.exe` 在跑但不持有。",
    ),
]

changed = 0
for old, new in REPLACEMENTS:
    if old in text:
        text = text.replace(old, new, 1)
        changed += 1
    else:
        print(f"MISS: {old[:60]!r}")

# §3.2 watchdog: record what is and is not verified about the task.
ANCHOR = "- 计划任务 `SystemProxyFollow`:`SYSTEM` / `BootTrigger` / 不要求登录 / `Highest`;`ExecutionTimeLimit=0`、失败每分钟重启(999 次)、`IgnoreNew`、`StartWhenAvailable`、电池不停止。"
NOTE = (
    ANCHOR
    + "\n- **2026-11-14 复核（E9）**:非提权 shell 下 `Get-ScheduledTask` 已看不到 `SystemProxyFollow` 任务"
    "（`schtasks /query` 返回 Access denied,需要管理员）;脚本、日志、portproxy 规则仍在,日志最后写入 2026-11-13 20:50:23。"
    "**任务的注册/运行状态 UNVERIFIED**——下次提权复核;在此之前不要假设看门狗一定在跟。"
)
if ANCHOR in text:
    text = text.replace(ANCHOR, NOTE, 1)
    changed += 1
else:
    print("MISS: watchdog anchor")

if text == original:
    print("nothing changed")
    raise SystemExit(1)

backup.write_text(original, encoding="utf-8")
README.write_text(text, encoding="utf-8")
print(f"applied {changed} replacement(s); backup at {backup.name}")
