#!/usr/bin/env bash
# writing-loop 环境自举（幂等，harness 中立）。
# 检查 node/claude CLI → 安装 writing-loop（npm → tarball → git 三级回退）→ doctor 收口。
# 环境变量：
#   WRITING_LOOP_PKG             npm 包名（默认 @dyzsasd/writing-loop）
#   WRITING_LOOP_INSTALL_SOURCE  本地 tarball 路径（npm 不可用时的一级回退）
#   WRITING_LOOP_GIT             git 仓库（二级回退，默认 https://github.com/dyzsasd/writing-loop.git）
set -euo pipefail

PKG="${WRITING_LOOP_PKG:-@dyzsasd/writing-loop}"
GIT_URL="${WRITING_LOOP_GIT:-https://github.com/dyzsasd/writing-loop.git}"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=11

say()  { printf '[ensure-install] %s\n' "$*"; }
fail() { printf '[ensure-install] FAIL: %s\n' "$*" >&2; exit 1; }

# ── ① node ───────────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || fail "缺 node（需 ≥${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}）。用系统包管理器或 https://nodejs.org 安装后重跑。"
NODE_V="$(node -v | sed 's/^v//')"
NODE_MAJ="${NODE_V%%.*}"; rest="${NODE_V#*.}"; NODE_MIN="${rest%%.*}"
if [ "$NODE_MAJ" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJ" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MIN" -lt "$MIN_NODE_MINOR" ]; }; then
  fail "node $NODE_V 过旧（需 ≥${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}）"
fi
say "node $NODE_V OK"

# ── ② claude CLI（写作车道的唯一 harness 依赖）───────────────────────────────
if command -v claude >/dev/null 2>&1; then
  say "claude CLI OK（$(claude --version 2>/dev/null | head -1 || echo 版本未知)）"
else
  say "claude CLI 缺失——尝试安装 @anthropic-ai/claude-code…"
  npm install -g @anthropic-ai/claude-code \
    || npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code \
    || fail "claude CLI 安装失败（若 npm 报 allow-scripts 告警：npm config set allow-scripts=@anthropic-ai/claude-code --location=user 后重跑）"
  command -v claude >/dev/null 2>&1 || fail "安装后 claude 仍不在 PATH（检查 npm 全局 bin 是否在 PATH）"
fi
say "提醒：claude 的账号登录是交互式的——若本机从未登录，请操作者跑一次 \`claude\` 完成 login。"

# ── ③ writing-loop 引擎 ──────────────────────────────────────────────────────
if command -v writing-loop >/dev/null 2>&1; then
  say "writing-loop 已安装（$(writing-loop --version 2>/dev/null | head -1 || true)）——跳过安装"
else
  installed=0
  say "尝试 npm 安装 $PKG …"
  if npm install -g "$PKG" >/dev/null 2>&1; then
    installed=1; say "npm 安装成功"
  elif [ -n "${WRITING_LOOP_INSTALL_SOURCE:-}" ] && [ -f "${WRITING_LOOP_INSTALL_SOURCE}" ]; then
    say "npm 源不可用，回退 tarball：$WRITING_LOOP_INSTALL_SOURCE"
    npm install -g "$WRITING_LOOP_INSTALL_SOURCE" && installed=1
  fi
  if [ "$installed" -eq 0 ]; then
    say "回退 git 源：${GIT_URL}（clone + build，约 8-10 分钟）"
    tmp="$(mktemp -d)"
    if git clone --depth 1 "$GIT_URL" "$tmp/writing-loop" >/dev/null 2>&1; then
      ( cd "$tmp/writing-loop/hub" && npm install >/dev/null 2>&1 && npm run build >/dev/null 2>&1 \
        && npm install -g . >/dev/null 2>&1 ) && installed=1 || true
    fi
    [ "$installed" -eq 1 ] || fail "三级安装源全部失败。手动路径：npm i -g ${PKG}；或设 WRITING_LOOP_INSTALL_SOURCE=<tarball>；或确认 $GIT_URL 可达。"
    say "git 源安装成功"
  fi
  if ! command -v writing-loop >/dev/null 2>&1; then
    NPMBIN="$(npm prefix -g 2>/dev/null)/bin"
    if [ -x "$NPMBIN/writing-loop" ]; then
      say "已装到 ${NPMBIN}，但该目录不在 PATH——请把下面这行加进 shell 配置后重开会话："
      say "  export PATH=\"$NPMBIN:\$PATH\""
      PATH="$NPMBIN:$PATH"; export PATH
    else
      fail "安装后 writing-loop 不在 PATH（npm 全局 bin=$NPMBIN 也未找到）"
    fi
  fi
fi
WL="$(command -v writing-loop)"
say "writing-loop = ${WL}（$(writing-loop --version 2>/dev/null | head -1 || true)）"

# ── ④ doctor 收口 ────────────────────────────────────────────────────────────
say "运行 writing-loop doctor …"
if out="$(writing-loop doctor 2>&1)"; then
  printf '%s\n' "$out" | tail -3
  printf '%s\n' "$out" | grep -q "WRITING_LOOP_DOCTOR_OK" \
    && say "环境就绪 ✔（下一步：按 SKILL.md §2 初始化 workspace）" \
    || say "doctor 通过但未见 OK 标记——人工过一眼上方输出"
else
  # workspace 尚未初始化时 doctor 可能报缺 workspace——这不算安装失败
  printf '%s\n' "$out" | tail -5
  say "doctor 未全绿（若是「找不到 workspace」属预期——先按 SKILL.md §2 init）。"
fi
