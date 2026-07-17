#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""scripts/wl-run.py 的端到端自测（stdlib-only；CI 与 wl-run.py --self-test 都跑它）。

每个用例起一个独立临时 workspace + 假 agent 命令（scheduler.agents.<a>.command 测试
接缝，真 subprocess 全链路），覆盖：
  1. 间隔触发 + fires.jsonl 行 + no-op 尾行检测（§0 的一行 no-op 收尾）
  2. 写者全局单飞（时间戳 marker 文件证明两写者从不重叠）+ 板上 ≤2 并发
     + 写者×板上确有并发（WL-55 的结构性解）
  3. capSeconds 超时 TERM→KILL（进程组真被杀，无游魂）
  4. keystone 升档（播种 In Review+keystone 假板 ⇒ reviewer fire 换 keystoneReviewer 档）
  5. --dry-run 零 spawn 零写（且 claude 默认命令形完整解析）
  6. --plan 只模拟不 spawn
  7. wl-run.lock 防重跑（board-lock choreography：在位即拒起；跑完释放）
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
WL_RUN = os.path.join(HERE, "wl-run.py")
AGENTS = ["showrunner", "story-designer", "episode-writer", "reviewer", "evaluator",
          "sweep", "script-doctor", "market-watch", "reflect"]
WRITERS = {"showrunner", "story-designer", "episode-writer", "evaluator"}

FAKE_AGENT = """\
import sys, time
markers, agent, sleep_s = sys.argv[1], sys.argv[2], float(sys.argv[3])
msg = " ".join(sys.argv[4:])
def w(line):
    with open(markers, "a") as f:
        f.write(line + "\\n")
w("start %s %.3f" % (agent, time.time()))
time.sleep(sleep_s)
w("end %s %.3f" % (agent, time.time()))
if msg:
    w("msg %s %s" % (agent, msg))
print(msg or "done")
"""

npass, nfail = 0, 0


def check(desc, cond, extra=""):
    global npass, nfail
    if cond:
        npass += 1
        print("PASS %s" % desc)
    else:
        nfail += 1
        print("FAIL %s%s" % (desc, "（%s）" % extra if extra else ""))


def make_ws(agent_overrides, sched_extra=None):
    """临时 workspace：.writing-loop/config.json + 项目 repo 目录 t1/ + 假 agent 脚本。

    agent_overrides: {agent: 覆盖块}；未提及的 agent 一律 enabled:false。
    """
    ws = tempfile.mkdtemp(prefix="wl-run-test.")
    os.makedirs(os.path.join(ws, ".writing-loop"))
    os.makedirs(os.path.join(ws, "t1"))
    with open(os.path.join(ws, "fake_agent.py"), "w", encoding="utf-8") as f:
        f.write(FAKE_AGENT)
    agents = {a: {"enabled": False} for a in AGENTS}
    for name, blk in agent_overrides.items():
        agents[name] = blk
    sched = {"agents": agents}
    sched.update(sched_extra or {})
    cfg = {"version": 1, "scheduler": sched,
           "projects": {"t1": {"title": "t", "repoPath": "t1", "backend": "local",
                               "ticketPrefix": "WL", "mode": "live", "enabled": True}}}
    with open(os.path.join(ws, ".writing-loop", "config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    return ws


def fake_cmd(ws, sleep_s, *extra):
    return [sys.executable, os.path.join(ws, "fake_agent.py"),
            os.path.join(ws, "markers.txt"), "{agent}", str(sleep_s)] + list(extra)


def run_wl(ws, *args, timeout=60):
    return subprocess.run([sys.executable, WL_RUN] + list(args), cwd=ws,
                          capture_output=True, text=True, timeout=timeout)


def ledger(ws):
    path = os.path.join(ws, ".writing-loop", "t1", "fires.jsonl")
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(ln) for ln in f if ln.strip()]


def markers(ws):
    """[(kind, agent, t)]；msg 行为 (\"msg\", agent, text)。"""
    path = os.path.join(ws, "markers.txt")
    if not os.path.isfile(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for ln in f:
            parts = ln.rstrip("\n").split(" ", 2)
            if len(parts) == 3:
                kind, agent, rest = parts
                out.append((kind, agent, rest if kind == "msg" else float(rest)))
    return out


def spans(marks):
    """按 agent 配对 start/end ⇒ [(agent, s, e)]（时间序配对）。"""
    starts, out = {}, []
    for kind, agent, t in marks:
        if kind == "start":
            starts.setdefault(agent, []).append(t)
        elif kind == "end":
            out.append((agent, starts[agent].pop(0), t))
    return out


def overlaps(a, b, eps=0.05):
    return a[1] < b[2] - eps and b[1] < a[2] - eps


def parse_ts(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ")


def seed_keystone_ticket(ws, state="In Review"):
    tdir = os.path.join(ws, ".writing-loop", "t1", "board", "tickets")
    os.makedirs(tdir, exist_ok=True)
    with open(os.path.join(tdir, "WL-1.md"), "w", encoding="utf-8") as f:
        f.write("---\nid: WL-1\ntitle: ep-003 keystone\ntype: Feature\n"
                "state: %s\nowner: reviewer\n"
                "labels: [writing-loop, Feature, episode, keystone, reviewer, episode-writer]\n"
                "---\n\nbody\n" % state)


# ---------------------------------------------------------------------------

def test_interval_noop_ledger():
    ws = make_ws({})  # command 需要 ws 路径 ⇒ 先建 ws 再回写 agents 块
    overrides = {
        "showrunner": {"enabled": True, "intervalSeconds": 1, "capSeconds": 30,
                       "staggerSeconds": 0, "command": fake_cmd(ws, 0.2, "working")},
        "sweep": {"enabled": True, "intervalSeconds": 1, "capSeconds": 30,
                  "staggerSeconds": 0, "command": fake_cmd(ws, 0, "本 lane 无活 —— no-op")},
    }
    _rewrite_agents(ws, overrides)
    r = run_wl(ws, "--project", "t1", "--for", "4")
    rows = ledger(ws)
    sr = [x for x in rows if x["agent"] == "showrunner"]
    sw = [x for x in rows if x["agent"] == "sweep"]
    check("间隔触发：4s 窗内 showrunner ≥2 次 fire", len(sr) >= 2, "得 %d；rc=%d stderr=%s"
          % (len(sr), r.returncode, r.stderr[-300:]))
    check("间隔触发：sweep ≥2 次 fire", len(sw) >= 2, "得 %d" % len(sw))
    check("wl-run 优雅退出 rc=0", r.returncode == 0, "rc=%d" % r.returncode)
    check("ledger：sweep 尾行 no-op 被检出", sw and all(x["noop"] for x in sw))
    check("ledger：showrunner 非 no-op", sr and not any(x["noop"] for x in sr))
    check("ledger：exitCode 0 / timedOut false",
          all(x["exitCode"] == 0 and not x["timedOut"] for x in rows))
    ok_ts = True
    for x in rows:
        try:
            ok_ts = ok_ts and parse_ts(x["startedAt"]) <= parse_ts(x["endedAt"])
        except ValueError:
            ok_ts = False
    check("ledger：launcher 时钟时间戳可解析且 startedAt≤endedAt", ok_ts)
    shutil.rmtree(ws, ignore_errors=True)


def _rewrite_agents(ws, overrides):
    path = os.path.join(ws, ".writing-loop", "config.json")
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    agents = {a: {"enabled": False} for a in AGENTS}
    agents.update(overrides)
    cfg["scheduler"]["agents"] = agents
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def test_single_flight():
    ws = make_ws({})
    overrides = {}
    for a in ["showrunner", "story-designer", "episode-writer",   # 写者 3 名
              "reviewer", "sweep", "market-watch"]:               # 板上 3 名（争 2 槽）
        overrides[a] = {"enabled": True, "intervalSeconds": 1, "capSeconds": 30,
                        "staggerSeconds": 0, "command": fake_cmd(ws, 0.7)}
    _rewrite_agents(ws, overrides)
    r = run_wl(ws, "--project", "t1", "--for", "6")
    sp = spans(markers(ws))
    w_sp = [x for x in sp if x[0] in WRITERS]
    b_sp = [x for x in sp if x[0] not in WRITERS]
    no_writer_overlap = all(not overlaps(w_sp[i], w_sp[j])
                            for i in range(len(w_sp)) for j in range(i + 1, len(w_sp)))
    check("单飞：任意两个写者 fire 从不重叠（%d 个写者 span，≥2 名写者）" % len(w_sp),
          len(w_sp) >= 3 and len({x[0] for x in w_sp}) >= 2 and no_writer_overlap,
          "rc=%d 写者=%r" % (r.returncode, sorted({x[0] for x in w_sp})))
    board_max = 0
    for x in b_sp:
        board_max = max(board_max, sum(1 for y in b_sp if overlaps(x, y) or y is x))
    check("板上并发 ≤2（实测最大 %d）" % board_max, 0 < board_max <= 2)
    cross = any(overlaps(w, b) for w in w_sp for b in b_sp)
    check("写者×板上确有并发（板上不被写者单飞饿死）", cross and len(b_sp) >= 3,
          "板上 span=%d" % len(b_sp))
    shutil.rmtree(ws, ignore_errors=True)


def test_cap_timeout_kill():
    ws = make_ws({})
    canary = "wlrun-canary-%d" % os.getpid()
    _rewrite_agents(ws, {"showrunner": {
        "enabled": True, "intervalSeconds": 1, "capSeconds": 1,
        "command": fake_cmd(ws, 30, canary)}})
    t0 = time.time()
    r = run_wl(ws, "--project", "t1", "--once", "--agents", "showrunner")
    dur = time.time() - t0
    rows = ledger(ws)
    check("cap 超时：fire 被杀且 wl-run 正常收尾", r.returncode == 0 and len(rows) == 1,
          "rc=%d rows=%d" % (r.returncode, len(rows)))
    if rows:
        check("cap 超时：timedOut=true 且 exitCode<0",
              rows[0]["timedOut"] and isinstance(rows[0]["exitCode"], int)
              and rows[0]["exitCode"] < 0, "row=%r" % rows[0])
    check("cap 超时：远早于 30s 假 agent 睡眠（实际 %.1fs）" % dur, dur < 15)
    time.sleep(0.5)
    left = subprocess.run(["pgrep", "-f", canary], capture_output=True, text=True)
    check("cap 超时：进程组无游魂（pgrep 空）", left.returncode != 0,
          "存活：%s" % left.stdout.strip())
    shutil.rmtree(ws, ignore_errors=True)


def test_keystone_escalation():
    ws = make_ws({})
    _rewrite_agents(ws, {"reviewer": {
        "enabled": True, "intervalSeconds": 1, "capSeconds": 30,
        "model": "sonnet", "effort": "high",
        "command": fake_cmd(ws, 0, "model={model}", "effort={effort}")}})
    seed_keystone_ticket(ws, "In Review")
    r = run_wl(ws, "--project", "t1", "--once", "--agents", "reviewer")
    rows, msgs = ledger(ws), [m for m in markers(ws) if m[0] == "msg"]
    check("keystone 升档：命令收到 opus/max",
          any("model=opus effort=max" in m[2] for m in msgs),
          "msgs=%r rc=%d" % (msgs, r.returncode))
    check("keystone 升档：ledger keystoneEscalated=true 且 model=opus",
          rows and rows[-1]["keystoneEscalated"] and rows[-1]["model"] == "opus")
    # 反例：keystone 票不在 In Review ⇒ 不升档
    seed_keystone_ticket(ws, "Done")
    os.remove(os.path.join(ws, "markers.txt"))
    os.remove(os.path.join(ws, ".writing-loop", "t1", "fires.jsonl"))
    run_wl(ws, "--project", "t1", "--once", "--agents", "reviewer")
    rows, msgs = ledger(ws), [m for m in markers(ws) if m[0] == "msg"]
    check("keystone 反例：Done 票不触发升档（sonnet/high）",
          any("model=sonnet effort=high" in m[2] for m in msgs)
          and rows and not rows[-1]["keystoneEscalated"])
    shutil.rmtree(ws, ignore_errors=True)


def test_dry_run():
    ws = make_ws({})
    canary = os.path.join(ws, "should-not-exist")
    _rewrite_agents(ws, {
        "showrunner": {"enabled": True,
                       "command": ["sh", "-c", "touch %s" % canary]},
        "reviewer": {"enabled": True}})  # 无 command ⇒ 走 claude 默认模板
    r = run_wl(ws, "--project", "t1", "--dry-run")
    check("dry-run：rc=0 且零 spawn（canary 不存在）",
          r.returncode == 0 and not os.path.exists(canary))
    check("dry-run：不写 fires.jsonl", ledger(ws) == [])
    check("dry-run：claude 默认命令形完整解析",
          "claude" in r.stdout and "/writing-loop:reviewer-agent" in r.stdout
          and "--model" in r.stdout and "--dangerously-skip-permissions" in r.stdout
          and "--add-dir" in r.stdout and "cwd :" in r.stdout)
    shutil.rmtree(ws, ignore_errors=True)


def test_plan():
    ws = make_ws({})
    _rewrite_agents(ws, {"showrunner": {"enabled": True},
                         "reviewer": {"enabled": True}})
    r = run_wl(ws, "--project", "t1", "--plan", "5")
    lines = [ln for ln in r.stdout.splitlines() if ln.strip().startswith("T+")]
    check("plan：恰好 N 行排程且零 spawn", r.returncode == 0 and len(lines) == 5
          and ledger(ws) == [], "行数=%d" % len(lines))
    shutil.rmtree(ws, ignore_errors=True)


def test_lock_guard():
    ws = make_ws({})
    _rewrite_agents(ws, {"sweep": {"enabled": True, "intervalSeconds": 1,
                                   "capSeconds": 30, "command": fake_cmd(ws, 0)}})
    proj = os.path.join(ws, ".writing-loop", "t1")
    os.makedirs(proj, exist_ok=True)
    lock = os.path.join(proj, "wl-run.lock")
    with open(lock, "w") as f:
        f.write("holder pid=99999 (another wl-run)\n")
    r = run_wl(ws, "--project", "t1", "--once", "--agents", "sweep")
    check("锁在位：拒绝启动（rc!=0 且报锁路径）",
          r.returncode != 0 and "wl-run.lock" in r.stderr, "rc=%d" % r.returncode)
    os.remove(lock)
    r = run_wl(ws, "--project", "t1", "--once", "--agents", "sweep")
    check("锁释放后：正常运行且跑完自动释放锁",
          r.returncode == 0 and not os.path.exists(lock), "rc=%d" % r.returncode)
    shutil.rmtree(ws, ignore_errors=True)


def main():
    for fn in [test_interval_noop_ledger, test_single_flight, test_cap_timeout_kill,
               test_keystone_escalation, test_dry_run, test_plan, test_lock_guard]:
        try:
            fn()
        except Exception as e:  # 用例崩溃也计 FAIL，不中断其余用例
            global nfail
            nfail += 1
            print("FAIL %s 异常：%r" % (fn.__name__, e))
    print("test-wl-run: %d pass, %d fail" % (npass, nfail))
    return 1 if nfail else 0


if __name__ == "__main__":
    sys.exit(main())
