---
name: writing-loop-operator
description: >-
  Operate writing-loop (autonomous short-drama writers' room) from any agent harness:
  install the engine, initialize a workspace, run/pause the daemon, read progress,
  adjust config safely, and troubleshoot. Load this skill, then drive everything
  through the `writing-loop` CLI with the recipes below. 安装引擎、立项、启停 daemon、
  判读进展、安全改配置、排障——全部通过 shell 命令完成，不依赖任何特定 harness 机制。
---

# writing-loop 操作者手册（harness 中立）

本 skill 是 writing-loop 的**第一分发物**：任何能执行 shell 的 agent harness（Claude Code、
Codex、opencode 或其他）载入后，按本文操作即可获得完整的 writing-loop 能力。引擎本体是
npm 包 `@dyzsasd/writing-loop`——**由本 skill 负责安装**，不是反过来。

**架构一分钟版**：writing-loop 是一个自治编剧团队。十个无状态 agent（showrunner／
story-designer／episode-writer／reviewer 等）由包内调度器 `wl-run` 按车道门控逐个点火
（fire）；每次 fire 是一条 `claude -p '<调度器上下文 + 该角色 SKILL 全文 + 规约节选>'`
的一次性进程——**agent 侧 skill 打包在 npm 包内、fire 时内联进 prompt，任何机器都无需
单独安装写作侧组件**。协作真相源是文件票板（`.writing-loop/<项目>/board/`）与剧本 git
repo；成本与健康遥测在 `fires.jsonl` 与 `run-state.json`。

---

## §1 环境检查与安装（每台新机器先跑这个）

```bash
bash "$(dirname "$0")/scripts/ensure-install.sh"   # 从本 skill 目录运行
# 或指定安装源：WRITING_LOOP_INSTALL_SOURCE=/path/to/writing-loop-x.y.z.tgz bash scripts/ensure-install.sh
```

脚本幂等，做四件事：① node ≥ 20.11 检查；② `claude` CLI 存在性检查（写作车道的唯一
harness 依赖）；③ `writing-loop` 未安装则装（npm 源 → `WRITING_LOOP_INSTALL_SOURCE`
tarball → git clone+build 三级回退）；④ `writing-loop doctor` 收口（末行必须
`WRITING_LOOP_DOCTOR_OK`）。

**唯一无法自动化的步骤**：`claude` CLI 的账号登录是交互式的——新机器上让操作者跑一次
`claude`（进入交互界面完成 login）即可。额度状态可用 `claude -p "hi" --model haiku` 冒烟。

## §2 初始化 workspace 与立项

```bash
mkdir -p ~/dramas && cd ~/dramas
writing-loop init                      # 铺 .writing-loop/ 骨架，幂等
```

立项两条路径任选：
- **采访式（推荐给人类）**：`writing-loop studio --port 18791 --single` 起工作台，浏览器
  打开 `http://127.0.0.1:18791` 走立项采访。
- **headless（适合 agent）**：写一份 `request.json`（schema 与样例见包内
  `docs/GUIDE.zh-CN.md` 的立项一节），然后两步确认制：
  ```bash
  writing-loop project plan --input request.json        # 零写入预览，返回 PLAN_ID 指纹
  writing-loop project create --input request.json --confirm <PLAN_ID>
  writing-loop project verify <项目KEY>                  # 独立核验落盘布局
  ```
原著登记同型：`writing-loop source plan/register/status`（先 plan 后 register --confirm）。

## §3 启动与停止 daemon

**探测顺序：systemd --user（Linux 服务器首选）→ launchd（macOS）→ nohup 前台托管。**

### systemd（模板在本 skill `templates/systemd/`）
```bash
cp templates/systemd/writing-loop@.service templates/systemd/writing-loop-studio.service \
   ~/.config/systemd/user/
# 按实际路径改两处 Environment=PATH 与 WRITING_LOOP_WORKSPACE，然后：
systemctl --user daemon-reload
systemctl --user enable --now writing-loop@<项目KEY> writing-loop-studio
loginctl enable-linger "$USER"        # 登出/重启后仍自动拉起
```

### launchd（macOS，模板在 `templates/launchd/`）
```bash
cp templates/launchd/com.writing-loop.scheduler.plist ~/Library/LaunchAgents/
# 改 plist 内的 WorkingDirectory / PATH / 项目 KEY，然后：
launchctl load -w ~/Library/LaunchAgents/com.writing-loop.scheduler.plist
```

### 无 init 系统（临时/容器）
```bash
cd <workspace> && nohup writing-loop run --project <KEY> >> wl-run.log 2>&1 &
```

**暂停与恢复（不杀在飞 fire 的优雅方式）**：
```bash
writing-loop project disable <KEY>    # 不再起新 fire，在飞 fire 自然收尾后调度器退出
writing-loop project enable <KEY> && systemctl --user restart writing-loop@<KEY>   # 恢复
```

## §4 进展判读（日常监控口径）

```bash
writing-loop status --project <KEY>    # 板计数 / In Review / 停靠票 / 写作前沿 / 陈旧锁 / 末5 fire
writing-loop fires --project <KEY>     # 遥测：按 agent 成功率 + token/成本 + 近24h $/集与治理占比 WARN
writing-loop doctor                    # 只读体检，末行 WRITING_LOOP_DOCTOR_OK
writing-loop run --project <KEY> --dry-run   # 零 token 预演各车道门控（诊断「为什么不点火」）
```

关键读数与阈值：
- **写作前沿** = `episodes/ep-*.md` 最大集号；前沿 45 分钟无任何 fire 推进即算停滞，排查。
- **熔断器**：`run-state.json` 的 `circuit` 块。`status:"open"` = 连续 CLI 硬失败（限额/
  认证/坏二进制），调度器已暂停并按指数退避放探针；`reason` 字段有失败原文（限额类去
  claude.ai/settings/usage 处理，恢复后 ≤30 分钟自动复工，无需人工干预）。
- **fires 尾巴**：非零退出且时长 <30s 零成本 = CLI 启动即死（看熔断器）；exit 143 且时长
  ≈ capSeconds = fire 超时被杀（正文类通常已增量 commit，损失有限）；`spawn!` = 二进制损坏。
- **停靠票**：`needs-*` + `blocked` 是 agent 求助；标题带【需操作者裁定】或票面
  `Bail-shape: decision-needed` 的必须人类/操作者代理答复——在票面追加
  `### <ISO时间> — operator（由 <你> 转录）` 格式的评论即可，解除停靠由 showrunner 执行。
- **agent 写入期间**的 repo 临时 dirty/untracked 不是异常；只有 fire 结束后遗留才要报。

## §5 配置调整（有停机纪律！）

配置在 `<workspace>/.writing-loop/config.json`。常调三处：
- `scheduler.agents.<角色>.{model,effort,capSeconds}`——模型档位与单 fire 墙钟上限；
- `scheduler.keystoneReviewer`——keystone 票的审读升档；
- `projects.<KEY>.contextPack.{maxBytes,perAgent}`——Context Pack 字节预算。

**纪律：调度器只在启动时读这些**。改完必须在 `run-state.json` 的 `inFlight` 为空的窗口
`systemctl --user restart writing-loop@<KEY>`（或先 `project disable` 排空再改再启）。
绝不在有在飞 fire 时 restart——会 TERM 掉在途写作。

## §6 升级与开发

- **纯使用**：`npm i -g @dyzsasd/writing-loop@latest`，然后按 §5 纪律择窗重启。
- **开发形态**（源码 checkout + `npm i -g .` 符号链接）有一条铁律：`npm run build` 会
  先删再建包内 `dist/ skills/ references/`，而调度器每次 fire 都读 `skills/`——**build
  绝不与运行中的调度器重叠**。顺序：跑完非 build 测试 → 等 inFlight 空 →
  `systemctl --user stop` → `node test/build-artifact.ts` → `npm i -g .` → start。

## §7 故障手册（全部实战案例）

| 症状 | 判定 | 处置 |
|---|---|---|
| 全部 fire 秒级 exit 1 零 token | 账号限额/认证（看熔断器 reason 原文） | 限额：claude.ai 充值或等重置，熔断器自动恢复；认证：机器上重跑 `claude` 登录 |
| fires 出现 `spawn!` | claude 二进制损坏（常见于自动更新中断） | `npm i -g @anthropic-ai/claude-code` 重装；恢复即自愈（spawn 失败每 tick 重试） |
| status 报陈旧锁（>60min） | 持锁进程已死（OOM/被杀） | 确认 `wl-run.lock` 内 pid 不存在后移走锁文件再启调度器；板票锁/repo 锁同理 |
| 前沿停滞但 fire 正常 | 多为 Blocked-by 链或停靠票等裁定 | `writing-loop status` 看停靠票；裁定类按 §4 格式回票 |
| fire 超时 exit 143 且时长=cap | 单 fire 活太重 | 看正文是否已增量 commit（通常是）；反复发生则按 §5 调大该角色 capSeconds |
| 调度器进程消失、锁在 | 宿主重启/OOM | 清陈旧锁 → `systemctl --user start`；linger 开着的话 systemd 会自动拉起 |

## §8 平台问题投递

agent 或操作者发现的**框架级**问题（调度器/CLI/门控缺陷）不进剧集票板——投系统改进收件箱：
`writing-loop system proposal list` 查看；修复流程见仓库 CLAUDE 工程约定（每个修复配
修复前可复现的回归测试）。
