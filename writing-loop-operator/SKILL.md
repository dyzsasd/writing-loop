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

## §3a 视频生产 gateway 部署（本机 + GPU VM，经 ssh 隧道）

远端制片分本机与 GPU VM 两台主机（writing-loop-sg 只是备选形态），配置文件与凭据不互通。规格见仓库
`docs/design/2026-08-video-provider-interface/DESIGN.md` §8.0（拓扑与威胁模型）/ §8.2。

| 主机 | 放什么 | 单元 |
|---|---|---|
| GPU VM（Spot `g4-standard-48`，镜像 `wl-comfy-h3-g4-sg`，asia-southeast1，按批次启停） | ComfyUI；gateway 单进程（jobs / stages / ingests 三个内核）；registry 配置 `/etc/writing-loop/production-gateway.json`（0400/0600）与 bearer `/etc/writing-loop/production-gateway.env`（0600）；持久化启动盘上的 `objectsRoot` / `ingestRoot` / `jobStateRoot` | `comfyui.service`、`writing-loop-production-gateway.service`（**system 单元**，`/etc/systemd/system/`） |
| 本机（macOS） | 全部控制面：workspace 与账本、`plan-shots` / `qc` / `handoff`、`production-worker`、VCS 合成与 Blender 候选图；worker runtime config `production-runtime.json`（0400/0600）与凭据环境变量 | 无常驻单元；worker 按批次手动跑 `--once` |
| writing-loop-sg（可选） | 备选方案：worker 作为常驻 systemd user 单元跑在服务器上，此时三处 `baseUrl` 改指 GPU VM 内网 IP，并按下文「网络与磁盘纪律」补 VPC 入站规则 | `writing-loop-production-worker.service` + `.timer`（**user 单元**，`~/.config/systemd/user/`） |

本机不在 GPU VM 的 VPC 里，gateway 只绑 VM 上的 `127.0.0.1`，经 IAP 的 ssh 连接做 `-L` 端口转发映射到本机同端口
（IAP 的 TCP 转发只能连到 VM 网卡上的监听端口，连不到回环地址，所以不用 `start-iap-tunnel`）。
一条命令、一个 ssh 进程承载两个端口，占一个前台窗口；任一端口转发失败整体退出，不留半条：

```bash
bash scripts/gcp-h3-vm.sh tunnel        # 默认同时转 gateway 8790 与 ComfyUI 8188（ssh -L，经 IAP）
bash scripts/gcp-h3-vm.sh tunnel 8790   # 只要 gateway 时给端口
```

隧道开着时 worker 的 `baseUrl` 就是 `http://127.0.0.1:8790`，配 `transport: "insecure-private-http"`
与非空 `credentialEnv`（现有解析规则已接受 `127.0.0.1` 字面地址，不需改配置以外的东西）。
明文只存在于两端的 loopback 与 IAP 加密隧道内，不经公网。

### 安装

```bash
# 本机：worker 与 CLI 同一个包，不装 systemd 单元
npm i -g @dyzsasd/writing-loop

# GPU VM 不出网：安装包由本机打好经隧道 scp 过去（不建 NAT、不挂外网 IP）
npm pack @dyzsasd/writing-loop
gcloud compute scp --tunnel-through-iap --zone asia-southeast1-b \
  dyzsasd-writing-loop-*.tgz wl-comfy-h3-g4:~/

# GPU VM：先核对镜像里 ComfyUI 的单元名与运行用户，再按实际值改 gateway unit 的
# User=/Group=/WorkingDirectory=/Requires= 四处
systemctl cat comfyui.service
sudo npm i -g ~/dyzsasd-writing-loop-*.tgz   # 提供 /usr/local/bin/writing-loop-production-gateway
sudo cp templates/systemd/writing-loop-production-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
# writing-loop-sg（可选备选方案）：worker 作为 user 单元跑在服务器上时才需要这三行
#   cp templates/systemd/writing-loop-production-worker.service \
#      templates/systemd/writing-loop-production-worker.timer ~/.config/systemd/user/
#   systemctl --user daemon-reload && loginctl enable-linger "$USER"
```

本机的 worker 环境变量（写进 shell profile 或每次 export，**不要写进 runtime config**）：

```
WRITING_LOOP_WORKSPACE=$HOME/dramas
WRITING_LOOP_PRODUCTION_RUNTIME=$HOME/.config/writing-loop/production-runtime.json
WRITING_LOOP_GATEWAY_TOKEN=<与 GPU VM 的 bearer 相同>
```

### 每个批次的启动顺序

```bash
# ① 本机：开 GPU VM（Spot，抢占只停机不删盘；启动盘 no-auto-delete）
bash scripts/gcp-h3-vm.sh start && bash scripts/gcp-h3-vm.sh status

# ② GPU VM：ComfyUI 先起，gateway 后起（unit 已声明 Requires/After）
sudo systemctl start comfyui writing-loop-production-gateway
sudo systemctl status writing-loop-production-gateway --no-pager
# 启动日志末尾会报告抢占扫描结果（rewritten/scanned、unresolved），重启后的 pending/running 任务
# 在此被改写为 provider_failed:preempted。

# ③ GPU VM：导出只读 execution profile 快照
writing-loop-production-gateway --config /etc/writing-loop/production-gateway.json \
  --export-profile-snapshot ~/export/execution-profiles.json

# ④ 本机：把快照取回 runtime config 声明的路径，再开隧道（前台窗口保持整个批次）
gcloud compute scp --tunnel-through-iap --zone asia-southeast1-b \
  wl-comfy-h3-g4:~/export/execution-profiles.json \
  "$HOME/.config/writing-loop/profiles/execution-profiles.json"
chmod 600 "$HOME/.config/writing-loop/profiles/execution-profiles.json"
bash scripts/gcp-h3-vm.sh tunnel        # 默认同时转 8790 与 8188

# ⑤ 批次结束：先关隧道窗口（Ctrl-C），再停 VM（job record 与 CAS 在启动盘上保留）
bash scripts/gcp-h3-vm.sh stop
```

### 探针命令

```bash
# GPU VM 本机：gateway 在监听且鉴权生效（401 = 活着且拒未授权，属于预期）
curl -s -o /dev/null -w '%{http_code}\n' \
  "http://127.0.0.1:8790/v1/scopes/<WS>/<PROJECT>/jobs/00000000-0000-4000-8000-000000000000"       # 期望 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $WRITING_LOOP_GATEWAY_BEARER" \
  "http://127.0.0.1:8790/v1/scopes/<WS>/<PROJECT>/jobs/00000000-0000-4000-8000-000000000000"       # 期望 404

# GPU VM 本机：ComfyUI loopback 可达
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8188/queue                               # 期望 200

# 本机：隧道通了（同样打 127.0.0.1:8790，走的是经 IAP 的 ssh -L 转发）
curl -s -o /dev/null -w '%{http_code}\n' \
  "http://127.0.0.1:8790/v1/scopes/<WS>/<PROJECT>/jobs/00000000-0000-4000-8000-000000000000"       # 期望 401
curl -s -H "Authorization: Bearer $WRITING_LOOP_GATEWAY_TOKEN" \
  "http://127.0.0.1:8790/v1/scopes/<WS>/<PROJECT>/capabilities"                                    # 期望 200 + 能力 JSON

# 本机：worker 单轮
writing-loop-production-worker --config "$WRITING_LOOP_PRODUCTION_RUNTIME" --once --json
```

### 网络与磁盘纪律

- 本机经 IAP 的 ssh `-L` 转发访问，gateway 端口不需要任何 VPC 入站规则：registry 的 `listen.host` 绑
  `127.0.0.1`，VM 上的 sshd 把转发连到回环地址。不要为它开防火墙，也不要改成绑内网 IP。
- gateway 只绑 registry 配置里的字面地址，进程拒绝 `0.0.0.0` 与公网地址；不给实例加
  `http-server` / `https-server` 标签，端口不对公网开放。
- 只有改用「worker 在 writing-loop-sg」的备选方案时才涉及 VPC 入站：依赖 `default-allow-internal`
  （10.128.0.0/9），或按下面这条收紧到只放行 worker 到 gateway 端口：

  ```bash
  gcloud compute firewall-rules create wl-h3-gateway-in \
    --network default --direction INGRESS --action ALLOW --rules tcp:8790 \
    --source-ranges 10.148.0.5/32 --target-tags wl-h3-gateway
  gcloud compute instances add-tags wl-comfy-h3-g4 --zone asia-southeast1-b --tags wl-h3-gateway
  ```

- 实例默认 `--no-address`，无 Cloud NAT 时不能出网；只在装包/拉权重时 `egress on`，完成后立刻
  `egress off`。
- 启动盘 `--no-boot-disk-auto-delete`，删除实例不会连带删盘。**删除实例前先做快照**：
  `gcloud compute disks snapshot <INSTANCE> --zone <ZONE>`；确认快照可用后再删盘。
- bearer 只经环境变量注入，配置文件里只出现环境变量名。轮换 bearer = 改 GPU VM 的 env 文件并
  `sudo systemctl restart`，同步改本机的 `WRITING_LOOP_GATEWAY_TOKEN`。
- 明文 HTTP 的适用条件见 `references/config-schema.md`；本机形态下明文只存在于 loopback 与 IAP
  加密隧道内，隧道不在时 worker 直接连不上，不会退化成公网明文。
- GPU VM 上必须有可用的 `ffmpeg`：ingest 内核入库主视频后由它派生尾帧并登记为第二个 AssetRef。
  gateway 在装配期跑一次 `ffmpeg -version` 探针，缺失即拒绝启动并写明原因；入库后没有唯一主视频，
  或提取失败，该次 ingest 以 `derivation-failed` 失败，不会登记缺尾帧的 take。
- `handoff --export-dir` 要经 gateway 的 assets 路由取资产，**导出时 GPU VM 与隧道都必须在**。

## §3b 出片流程（本机执行：plan → confirm → worker → qc → handoff）

前置：§3a 的 ①–④ 已完成（VM 起、gateway 起、隧道开、快照已取回并被 runtime config 的
`executionProfileSnapshotFile` 指到）。全部命令在本机 workspace 内跑，不 ssh 到任何服务器。

输入素材不需要手工送到 VM：runtime config 声明 `localAssetSource`（`kind: "workspace-cas"` +
与 gateway 相同的 `casAuthority`）之后，worker 在每次 stage 之前会对本批次每个 `cas://` 输入向
gateway 探一次 `HEAD .../assets/sha256/<digest>`，缺失的自动 `PUT` 上传（内容寻址，重放幂等）。
操作者要做的只是把首帧 / 候选图与 ShotRequest 一样放进本机 workspace CAS
（`.writing-loop/<project>/production-cas.v1/sha256/<digest>`）；上传失败时该镜头的 stage 直接失败，
不会带着缺失输入继续提交。

```bash
cd "$WRITING_LOOP_WORKSPACE"

# ① 候选图批准（并行轨道，不阻塞出片；首帧也可先用 operator-upload 绕过）
writing-loop visual approve-candidate --project yujing-jiushi --candidate K_S08_EST --by art:lead

# ①b 证据登记（一次性，之后批次文档直接引用）：把权利/审核/许可三份文件写进 workspace CAS，
#     命令按内容嗅探 mediaType 并打印可直接粘进批次文档的片段；重复登记幂等
writing-loop production evidence register --project yujing-jiushi --kind license \
  --file evidence/minimax-h3-LICENSE.txt --config "$WRITING_LOOP_PRODUCTION_RUNTIME"
#     moderation 另需 --status 与 --reviewed-at：审核结论与时刻是文件之外的人工事实，命令不代填
writing-loop production evidence register --project yujing-jiushi --kind moderation \
  --file evidence/moderation-record.json --config "$WRITING_LOOP_PRODUCTION_RUNTIME" \
  --status passed --reviewed-at 2026-09-02T16:54:00.310Z

# ② 出批次计划（严格零写入）。读 runtime config 声明的只读 profile 快照做估算；
#    --from-script 取集号，走剧本预填 + 镜头合并，镜头补齐由 --input 的 script.patches / mergedPatches 提供；
#    --shot 按镜头筛选（可重复，与批次文档的 shotIds 等价，两者都给出时取交集）
writing-loop production plan-shots --plan --project yujing-jiushi \
  --input batches/ep001-s1-sample.json --config "$WRITING_LOOP_PRODUCTION_RUNTIME" \
  --from-script 1 --scene 1 --shot EP001-S1-1
```

计划文档要人工看四项再决定是否批准：每镜估算与总估算、`decisions[]` 的后端与时长档理由、
`degradations`（带「需重新批准」的必须逐条确认）、`validation` 的 error/warning。GPU 小时是附注，
不构成阻断条件。有 error 的批次不会给出可提交的计划。

```bash
# ③ 批准即提交：逐镜把 ShotRequest 写进 workspace CAS、写批次审批记录并 enqueue（仍然零远端网络）
#    --shot 要与 ② 完全一致：选中集合计入 batchPlanId，少写一个 --shot 就不是那份被批准的计划
writing-loop production plan-shots --confirm <批准的 batchPlanId> --project yujing-jiushi \
  --input batches/ep001-s1-sample.json --config "$WRITING_LOOP_PRODUCTION_RUNTIME" \
  --from-script 1 --scene 1 --shot EP001-S1-1

# ④ 跑任务：每轮先自动上传本机 CAS 里 gateway 还没有的输入对象，再提交/轮询/入库一批，
#    跑到 status 里没有活跃 task 为止
writing-loop-production-worker --config "$WRITING_LOOP_PRODUCTION_RUNTIME" --once --json
writing-loop production status --project yujing-jiushi

# ⑤ QC 裁决：只有 qc-pending 的 take 可裁；拒绝必须给原因
writing-loop production qc --approve --project yujing-jiushi --task take-EP001-S1-1 --by qc:lead
writing-loop production qc --reject  --project yujing-jiushi --task take-EP001-S1-2 --by qc:lead \
  --note "尾帧穿帮，重出"

# ⑥ 样片过了再放大批：phase: bulk 的 --input 必须显式写 samplePolicy.sampleShotIds，
#    提交前会检查这些 task 全部 approved
writing-loop production plan-shots --plan --project yujing-jiushi \
  --input batches/ep001-bulk.json --config "$WRITING_LOOP_PRODUCTION_RUNTIME"

# ⑦ 交接：只输出人工 approved 的 take；导出目录是本机路径
#    handoff-input.json 是交接输入（version 2 / pipeline scripted-drama / taskIds 列已 approved 的
#    take）；其中 studioProjectId 必须与 ⑧ 里 import-handoff 的项目 id 逐字相同
writing-loop production handoff --project yujing-jiushi --input handoff-input.json \
  --export-dir "$HOME/workspace/citronetic/video-creation-studio/inbox/yujing-ep001-s1" \
  --config "$WRITING_LOOP_PRODUCTION_RUNTIME"

# ⑧ VCS 侧导入：摘要由上一步的 handoff.digest 提供，导入器逐 take 校验后才落盘
cd ~/workspace/citronetic/video-creation-studio
OUT="$HOME/workspace/citronetic/video-creation-studio/inbox/yujing-ep001-s1"
python skills/video-creation-studio/scripts/studio.py import-handoff yujing-jiushi-ep001 \
  --handoff "$OUT/handoff.json" --assets-dir "$OUT" --expect-digest "$(cat "$OUT/handoff.digest")"
```

纪律：

- `--plan` 与 `--confirm` 之间不要改 runtime config、快照、`--input` 或视觉侧三份文件——任一项变化
  都会让 `batchPlanId` 失效，`--confirm` 会拒绝。这是设计如此：批准的是那一份计划，不是命令本身。
- `--confirm` 精确重放是幂等的（CAS 对象、intent、task 都不重复写），中途失败重跑同一条命令即可。
- 样片门只认 task 状态：样片没跑过、或还不是 approved，`phase: bulk` 一律拒绝提交。
- 输入对象的上传由 worker 负责，不要用 scp 往 VM 的 CAS 目录里放对象：worker 提交前还会按同一份
  本机正本复核 gateway 回执里的逐镜 prompt / seed，手工放进去的对象绕不过这道复核，只会让该镜头
  以 `workflow-invalid` 失败。
- QC 裁决写的是终态事件，不能改判。改判要重新出镜头、重新走批次。
- `--export-dir` 缺省走 scripted-drama 契约 v2，逐 take 带 ShotRequest、execution 摘要、成本、
  资产角色表、`gates[]` 与许可摘要；导出目录同时含 `handoff.json`（规范 JSON 字节）、
  `handoff.digest` 与全部资产（`<sha256>.<ext>`）。旧四条流水线用 `--contract v1`，它不产资产目录。
- `gates[]` 逐条都要有取证来源：`qc-approved` 取 QC 裁决，`batch-approved` 取 ③ 写下的批次审批记录
  （`bindsTo.planSha256` 就是被批准的 `batchPlanId`），`sample-approved` 只对 samplePolicy 指名的样片
  出。2b 之前提交的 task 没有那份记录，只出 `qc-approved` 一条。
- 逐镜推进：**同一批次内不能接力**——ShotRequest 不可变且写死了尾帧 digest，上游还没出片时那个
  digest 只能是猜的，因此 `waves[]` 恒为一波。走法是：镜头 N 出片并 QC 之后，下一个批次用
  `--shot` 选镜头 N+1，它的 `continuity.firstFrame` 写 `previous-shot-last-frame`，`asset` 填镜头 N
  的**实际**尾帧 AssetRef（`production status --json` 里那一份），`origin.taskId` 填镜头 N 的 task id。
  `plan-shots` 在出计划时就核对上游 take 存在、状态 ∈ {qc-pending, approved}、subject 就是那一镜、
  尾帧的 sha256 / byteLength / mediaType 逐项一致（uri 形态差异不算不一致）。
- 批次审批记录只在 `--confirm` 确实创建了 task 的那一镜上写。已经入库的 take 再出现在别的批次里时
  不写也不改，因此它的 `batch-approved` 门永远指向真正发布它的那一份批次。
- 导出经 gateway 的 assets 路由（GET 方法）取回资产，因此**导出时 GPU VM 与隧道必须在**（§3a 的前提）。
  逐文件校验 sha256 与字节长度，任一不符整次失败并清理，目标目录不会留半份导出；重复导出幂等。
- 导入前不要手改导出目录里的任何文件：`--expect-digest` 比对的是 `handoff.json` 的规范字节摘要，
  改一个字节导入就会被拒；导出命令也会因为「目录已有内容且不一致」而拒绝重跑。
- `--export-dir` 指向的目录要么不存在、要么是空目录，要么就是上一次同一份导出的结果（此时重跑
  是零写入的幂等重放）。目录里有别的东西时命令直接拒绝，不会覆盖——换一个新目录即可。
- 交接输入里的 `studioProjectId` 就是 VCS 侧的项目 id：两边不一致会把镜头导进另一个项目。

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
