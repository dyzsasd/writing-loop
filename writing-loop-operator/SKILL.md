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

## §3a 视频生产 gateway 部署（两台主机）

远端制片分两台主机，配置文件与凭据不互通。规格见仓库
`docs/design/2026-08-video-provider-interface/DESIGN.md` §8.0 / §8.2。

| 主机 | 放什么 | 单元 |
|---|---|---|
| GPU VM（Spot `g4-standard-48`，镜像 `wl-comfy-h3-g4-sg`，asia-southeast1，按批次启停） | ComfyUI；gateway 单进程（jobs / stages / ingests 三个内核）；registry 配置 `/etc/writing-loop/production-gateway.json`（0400/0600）与 bearer `/etc/writing-loop/production-gateway.env`（0600）；持久化启动盘上的 `objectsRoot` / `ingestRoot` / `jobStateRoot` | `comfyui.service`、`writing-loop-production-gateway.service`（**system 单元**，`/etc/systemd/system/`） |
| writing-loop-sg（常驻） | 账本 workspace、调度器、`production-worker` timer；worker runtime config `production-runtime.json`（0400/0600，三处 `transport: "insecure-private-http"` 指向 GPU VM 内网 IP）与 `production-worker.env`（0600）；gateway 导出的只读 profile 快照 | `writing-loop-production-worker.service` + `.timer`（**user 单元**，`~/.config/systemd/user/`） |
| 本机 | 只做 VCS 合成与 Blender 候选图；不直连 VPC 私网 gateway | 无 |

### 安装（每台各做一次）

```bash
# GPU VM：先核对镜像里 ComfyUI 的单元名与运行用户，再按实际值改 gateway unit 的
# User=/Group=/WorkingDirectory=/Requires= 四处
systemctl cat comfyui.service

# 需要出网装包/拉权重时临时挂外网 IP，装完立刻摘掉
bash scripts/gcp-h3-vm.sh egress on
sudo npm i -g @dyzsasd/writing-loop      # 提供 /usr/local/bin/writing-loop-production-gateway
bash scripts/gcp-h3-vm.sh egress off

sudo cp templates/systemd/writing-loop-production-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload

# writing-loop-sg：worker 是 user 单元
cp templates/systemd/writing-loop-production-worker.service \
   templates/systemd/writing-loop-production-worker.timer ~/.config/systemd/user/
systemctl --user daemon-reload && loginctl enable-linger "$USER"
```

`production-worker.env`（0600）至少三项，unit 里不硬编码任何路径：

```
WRITING_LOOP_WORKSPACE=/home/<user>/dramas
WRITING_LOOP_PRODUCTION_RUNTIME=/home/<user>/.config/writing-loop/production-runtime.json
WRITING_LOOP_GATEWAY_TOKEN=<与 GPU VM 的 bearer 相同>
```

### 每个批次的启动顺序

```bash
# ① 本机：开 GPU VM（Spot，抢占只停机不删盘；启动盘 no-auto-delete）
bash scripts/gcp-h3-vm.sh start && bash scripts/gcp-h3-vm.sh status   # 记下 INTERNAL_IP

# ② GPU VM：ComfyUI 先起，gateway 后起（unit 已声明 Requires/After）
sudo systemctl start comfyui writing-loop-production-gateway
sudo systemctl status writing-loop-production-gateway --no-pager

# ③ GPU VM：导出只读 execution profile 快照，rsync 给 writing-loop-sg
writing-loop-production-gateway --config /etc/writing-loop/production-gateway.json \
  --export-profile-snapshot ~/export/execution-profiles.json

# ④ writing-loop-sg：确认 runtime config 的三处 baseUrl 指向 ① 的 INTERNAL_IP，再放 worker
systemctl --user start writing-loop-production-worker.timer

# ⑤ 批次结束：先停 worker timer，再停 VM（job record 与 CAS 在启动盘上保留）
systemctl --user stop writing-loop-production-worker.timer
bash scripts/gcp-h3-vm.sh stop
```

### 探针命令

```bash
# GPU VM 本机：gateway 在监听且鉴权生效（401 = 活着且拒未授权，属于预期）
curl -s -o /dev/null -w '%{http_code}\n' \
  "http://<INTERNAL_IP>:8790/v1/scopes/<WS>/<PROJECT>/jobs/00000000-0000-4000-8000-000000000000"   # 期望 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $WRITING_LOOP_GATEWAY_BEARER" \
  "http://<INTERNAL_IP>:8790/v1/scopes/<WS>/<PROJECT>/jobs/00000000-0000-4000-8000-000000000000"   # 期望 404

# GPU VM 本机：ComfyUI loopback 可达
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8188/queue                               # 期望 200

# writing-loop-sg：从服务器侧确认私网可达（不要从本机或公网测）
ssh writing-loop-sg 'curl -s -o /dev/null -w "%{http_code}\n" \
  "http://<INTERNAL_IP>:8790/v1/scopes/<WS>/<PROJECT>/jobs/00000000-0000-4000-8000-000000000000"'  # 期望 401

# writing-loop-sg：worker 单轮（timer 之外的手动一轮）
writing-loop-production-worker --config "$WRITING_LOOP_PRODUCTION_RUNTIME" --once --json
```

### 网络与磁盘纪律

- 入站当前依赖 VPC 的 `default-allow-internal`（10.128.0.0/9）覆盖 writing-loop-sg（10.148.0.5）到
  GPU VM 的私网 HTTP，无需新增规则。要收紧到只放行 worker 与 gateway 端口：

  ```bash
  gcloud compute firewall-rules create wl-h3-gateway-in \
    --network default --direction INGRESS --action ALLOW --rules tcp:8790 \
    --source-ranges 10.148.0.5/32 --target-tags wl-h3-gateway
  gcloud compute instances add-tags wl-comfy-h3-g4 --zone asia-southeast1-b --tags wl-h3-gateway
  ```

- gateway 只绑 registry 配置里的字面私网 IP，进程拒绝 `0.0.0.0` 与公网地址；不给实例加
  `http-server` / `https-server` 标签，端口不对公网开放。
- 实例默认 `--no-address`，无 Cloud NAT 时不能出网；只在装包/拉权重时 `egress on`，完成后立刻
  `egress off`。
- 启动盘 `--no-boot-disk-auto-delete`，删除实例不会连带删盘。**删除实例前先做快照**：
  `gcloud compute disks snapshot <INSTANCE> --zone <ZONE>`；确认快照可用后再删盘。
- bearer 只经 `EnvironmentFile`（0600）注入，配置文件里只出现环境变量名。轮换 bearer =
  改两台主机的 env 文件 + 各自 restart（GPU VM `sudo systemctl restart`，服务器 `systemctl --user`）。
- 明文 HTTP 的适用条件（同 VPC、无第三方工作负载）见 `references/config-schema.md`；任一条
  不成立时把 worker 三处 `transport` 改回 `"tls"`。
- `handoff --export-dir` 要经 gateway 的 assets 路由取资产，**导出时 GPU VM 必须在运行**。

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
