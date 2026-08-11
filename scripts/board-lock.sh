#!/usr/bin/env bash
# writing-loop 板/结构化剧情资产锁助手 —— conventions §7/§15.5/§18 锁法术的可调用实现。
#
# 双轨权威声明：conventions 的散文（§15.5 剧情资产锁纪律、§15.6 repo 写锁、§18 票锁与
# 陈旧锁规则）仍是权威——无 shell 的运行环境按散文手工执行即可；本脚本只是同一语义的
# 可审计单一实现（O_EXCL 独占创建、mtime >60min 陈旧强清）。结构化事实写入使用
# `<repoPath>/.git/story-assets.lock`，stage+commit 使用 `<repoPath>/.git/repo.lock`；二者都在
# `.git/` 内，永不污染创作目录。repo 写锁（§15.6）固定序末位，最后拿、
# 最先放（秒级 stage+commit，持有最短）。两者语义一字不差；若有出入，
# 以散文为准并修本脚本。SKILL 只描述锁「什么」；「怎么锁」引 conventions §7 的指针。
#
# 用法：
#   board-lock.sh acquire <lock-path> [stale-min]   独占创建；陈旧锁先清（记一行日志）再试一次
#   board-lock.sh release <lock-path>               释放（幂等）
#   board-lock.sh acquire-story <git-dir> [stale-min]
#                                                   获取单一结构化剧情资产锁
#   board-lock.sh release-story <git-dir>           释放结构化剧情资产锁
#   board-lock.sh --self-test                       临时目录自证 acquire/contend/stale-reclaim/release/资产锁/两道防线
#
# 防线（WL-53：acquire 传错参曾把 151 行 lessons.md 抹成一行 holder 文本）：
#   语法防线   acquire/release 拒绝一切不以 .lock 结尾的路径——传的必须是锁文件、不是被保护文件。
#   holder 防线 陈旧强清（及 release 的 rm）前先校验文件正文确是本工具写的单行
#              `holder pid=<pid> at <UTC>`；超龄但非 holder 格式 ⇒ 绝不 rm，硬错误退出请人工检查。
#
# 退出码：0 = 成功；1 = 拿不到锁（呼叫方按 §15.5：票留 In Progress、下 fire 续）；2 = 用法错误
# （含语法防线：lock-path 不以 .lock 结尾）；3 = 锁路径上躺着非 holder 格式的文件——疑似真实
# 文件被误当锁路径传入，绝不 rm，请操作者人工检查。
set -u

STALE_MIN_DEFAULT=60
STORY_LOCK="story-assets.lock"

log() { printf '%s\n' "board-lock: $*" >&2; }

is_stale() { # $1=lock $2=stale-min ；mtime 超龄 ⇒ 0
  [ -e "$1" ] && [ -n "$(find "$1" -mmin +"$2" 2>/dev/null)" ]
}

is_holder_shaped() { # $1=path ；正文恰为本工具写的单行 `holder pid=<pid> at <UTC>` ⇒ 0
  [ -f "$1" ] || return 1
  [ "$(wc -l < "$1" 2>/dev/null)" -eq 1 ] 2>/dev/null || return 1
  grep -q '^holder pid=[0-9][0-9]* at [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z$' "$1" 2>/dev/null
}

require_lock_suffix() { # $1=path ；语法防线（WL-53）：锁路径必须以 .lock 结尾
  case "$1" in
    *.lock) return 0 ;;
    *) log "拒绝：lock-path 必须以 .lock 结尾（收到 ${1}）——传的是锁文件、不是被保护文件（WL-53 语法防线）"; return 2 ;;
  esac
}

acquire() { # $1=lock-path $2=stale-min
  local lock="$1" stale="${2:-$STALE_MIN_DEFAULT}" attempt
  require_lock_suffix "$lock" || return 2
  for attempt in 1 2; do
    # noclobber 的 > 即 O_CREAT|O_EXCL：OS 保证唯一赢家（§18）；holder 行随创建同一重定向写入，
    # 崩溃残锁因此总是 holder 格式，不会撞 holder 防线。
    if ( set -C; printf 'holder pid=%s at %s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$lock" ) 2>/dev/null; then
      return 0
    fi
    if [ "$attempt" = 1 ] && is_stale "$lock" "$stale"; then
      if ! is_holder_shaped "$lock"; then
        log "拒绝强清：${lock} 超龄但正文不是本工具写的 holder 格式——锁路径上躺着一个真实文件，绝不 rm；请操作者人工检查（WL-53 holder 防线）"
        return 3
      fi
      log "stale lock >${stale}min，强清重试：${lock}（§18 陈旧锁规则）"
      rm -f "$lock"
      continue
    fi
    return 1
  done
  return 1
}

release() { # 幂等；同受两道防线（WL-53）
  require_lock_suffix "$1" || return 2
  if [ -e "$1" ] && ! is_holder_shaped "$1"; then
    log "拒绝释放：${1} 存在但正文不是本工具写的 holder 格式——疑似真实文件在锁路径上，绝不 rm（WL-53 holder 防线）"
    return 3
  fi
  rm -f "$1"
}

acquire_story() { acquire "$1/$STORY_LOCK" "${2:-$STALE_MIN_DEFAULT}"; }
release_story() { release "$1/$STORY_LOCK"; }

self_test() {
  local tmp pass=0 fail=0
  TMPD="$(mktemp -d "${TMPDIR:-/tmp}/board-lock-test.XXXXXX")" || exit 1
  tmp="$TMPD"
  trap 'rm -rf "$TMPD"' EXIT
  check() { # $1=描述 $2=期望退出码 已执行命令的实际码 $3
    if [ "$3" = "$2" ]; then pass=$((pass+1)); echo "PASS $1"
    else fail=$((fail+1)); echo "FAIL ${1}（期望退出 ${2}，实得 ${3}）"; fi
  }

  acquire "$tmp/t.lock"; check "acquire：空位独占创建成功" 0 $?
  acquire "$tmp/t.lock"; check "contend：已持有的锁第二次 acquire 失败" 1 $?
  release "$tmp/t.lock"
  acquire "$tmp/t.lock"; check "release 后可再 acquire" 0 $?
  release "$tmp/t.lock"

  printf 'holder pid=99999 at 2020-01-01T00:00:00Z\n' > "$tmp/t.lock"
  touch -t 202001010000 "$tmp/t.lock"   # 回拨 mtime 模拟崩溃残锁（holder 格式 = 本工具真锁）
  acquire "$tmp/t.lock"; check "stale-reclaim：>60min holder 格式残锁仍被强清并重获（WL-53 回归 c）" 0 $?
  release "$tmp/t.lock"

  # —— WL-53 回归：两道防线 ——
  printf 'CANON LEDGER CONTENT\nF-09: planted@ep2 -> refresh@ep6\n' > "$tmp/lessons.md"
  cp "$tmp/lessons.md" "$tmp/lessons.orig"
  acquire "$tmp/lessons.md"; check "语法防线：acquire 非 .lock 路径被拒（WL-53 回归 a）" 2 $?
  cmp -s "$tmp/lessons.md" "$tmp/lessons.orig"; check "语法防线：被误传文件逐字节未动（回归 a）" 0 $?
  release "$tmp/lessons.md"; check "语法防线：release 非 .lock 路径被拒（WL-53 回归 d）" 2 $?
  cmp -s "$tmp/lessons.md" "$tmp/lessons.orig"; check "语法防线：release 误传后文件逐字节未动（回归 d）" 0 $?

  cp "$tmp/lessons.orig" "$tmp/fake.lock"          # 真实内容却顶着 .lock 名
  touch -t 202001010000 "$tmp/fake.lock"           # 超龄 ⇒ 旧逻辑会 rm -f
  acquire "$tmp/fake.lock"; check "holder 防线：>60min 非 holder 格式文件拒绝强清、硬错误（WL-53 回归 b）" 3 $?
  cmp -s "$tmp/fake.lock" "$tmp/lessons.orig"; check "holder 防线：该文件逐字节未动（回归 b）" 0 $?
  release "$tmp/fake.lock"; check "holder 防线：release 对非 holder 格式文件同样拒绝" 3 $?
  cmp -s "$tmp/fake.lock" "$tmp/lessons.orig"; check "holder 防线：release 拒绝后文件逐字节未动" 0 $?
  rm -f "$tmp/fake.lock" "$tmp/lessons.md" "$tmp/lessons.orig"

  mkdir -p "$tmp/.git"
  acquire_story "$tmp/.git"; check "acquire-story：结构化剧情资产锁获取成功" 0 $?
  [ -e "$tmp/.git/story-assets.lock" ]; check "剧情资产锁只写在 .git 元数据目录" 0 $?
  acquire_story "$tmp/.git"; check "acquire-story：并发竞争者被拒" 1 $?
  release_story "$tmp/.git"
  [ ! -e "$tmp/.git/story-assets.lock" ]; check "release-story：无残锁" 0 $?

  echo "self-test: $pass pass, $fail fail"
  [ "$fail" = 0 ]
}

case "${1:-}" in
  acquire)          shift; [ $# -ge 1 ] || { log "用法：acquire <lock-path> [stale-min]"; exit 2; }; acquire "$@" ;;
  release)          shift; [ $# -ge 1 ] || { log "用法：release <lock-path>"; exit 2; }; release "$@" ;;
  acquire-story)    shift; [ $# -ge 1 ] || { log "用法：acquire-story <git-dir> [stale-min]"; exit 2; }; acquire_story "$@" ;;
  release-story)    shift; [ $# -ge 1 ] || { log "用法：release-story <git-dir>"; exit 2; }; release_story "$@" ;;
  --self-test)      self_test ;;
  *) log "用法：board-lock.sh {acquire|release|acquire-story|release-story|--self-test}"; exit 2 ;;
esac
