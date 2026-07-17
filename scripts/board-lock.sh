#!/usr/bin/env bash
# writing-loop 板/账本锁助手 —— conventions §7/§15.5/§18 锁法术的可调用实现。
#
# 双轨权威声明：conventions 的散文（§15.5 账本锁纪律、§15.6 repo 写锁、§18 票锁与
# 陈旧锁规则）仍是权威——无 shell 的运行环境按散文手工执行即可；本脚本只是同一语义的
# 可审计单一实现（O_EXCL 独占创建、mtime >60min 陈旧强清、固定多锁序 foreshadow →
# story-state → production → repo、拿不到下一把先释放已持有的全部锁）。repo 写锁
# （`<repoPath>/.git/repo.lock`，§15.6）走通用 acquire/release——固定序末位，最后拿、
# 最先放（秒级 stage+commit，持有最短）。两者语义一字不差；若有出入，
# 以散文为准并修本脚本。SKILL 只描述锁「什么」；「怎么锁」引 conventions §7 的指针。
#
# 用法：
#   board-lock.sh acquire <lock-path> [stale-min]   独占创建；陈旧锁先清（记一行日志）再试一次
#   board-lock.sh release <lock-path>               释放（幂等）
#   board-lock.sh acquire-ledgers <ledgers-dir> [stale-min]
#                                                   固定序拿三把账本锁；任一失败 ⇒ 反序全释放、退出非零
#   board-lock.sh release-ledgers <ledgers-dir>     反序全释放
#   board-lock.sh --self-test                       临时目录自证 acquire/contend/stale-reclaim/release/多锁序/两道防线
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
LEDGER_ORDER="foreshadow.md.lock story-state.md.lock production.md.lock"  # §15.5 固定序

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

acquire_ledgers() { # $1=ledgers-dir $2=stale-min
  local dir="$1" stale="${2:-$STALE_MIN_DEFAULT}" name held=""
  for name in $LEDGER_ORDER; do
    if acquire "$dir/$name" "$stale"; then
      held="$name $held"   # 前插 ⇒ held 即反序
    else
      log "拿不到 $dir/$name ⇒ 先释放已持有的全部锁再退出（§15.5 绝不持锁 bail）"
      local h; for h in $held; do release "$dir/$h"; done
      return 1
    fi
  done
  return 0
}

release_ledgers() { # 反序释放
  local dir="$1" name rev=""
  for name in $LEDGER_ORDER; do rev="$name $rev"; done
  for name in $rev; do release "$dir/$name"; done
}

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

  mkdir -p "$tmp/ledgers"
  acquire_ledgers "$tmp/ledgers"; check "acquire-ledgers：固定序三锁全获" 0 $?
  [ -e "$tmp/ledgers/foreshadow.md.lock" ] && [ -e "$tmp/ledgers/story-state.md.lock" ] \
    && [ -e "$tmp/ledgers/production.md.lock" ]; check "三把账本锁在盘" 0 $?
  release_ledgers "$tmp/ledgers"
  # 不用 ls 的退出码判「无匹配」——GNU ls 对无匹配 glob 退 2、BSD ls 退 1（平台耦合）。
  leftover=0; for f in "$tmp/ledgers"/*.lock; do [ -e "$f" ] && leftover=1; done
  check "release-ledgers：无残锁" 0 "$leftover"

  : > "$tmp/ledgers/story-state.md.lock"   # 竞争者预持中间那把
  acquire_ledgers "$tmp/ledgers"; check "多锁序：中间被占 ⇒ 整组失败" 1 $?
  [ -e "$tmp/ledgers/foreshadow.md.lock" ]; check "失败后已获的 foreshadow 锁被释放（绝不持锁 bail）" 1 $?
  rm -f "$tmp/ledgers/story-state.md.lock"

  echo "self-test: $pass pass, $fail fail"
  [ "$fail" = 0 ]
}

case "${1:-}" in
  acquire)          shift; [ $# -ge 1 ] || { log "用法：acquire <lock-path> [stale-min]"; exit 2; }; acquire "$@" ;;
  release)          shift; [ $# -ge 1 ] || { log "用法：release <lock-path>"; exit 2; }; release "$@" ;;
  acquire-ledgers)  shift; [ $# -ge 1 ] || { log "用法：acquire-ledgers <ledgers-dir> [stale-min]"; exit 2; }; acquire_ledgers "$@" ;;
  release-ledgers)  shift; [ $# -ge 1 ] || { log "用法：release-ledgers <ledgers-dir>"; exit 2; }; release_ledgers "$@" ;;
  --self-test)      self_test ;;
  *) log "用法：board-lock.sh {acquire|release|acquire-ledgers|release-ledgers|--self-test}"; exit 2 ;;
esac
