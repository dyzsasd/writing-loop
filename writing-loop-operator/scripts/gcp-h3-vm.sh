#!/usr/bin/env bash
# GPU VM（MiniMax H3 over ComfyUI）按批次启停。
#
# 机型与镜像由规格固定：Spot g4-standard-48、image-family wl-comfy-h3-g4-sg、asia-southeast1。
# 持久化启动盘 200 GB（hyperdisk-balanced，G4 不接受 pd-*）承载 job record、CAS objects 与 ingest 产物，且**不随实例删除**
# （--no-boot-disk-auto-delete）；`--instance-termination-action=STOP` 让 Spot 抢占只停机不删盘。
# 实例默认无外网 IP、不加 http-server / https-server 标签。当前拓扑（操作者 2026-09-02 裁定）：
# worker 与全部 writing-loop 控制面在操作者本机，经 IAP ssh 隧道访问 VM 上的 gateway，因此 gateway 与
# ComfyUI 都只绑 127.0.0.1，VM 上不存在任何对外监听面；安装包在本机 `npm pack` 后经隧道 scp 上机，
# VM 不需要出网。装包等确需出网时用 `egress on` 临时挂外网 IP，装完 off。
#
# 用法：
#   gcp-h3-vm.sh create            # 首次创建（已存在则报错退出，不覆盖）
#   gcp-h3-vm.sh start|stop        # 批次启停
#   gcp-h3-vm.sh status            # 状态、内网 IP、启动盘与 autoDelete
#   gcp-h3-vm.sh ssh [-- CMD...]   # 登录或远程执行
#   gcp-h3-vm.sh egress on|off     # 临时挂/摘外网 IP（只在装包、拉模型时 on）
#   gcp-h3-vm.sh tunnel [PORT...]  # 经 IAP 的 ssh -L 把 VM 回环端口转到本机（默认 gateway 8790 与 ComfyUI 8188）
#
# 删除实例前先对启动盘做快照：`gcloud compute disks snapshot <INSTANCE> --zone <ZONE>`。
#
# 环境变量（都有默认值）：
#   WL_GPU_PROJECT WL_GPU_ZONE WL_GPU_INSTANCE WL_GPU_IMAGE_FAMILY WL_GPU_IMAGE_PROJECT
#   WL_GPU_MACHINE WL_GPU_BOOT_GB WL_GPU_BOOT_DISK_TYPE WL_GPU_SUBNET WL_GATEWAY_PORT WL_COMFY_PORT
#   WL_GPU_MAX_UPTIME_MINUTES（开机自动关机硬上限，默认 300；0 关闭）
# 停机纪律：不需要 GPU 时必须 `stop`，该命令会轮询确认 TERMINATED；即使忘记，startup-script 也会到点自动关机。
set -euo pipefail

PROJECT="${WL_GPU_PROJECT:-jinko-vibe-coding}"
ZONE="${WL_GPU_ZONE:-asia-southeast1-b}"
INSTANCE="${WL_GPU_INSTANCE:-wl-comfy-h3-g4}"
IMAGE_FAMILY="${WL_GPU_IMAGE_FAMILY:-wl-comfy-h3-g4-sg}"
IMAGE_PROJECT="${WL_GPU_IMAGE_PROJECT:-$PROJECT}"
MACHINE="${WL_GPU_MACHINE:-g4-standard-48}"
BOOT_GB="${WL_GPU_BOOT_GB:-200}"
# G4 机型只接受 Hyperdisk（pd-* 会被 API 拒绝：pd-balanced disk type cannot be used by g4-standard-48）。
BOOT_DISK_TYPE="${WL_GPU_BOOT_DISK_TYPE:-hyperdisk-balanced}"
SUBNET="${WL_GPU_SUBNET:-default}"
GATEWAY_PORT="${WL_GATEWAY_PORT:-8790}"
COMFY_PORT="${WL_COMFY_PORT:-8188}"
# 开机自动关机硬上限（分钟）。每次 create/start 都会重新写入 startup-script，
# 到点由 VM 自己 shutdown，防止忘记停机（按时计费）。0 表示不设上限。
MAX_UPTIME_MINUTES="${WL_GPU_MAX_UPTIME_MINUTES:-300}"

say()  { printf '[gcp-h3-vm] %s\n' "$*"; }
fail() { printf '[gcp-h3-vm] FAIL: %s\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null 2>&1 || fail "缺 gcloud CLI。先装 Google Cloud SDK 并 gcloud auth login。"

gc() { gcloud --project "$PROJECT" "$@"; }

require_auth() {
  gcloud auth print-access-token >/dev/null 2>&1 \
    || fail "gcloud 未登录或凭据过期（gcloud auth print-access-token 失败）。先跑 gcloud auth login。"
}

# 只把「实例确实不存在」判为 false；权限/网络/配额等错误一律上抛，不冒充「不存在」。
exists() {
  local out status
  set +e
  out="$(gc compute instances describe "$INSTANCE" --zone "$ZONE" --format='value(name)' 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then return 0; fi
  case "$out" in
    *"was not found"*|*"notFound"*|*"HTTPError 404"*) return 1 ;;
    *) fail "describe $INSTANCE 失败（非 404）：$out" ;;
  esac
}

# 开机自动关机保险：startup-script 在每次开机时登记 `shutdown -h +N`。
auto_shutdown_script() {
  if [ "$MAX_UPTIME_MINUTES" -gt 0 ] 2>/dev/null; then
    printf '#!/bin/sh\n# writing-loop: 开机 %s 分钟后自动关机（防止忘记停机）\nshutdown -h +%s "writing-loop auto-shutdown after %s minutes"\n' "$MAX_UPTIME_MINUTES" "$MAX_UPTIME_MINUTES" "$MAX_UPTIME_MINUTES"
  else
    printf '#!/bin/sh\n# writing-loop: 未设置自动关机上限\n'
  fi
}
apply_auto_shutdown_metadata() {
  local tmp
  tmp="$(mktemp)"
  auto_shutdown_script > "$tmp"
  gc compute instances add-metadata "$INSTANCE" --zone "$ZONE" --metadata-from-file "startup-script=$tmp" >/dev/null
  rm -f "$tmp"
  if [ "$MAX_UPTIME_MINUTES" -gt 0 ] 2>/dev/null; then
    say "已登记开机自动关机：${MAX_UPTIME_MINUTES} 分钟（WL_GPU_MAX_UPTIME_MINUTES 可调，0 关闭）"
  fi
}

cmd_create() {
  require_auth
  if exists; then fail "实例 $INSTANCE 已存在（${ZONE}）。要重建先手动删除，本脚本不覆盖。"; fi
  say "创建 Spot ${MACHINE}（${IMAGE_FAMILY}，启动盘 ${BOOT_GB}GB 保留，抢占时只停机）"
  local startup
  startup="$(mktemp)"
  auto_shutdown_script > "$startup"
  gc compute instances create "$INSTANCE" \
    --zone "$ZONE" \
    --machine-type "$MACHINE" \
    --provisioning-model=SPOT \
    --instance-termination-action=STOP \
    --image-family "$IMAGE_FAMILY" \
    --image-project "$IMAGE_PROJECT" \
    --boot-disk-size "${BOOT_GB}GB" \
    --boot-disk-type "$BOOT_DISK_TYPE" \
    --no-boot-disk-auto-delete \
    --subnet "$SUBNET" \
    --no-address \
    --no-service-account \
    --no-scopes \
    --metadata=enable-oslogin=TRUE \
    --metadata-from-file "startup-script=$startup"
  rm -f "$startup"
  if [ "$MAX_UPTIME_MINUTES" -gt 0 ] 2>/dev/null; then
    say "已登记开机自动关机：${MAX_UPTIME_MINUTES} 分钟（WL_GPU_MAX_UPTIME_MINUTES 可调，0 关闭）"
  fi
  cmd_status
}

cmd_start() {
  require_auth
  exists || fail "实例 $INSTANCE 不存在，先跑 create。"
  apply_auto_shutdown_metadata
  gc compute instances start "$INSTANCE" --zone "$ZONE"
  cmd_status
}

cmd_stop() {
  require_auth
  exists || fail "实例 $INSTANCE 不存在。"
  gc compute instances stop "$INSTANCE" --zone "$ZONE"
  # 停机必须确认到位：轮询到 TERMINATED 为止（最多 3 分钟），否则报错，绝不静默返回。
  local i state
  for i in $(seq 1 36); do
    state="$(gc compute instances describe "$INSTANCE" --zone "$ZONE" --format='value(status)')"
    if [ "$state" = "TERMINATED" ]; then say "实例已停机（TERMINATED）。"; cmd_status; return 0; fi
    sleep 5
  done
  fail "停机后 3 分钟内状态仍为 ${state}，请手动检查（gcloud compute instances describe $INSTANCE --zone ${ZONE}）。"
}

cmd_status() {
  require_auth
  exists || fail "实例 $INSTANCE 不存在。"
  gc compute instances describe "$INSTANCE" --zone "$ZONE" \
    --format='table[box](name, status, machineType.basename(), scheduling.provisioningModel, scheduling.instanceTerminationAction, networkInterfaces[0].networkIP:label=INTERNAL_IP, networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP, disks[0].diskSizeGb:label=BOOT_GB, disks[0].autoDelete:label=BOOT_AUTODELETE, lastStartTimestamp:label=LAST_START, metadata.items.filter("key:startup-script").len():label=AUTO_SHUTDOWN_SCRIPT)'
}

cmd_ssh() {
  require_auth
  exists || fail "实例 $INSTANCE 不存在。"
  if [ "$#" -gt 0 ]; then
    gc compute ssh "$INSTANCE" --zone "$ZONE" --tunnel-through-iap --command "$*"
  else
    gc compute ssh "$INSTANCE" --zone "$ZONE" --tunnel-through-iap
  fi
}

# --no-address 的实例在没有 Cloud NAT 时不能出网：装包/拉模型前 on，装完立即 off。
cmd_egress() {
  require_auth
  exists || fail "实例 $INSTANCE 不存在。"
  case "${1:-}" in
    on)
      say "临时挂载外网 IP（装包完成后务必 egress off）"
      gc compute instances add-access-config "$INSTANCE" --zone "$ZONE" \
        --access-config-name="external-nat"
      ;;
    off)
      say "摘除外网 IP，恢复只走 VPC 私网"
      gc compute instances delete-access-config "$INSTANCE" --zone "$ZONE" \
        --access-config-name="external-nat"
      ;;
    *) fail "egress 需要 on 或 off" ;;
  esac
  cmd_status
}

# 本机 worker 经隧道访问 VM：默认同时转 gateway 与 ComfyUI 两个端口，各起一个 IAP 隧道子进程，
# 任一子进程退出后一并收敛，避免留下半条隧道。
cmd_tunnel() {
  require_auth
  exists || fail "实例 ${INSTANCE} 不存在。"
  local ports=()
  if [ "$#" -gt 0 ]; then
    ports=("$@")
  else
    ports=("$GATEWAY_PORT" "$COMFY_PORT")
  fi
  # IAP 的 TCP 转发（start-iap-tunnel）只能连到 VM 网卡内网地址上的监听端口；gateway 与 ComfyUI 只绑
  # 127.0.0.1，直接转发会报 4003 failed to connect to backend。因此走经 IAP 的 ssh 连接做 -L 端口转发：
  # 由 VM 上的 sshd 连到回环地址，VM 网卡上仍然没有任何对外监听面，也不需要为这些端口开防火墙。
  local forwards=()
  local port
  for port in "${ports[@]}"; do
    case "$port" in
      ''|*[!0-9]*) fail "端口必须是十进制数字：${port}" ;;
    esac
    say "ssh 端口转发（经 IAP）127.0.0.1:${port} → ${INSTANCE} 回环 ${port}"
    forwards+=(-L "127.0.0.1:${port}:127.0.0.1:${port}")
  done
  say "隧道建立中（Ctrl-C 结束）。worker 的 baseUrl 用 http://127.0.0.1:${GATEWAY_PORT}。"
  # 单个 ssh 进程承载全部端口：-o ExitOnForwardFailure=yes 让任一端口转发失败时整体退出，不留半条隧道。
  gc compute ssh "$INSTANCE" --zone "$ZONE" --tunnel-through-iap -- \
    -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 "${forwards[@]}"
}

action="${1:-}"
shift || true
case "$action" in
  create) cmd_create ;;
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  ssh)    if [ "${1:-}" = "--" ]; then shift; fi; cmd_ssh "$@" ;;
  egress) cmd_egress "${1:-}" ;;
  tunnel) cmd_tunnel "$@" ;;
  *) sed -n '2,24p' "$0" >&2; exit 2 ;;
esac
