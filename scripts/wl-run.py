#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""writing-loop 内建调度器（wl-run）—— 单进程驱动一个项目的全部 agent 循环。

取代两样东西：外部 tmux 面板 launcher（每 agent 一条 shell 循环、跨 agent 天然并发）
与对宿主 CLI /loop 的依赖。核心裁决（WL-55）：conventions §15.6「同一时刻至多一个
fire 在写 repo」这一前提由本调度器**以构造保证**——写 repo 四角色（showrunner /
story-designer / episode-writer / evaluator，§15.6 逐字列举的 stage+commit 主体）
全局单飞（at most ONE in flight）；板上角色（reviewer / sweep / script-doctor /
market-watch / reflect，绝不向剧本 repo 落 commit）可与写者并发、彼此至多 2 路。
于是共享 checkout + repo.lock 的默认轨道恒为合规，不必 worktree。

其他职责：
- keystone 升档（conventions 拓扑一览 keystone-stall 护栏的 launcher 分支）：起
  reviewer fire 前 glob 板 frontmatter，∃ In Review + keystone 票 ⇒ 本 fire 用
  scheduler.keystoneReviewer 档（默认 opus/max）。launcher 只 advisory 选档——
  floor 判定仍由 reviewer agent 自己按 conventions 做（§0/§18 单一真相源不变）。
- 遥测：每 fire 追加一行 JSON 到 <workspace>/.writing-loop/<key>/fires.jsonl
  {agent, model, effort, startedAt, endedAt, durationSeconds, exitCode, timedOut,
  noop, keystoneEscalated}。时间戳一律取本进程自己的时钟（UTC）——agent 的自述
  时间不可信，墙钟谓词（§7 陈旧、§9 24h 重提醒类）以此为可信时间源。
- 防重跑：项目级 `wl-run.lock`（scripts/board-lock.sh choreography：O_EXCL 独占
  创建、>60min 陈旧强清；无 bash 时按同一散文语义 inline 执行）。运行中每 30s
  touch 心跳 ⇒ 活进程永不因陈旧被抢；崩溃残锁 60min 后自动回收。
- 节律语义同被退役的 shell launcher：interval = 上一 fire **结束**到下一 fire
  开始的间隔（非固定频率）；每 fire capSeconds 墙钟上限，超时 TERM→KILL 并记账。

配置：workspace config.json 顶层 `scheduler` 块 + `projects.<key>.scheduler` 覆盖
（schema 见 references/config-schema.md）。stdlib-only，零依赖。
自测：python3 scripts/test-wl-run.py（或 wl-run.py --self-test）。
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# 默认表 —— 与实战 launcher 的 SPECS 表逐格一致（agent|model|effort|interval|cap|stagger）
# ---------------------------------------------------------------------------
AGENT_SPECS = [
    # (agent, model, effort, intervalSeconds, capSeconds, staggerSeconds)
    ("showrunner",     "opus",   "max",   180,  3600, 0),
    ("story-designer", "opus",   "max",   240,  3600, 10),
    ("episode-writer", "sonnet", "high",  300,  2400, 20),
    ("reviewer",       "opus",   "max",   240,  2400, 30),
    ("evaluator",      "opus",   "xhigh", 240,  2400, 40),
    ("sweep",          "sonnet", "high",  600,  1200, 50),
    ("script-doctor",  "opus",   "xhigh", 1800, 2400, 60),
    ("market-watch",   "sonnet", "high",  3600, 1200, 70),
    ("reflect",        "opus",   "xhigh", 3600, 2400, 80),
]
AGENT_ORDER = [s[0] for s in AGENT_SPECS]

# 写者/板上分类 —— 依据 conventions §15.6 逐字列举的 repo commit 主体；
# reviewer 的 §15.4 revert 是写进跟进票 AC 由 writer 层执行的，reviewer 本体不 commit。
REPO_WRITERS = {"showrunner", "story-designer", "episode-writer", "evaluator"}
BOARD_ONLY_MAX = 2          # 板上角色彼此的并发上限
GRACE_DEFAULT = 30          # Ctrl-C / --for 到点后等 in-flight 收尾的宽限秒数
KEYSTONE_DEFAULT = {"model": "opus", "effort": "max"}
HEARTBEAT_S = 30            # 锁心跳 touch 周期
TICK_S = 0.2                # 主循环轮询周期

# cli:"codex" 时把配置里的 Claude 档位名映射为 Codex 名（conventions 拓扑一览映射表）；
# 不在表内的值原样透传（操作者已直接写 Codex 名）。
CODEX_MODEL_MAP = {"opus": "gpt-5.5", "sonnet": "gpt-5.5"}
CODEX_EFFORT_MAP = {"max": "xhigh", "xhigh": "xhigh", "high": "high",
                    "medium": "medium", "low": "low"}


def utc_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds") \
        .replace("+00:00", "Z")


def die(msg, code=1):
    print("wl-run: %s" % msg, file=sys.stderr)
    sys.exit(code)


# ---------------------------------------------------------------------------
# workspace / config（解析规则同 config-schema：从 CWD 向上找 .writing-loop/）
# ---------------------------------------------------------------------------

def find_workspace(start=None):
    d = os.path.abspath(start or os.getcwd())
    while True:
        if os.path.isdir(os.path.join(d, ".writing-loop")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def load_config(data_root):
    path = os.path.join(data_root, "config.json")
    if not os.path.isfile(path):
        die("找不到 %s —— 请先 /add-script 立项" % path)
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except ValueError as e:
        die("config.json 解析失败：%s" % e)


def select_project(cfg, workspace, want_key):
    projects = cfg.get("projects") or {}
    enabled = {k: v for k, v in projects.items() if v.get("enabled", True)}
    if want_key:
        if want_key not in projects:
            die("config.json 无项目 %r（现有：%s）" % (want_key, ", ".join(projects) or "无"))
        if want_key not in enabled:
            die("项目 %r 已 enabled:false（操作者暂停中）—— 不驱动" % want_key)
        return want_key, projects[want_key]
    # §11 定位规则：CWD 在某 repoPath 内 ⇒ 该项目；否则恰一个 enabled ⇒ 该项目；否则不猜。
    cwd = os.path.realpath(os.getcwd())
    for k, p in enabled.items():
        repo = os.path.realpath(resolve_repo(p, workspace))
        if cwd == repo or cwd.startswith(repo + os.sep):
            return k, p
    if len(enabled) == 1:
        k = next(iter(enabled))
        return k, enabled[k]
    die("多项目 workspace，无法唯一定位 —— 用 --project 指定（enabled：%s）"
        % (", ".join(enabled) or "无"))


def resolve_repo(project, workspace):
    rp = project.get("repoPath") or ""
    return rp if os.path.isabs(rp) else os.path.join(workspace, rp)


# ---------------------------------------------------------------------------
# scheduler 配置合并（低→高：SPECS 默认 < workspace scheduler < 项目 models/efforts
# 档位映射 < 项目 scheduler）
# ---------------------------------------------------------------------------

def _check_agent_block(src, blk):
    for name in blk:
        if name not in AGENT_ORDER:
            die("%s.agents 含未知 agent %r（合法：%s）" % (src, name, ", ".join(AGENT_ORDER)))
        for fld, val in blk[name].items():
            if fld in ("intervalSeconds", "capSeconds", "staggerSeconds"):
                low = 0 if fld == "staggerSeconds" else 1
                if not isinstance(val, int) or val < low:
                    die("%s.agents.%s.%s 必须是 ≥%d 的整数（得到 %r）"
                        % (src, name, fld, low, val))
            elif fld == "enabled":
                if not isinstance(val, bool):
                    die("%s.agents.%s.enabled 必须是布尔（得到 %r）" % (src, name, val))
            elif fld == "command":
                if not (isinstance(val, list) and val and all(isinstance(x, str) for x in val)):
                    die("%s.agents.%s.command 必须是非空字符串数组" % (src, name))
            elif fld not in ("model", "effort"):
                die("%s.agents.%s 含未知字段 %r" % (src, name, fld))


def build_sched(cfg, key, project):
    sched = {
        "cli": "claude",
        "graceSeconds": GRACE_DEFAULT,
        "keystoneReviewer": dict(KEYSTONE_DEFAULT),
        "agents": {},
    }
    for agent, model, effort, interval, cap, stagger in AGENT_SPECS:
        sched["agents"][agent] = {
            "model": model, "effort": effort, "intervalSeconds": interval,
            "capSeconds": cap, "enabled": True, "staggerSeconds": stagger,
            "command": None,
        }
    layers = [("scheduler", cfg.get("scheduler") or {}),
              ("projects.%s.scheduler" % key, project.get("scheduler") or {})]
    # 既有 per-project 档位映射（config-schema「agent 档位覆盖」）居中生效
    for agent, m in (project.get("models") or {}).items():
        if agent in sched["agents"]:
            sched["agents"][agent]["model"] = m
    for agent, e in (project.get("efforts") or {}).items():
        if agent in sched["agents"]:
            sched["agents"][agent]["effort"] = e
    for src, layer in layers:
        if not isinstance(layer, dict):
            die("%s 必须是对象" % src)
        for k2, v in layer.items():
            if k2 == "agents":
                _check_agent_block(src, v)
                for name, blk in v.items():
                    sched["agents"][name].update(blk)
            elif k2 == "cli":
                if v not in ("claude", "codex"):
                    die('%s.cli 必须是 "claude" | "codex"（得到 %r）' % (src, v))
                sched["cli"] = v
            elif k2 == "graceSeconds":
                if not isinstance(v, int) or v < 0:
                    die("%s.graceSeconds 必须是 ≥0 的整数" % src)
                sched["graceSeconds"] = v
            elif k2 == "keystoneReviewer":
                if not isinstance(v, dict) or set(v) - {"model", "effort"}:
                    die("%s.keystoneReviewer 只接受 {model, effort}" % src)
                sched["keystoneReviewer"].update(v)
            else:
                die("%s 含未知字段 %r" % (src, k2))
    return sched


# ---------------------------------------------------------------------------
# keystone 升档谓词：板 frontmatter 纯 glob（不读票体）
# ---------------------------------------------------------------------------

def keystone_pending(board_tickets_dir):
    if not os.path.isdir(board_tickets_dir):
        return False
    for fn in os.listdir(board_tickets_dir):
        if not fn.endswith(".md"):
            continue
        try:
            with open(os.path.join(board_tickets_dir, fn), encoding="utf-8",
                      errors="replace") as f:
                head = f.read(4096)
        except OSError:
            continue
        if not head.startswith("---"):
            continue
        fm = head.split("\n---", 1)[0]
        m_state = re.search(r"^state:\s*(.+?)\s*$", fm, re.M)
        m_labels = re.search(r"^labels:\s*\[(.*?)\]", fm, re.M)
        if not m_state or not m_labels:
            continue
        labels = [t.strip() for t in m_labels.group(1).split(",")]
        if m_state.group(1) == "In Review" and "keystone" in labels:
            return True
    return False


# ---------------------------------------------------------------------------
# 命令构建
# ---------------------------------------------------------------------------

def fire_argv(sched, agent, model, effort, repo, data_root):
    skill = "/writing-loop:%s-agent" % agent
    override = sched["agents"][agent].get("command")
    if override:
        subs = {"{skill}": skill, "{model}": model, "{effort}": effort or "",
                "{repo}": repo, "{data}": data_root, "{agent}": agent}
        out = []
        for tok in override:
            for k, v in subs.items():
                tok = tok.replace(k, v)
            out.append(tok)
        return out
    if sched["cli"] == "codex":
        m = CODEX_MODEL_MAP.get(model, model)
        e = CODEX_EFFORT_MAP.get(effort, effort) if effort else None
        argv = ["codex", "exec", "-C", repo,
                "--dangerously-bypass-approvals-and-sandbox",
                "--skip-git-repo-check", "--model", m]
        if e:
            argv += ["-c", 'model_reasoning_effort="%s"' % e]
        argv.append(skill)
        return argv
    # claude —— 与被退役 launcher 的 run-agent.sh 调用形逐 flag 一致
    argv = ["claude", "-p", skill, "--model", model]
    if effort:
        argv += ["--effort", effort]
    argv += ["--dangerously-skip-permissions", "--add-dir", data_root]
    return argv


def fire_env():
    env = dict(os.environ)
    home_bin = os.path.join(os.path.expanduser("~"), ".local", "bin")
    env["PATH"] = home_bin + os.pathsep + env.get("PATH", "")
    return env


def resolve_tier(sched, agent, board_dir):
    """(model, effort, keystoneEscalated)。reviewer 且板上有 In Review+keystone ⇒ 升档。"""
    blk = sched["agents"][agent]
    if agent == "reviewer" and keystone_pending(board_dir):
        ks = sched["keystoneReviewer"]
        return (ks.get("model") or blk["model"],
                ks.get("effort") or blk["effort"], True)
    return blk["model"], blk["effort"], False


# ---------------------------------------------------------------------------
# 项目锁（board-lock.sh choreography；缺 bash 时 inline 同语义）
# ---------------------------------------------------------------------------

def _helper():
    p = os.path.join(SCRIPT_DIR, "board-lock.sh")
    return p if os.path.isfile(p) else None


def _holder_line():
    # 与 board-lock.sh is_holder_shaped 的锚定文法逐字对齐（秒精度、无后缀）——两个工具互认
    # 彼此的锁；任何偏离都会让对方把本方残锁判成「非锁文件」而拒收（WL-53 守卫的反面）。
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return "holder pid=%d at %s\n" % (os.getpid(), ts)


_HOLDER_RE = re.compile(r"^holder pid=\d+ at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n?$")


def _is_holder_shaped(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            body = f.read(256)
    except OSError:
        return False
    return bool(_HOLDER_RE.match(body))


def acquire_lock(lock_path):
    assert lock_path.endswith(".lock"), "锁路径必须以 .lock 结尾（防误传目标文件）"
    helper = _helper()
    if helper:
        try:
            return subprocess.call(["bash", helper, "acquire", lock_path]) == 0
        except FileNotFoundError:
            pass  # bash 二进制缺失 ⇒ 落入 inline 同语义路径
    for attempt in (1, 2):
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, _holder_line().encode("utf-8"))
            os.close(fd)
            return True
        except FileExistsError:
            try:
                stale = (time.time() - os.stat(lock_path).st_mtime) > 60 * 60
            except OSError:
                stale = False
            if attempt == 1 and stale:
                # WL-53 守卫（inline 同 board-lock.sh）：超龄但非 holder 格式 ⇒ 绝不 rm。
                if not _is_holder_shaped(lock_path):
                    print("wl-run: %s 超龄但不是本工具的锁文件——绝不删除，请人工检查（WL-53）"
                          % lock_path, file=sys.stderr)
                    return False
                print("wl-run: stale lock >60min，强清重试：%s" % lock_path, file=sys.stderr)
                try:
                    os.unlink(lock_path)
                except OSError:
                    pass
                continue
            return False
    return False


def release_lock(lock_path):
    helper = _helper()
    if helper:
        try:
            subprocess.call(["bash", helper, "release", lock_path])
            return
        except FileNotFoundError:
            pass
    if _is_holder_shaped(lock_path):
        try:
            os.unlink(lock_path)
        except OSError:
            pass
    else:
        print("wl-run: %s 不是 holder 格式——拒绝释放删除，请人工检查（WL-53）" % lock_path,
              file=sys.stderr)


def heartbeat(lock_path):
    try:
        os.utime(lock_path, None)
    except OSError:
        try:  # 锁被外力移走 —— 重建，绝不无锁裸跑
            with open(lock_path, "w", encoding="utf-8") as f:
                f.write(_holder_line())
        except OSError:
            pass


# ---------------------------------------------------------------------------
# fire 生命周期
# ---------------------------------------------------------------------------

class Fire:
    def __init__(self, agent, popen, model, effort, escalated, cap, log_path):
        self.agent = agent
        self.popen = popen
        self.model = model
        self.effort = effort
        self.escalated = escalated
        self.cap = cap
        self.log_path = log_path
        self.started_mono = time.monotonic()
        self.started_iso = utc_iso()
        self.timed_out = False
        self.kill_deadline = None


def detect_noop(log_path):
    """§0：no-op fire 打印一行含「no-op」的收尾 —— 取输出尾部检测。"""
    try:
        with open(log_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 4096))
            tail = f.read().decode("utf-8", errors="replace")
    except OSError:
        return False
    lines = [ln.strip() for ln in tail.splitlines() if ln.strip()]
    return any("no-op" in ln.lower() for ln in lines[-5:])


def killpg(popen, sig):
    try:
        os.killpg(os.getpgid(popen.pid), sig)
    except (ProcessLookupError, PermissionError, OSError):
        pass


class Scheduler:
    def __init__(self, args, workspace, data_root, key, project, sched):
        self.args = args
        self.workspace = workspace
        self.data_root = data_root
        self.key = key
        self.repo = os.path.abspath(resolve_repo(project, workspace))
        self.sched = sched
        self.proj_data = os.path.join(data_root, key)
        self.board_dir = os.path.join(self.proj_data, "board", "tickets")
        self.logs_dir = os.path.join(self.proj_data, "logs")
        self.ledger_path = os.path.join(self.proj_data, "fires.jsonl")
        self.lock_path = os.path.join(self.proj_data, "wl-run.lock")
        self.selected = self._select_agents(args.agents)
        self.inflight = []
        self.fired_once = set()
        self.stop_requested = 0     # 1 = 优雅停，2 = 立即杀
        self._log_seq = 0

    def _select_agents(self, spec):
        if not spec:
            return [a for a in AGENT_ORDER if self.sched["agents"][a]["enabled"]]
        out = []
        for tok in spec.split(","):
            name = tok.strip()
            name = name[:-len("-agent")] if name.endswith("-agent") else name
            if name not in AGENT_ORDER:
                die("--agents 含未知 agent %r（合法：%s）" % (tok.strip(), ", ".join(AGENT_ORDER)))
            if name not in out:
                out.append(name)
        return out

    # ---- 并发闸 ----
    def slot_free(self, agent):
        if agent in REPO_WRITERS:
            return not any(f.agent in REPO_WRITERS for f in self.inflight)
        return sum(1 for f in self.inflight if f.agent not in REPO_WRITERS) < BOARD_ONLY_MAX

    # ---- 遥测 ----
    def ledger_append(self, row):
        with open(self.ledger_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    # ---- 起 fire ----
    def launch(self, agent):
        model, effort, escalated = resolve_tier(self.sched, agent, self.board_dir)
        argv = fire_argv(self.sched, agent, model, effort, self.repo, self.data_root)
        os.makedirs(self.logs_dir, exist_ok=True)
        self._log_seq += 1
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        log_path = os.path.join(self.logs_dir, "%s-%02d-%s.log" % (stamp, self._log_seq, agent))
        log_f = open(log_path, "wb")
        try:
            popen = subprocess.Popen(
                argv, cwd=self.repo, env=fire_env(), stdin=subprocess.DEVNULL,
                stdout=log_f, stderr=subprocess.STDOUT, start_new_session=True)
        except OSError as e:
            log_f.close()
            print("[%s] FAIL %s：无法起进程（%s）" % (utc_iso(), agent, e), flush=True)
            now_iso = utc_iso()
            self.ledger_append({
                "agent": agent, "model": model, "effort": effort,
                "startedAt": now_iso, "endedAt": now_iso, "durationSeconds": 0.0,
                "exitCode": None, "timedOut": False, "noop": False,
                "keystoneEscalated": escalated, "spawnError": str(e)})
            self.fired_once.add(agent)
            return
        log_f.close()  # 子进程已持有 fd
        fire = Fire(agent, popen, model, effort, escalated,
                    self.sched["agents"][agent]["capSeconds"], log_path)
        self.inflight.append(fire)
        self.fired_once.add(agent)
        cls = "repo-writer" if agent in REPO_WRITERS else "board-only"
        print("[%s] fire %s（%s/%s%s，%s，cap %ds）→ %s" % (
            fire.started_iso, agent, model, effort or "-",
            "，keystone 升档" if escalated else "", cls,
            fire.cap, os.path.relpath(log_path, self.proj_data)), flush=True)

    # ---- 收 fire ----
    def finish(self, fire, rc):
        self.inflight.remove(fire)
        ended = utc_iso()
        dur = round(time.monotonic() - fire.started_mono, 3)
        noop = detect_noop(fire.log_path)
        self.ledger_append({
            "agent": fire.agent, "model": fire.model, "effort": fire.effort,
            "startedAt": fire.started_iso, "endedAt": ended,
            "durationSeconds": dur, "exitCode": rc, "timedOut": fire.timed_out,
            "noop": noop, "keystoneEscalated": fire.escalated})
        flags = []
        if fire.timed_out:
            flags.append("TIMEOUT>%ds" % fire.cap)
        if noop:
            flags.append("no-op")
        print("[%s] done %s exit %s in %.1fs%s" % (
            ended, fire.agent, rc, dur, "（%s）" % "，".join(flags) if flags else ""),
            flush=True)
        return time.monotonic() + self.sched["agents"][fire.agent]["intervalSeconds"]

    def poll_inflight(self, due):
        now = time.monotonic()
        for fire in list(self.inflight):
            rc = fire.popen.poll()
            if rc is not None:
                due[fire.agent] = self.finish(fire, rc)
                continue
            if fire.kill_deadline is not None:
                if now >= fire.kill_deadline:
                    killpg(fire.popen, signal.SIGKILL)
                    fire.kill_deadline = now + 3600  # 已 KILL，等 reap
            elif now - fire.started_mono > fire.cap:
                print("[%s] fire %s 超 cap %ds —— TERM（3s 后 KILL）"
                      % (utc_iso(), fire.agent, fire.cap), flush=True)
                fire.timed_out = True
                killpg(fire.popen, signal.SIGTERM)
                fire.kill_deadline = now + 3

    def kill_all(self, sig):
        for fire in self.inflight:
            killpg(fire.popen, sig)
            if fire.kill_deadline is None:
                fire.kill_deadline = time.monotonic() + 3

    # ---- 主循环 ----
    def run(self):
        os.makedirs(self.proj_data, exist_ok=True)
        if not acquire_lock(self.lock_path):
            die("另一个 wl-run 正持有 %s（或 <60min 前崩溃）—— 先停它，或等陈旧锁 60min 自动回收"
                % self.lock_path)
        def on_signal(_sig, _frm):
            self.stop_requested = min(self.stop_requested + 1, 2)
        signal.signal(signal.SIGINT, on_signal)
        signal.signal(signal.SIGTERM, on_signal)

        start = time.monotonic()
        due = {}
        for a in self.selected:
            due[a] = start if self.args.once \
                else start + self.sched["agents"][a]["staggerSeconds"]
        last_beat = start
        grace_deadline = None
        print("wl-run: 项目 %s · cli=%s · agents=%s · 单飞写者=%s · 板上≤%d 并发\n"
              "        repo=%s\n        ledger=%s"
              % (self.key, self.sched["cli"], ",".join(self.selected),
                 ",".join(a for a in self.selected if a in REPO_WRITERS) or "无",
                 BOARD_ONLY_MAX, self.repo, self.ledger_path), flush=True)
        try:
            while True:
                self.poll_inflight(due)
                now = time.monotonic()
                stopping = self.stop_requested > 0 or \
                    (self.args.for_seconds and now - start >= self.args.for_seconds)
                if self.stop_requested >= 2:
                    self.kill_all(signal.SIGKILL)
                if stopping:
                    if grace_deadline is None:
                        grace_deadline = now + self.sched["graceSeconds"]
                        if self.inflight:
                            print("wl-run: 停止请求 —— 等 in-flight 收尾（宽限 %ds，"
                                  "再按一次 Ctrl-C 立即杀）" % self.sched["graceSeconds"],
                                  flush=True)
                    if not self.inflight:
                        break
                    if now >= grace_deadline:
                        self.kill_all(signal.SIGTERM)
                        grace_deadline = now + 3600  # TERM 已发；kill_deadline 接管
                else:
                    for agent in sorted(self.selected,
                                        key=lambda a: (due[a], AGENT_ORDER.index(a))):
                        if any(f.agent == agent for f in self.inflight):
                            continue
                        if self.args.once and agent in self.fired_once:
                            continue
                        if due[agent] > now or not self.slot_free(agent):
                            continue
                        self.launch(agent)
                if self.args.once and not self.inflight \
                        and set(self.selected) <= self.fired_once:
                    break
                if now - last_beat >= HEARTBEAT_S:
                    heartbeat(self.lock_path)
                    last_beat = now
                time.sleep(TICK_S)
        finally:
            release_lock(self.lock_path)
        print("wl-run: 干净停止（ledger：%s）" % self.ledger_path, flush=True)
        return 0

    # ---- dry-run / plan ----
    def dry_run(self):
        print("wl-run --dry-run: 项目 %s · cli=%s —— 只打印将起的命令，不 spawn、不写 ledger、不拿锁"
              % (self.key, self.sched["cli"]))
        for agent in self.selected:
            model, effort, escalated = resolve_tier(self.sched, agent, self.board_dir)
            argv = fire_argv(self.sched, agent, model, effort, self.repo, self.data_root)
            blk = self.sched["agents"][agent]
            cls = "repo-writer（全局单飞）" if agent in REPO_WRITERS \
                else "board-only（≤%d 并发）" % BOARD_ONLY_MAX
            print("\n%s  [%s]  interval %ds · cap %ds%s" % (
                agent, cls, blk["intervalSeconds"], blk["capSeconds"],
                " · KEYSTONE 升档中（板上有 In Review+keystone）" if escalated else ""))
            print("  cmd : %s" % " ".join("'%s'" % a if " " in a else a for a in argv))
            print("  cwd : %s" % self.repo)
            print("  env : PATH=~/.local/bin:$PATH（继承其余环境）")
        return 0

    def plan(self, n):
        print("wl-run --plan %d: 未来 %d 个 fire 的排程模拟（假定每 fire 0 秒完成；"
              "实际次序还受单飞/并发闸与 fire 时长影响）" % (n, n))
        due = [(self.sched["agents"][a]["staggerSeconds"], AGENT_ORDER.index(a), a)
               for a in self.selected]
        for _ in range(n):
            due.sort()
            t, idx, agent = due.pop(0)
            blk = self.sched["agents"][agent]
            cls = "repo-writer" if agent in REPO_WRITERS else "board-only"
            print("  %s %-15s %s/%s（%s）" % (
                ("T+%ds" % t).ljust(8), agent, blk["model"], blk["effort"] or "-", cls))
            due.append((t + blk["intervalSeconds"], idx, agent))
        return 0


# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="wl-run",
        description="writing-loop 内建调度器：单进程驱动一个项目的全部 agent 循环"
                    "（写 repo 角色全局单飞；keystone 自动升档；fires.jsonl 遥测）。")
    ap.add_argument("--project", metavar="KEY", help="项目 key（多项目 workspace 必填）")
    ap.add_argument("--once", action="store_true",
                    help="每个入选 agent 恰好 fire 一次（忽略 stagger），跑完即退")
    ap.add_argument("--dry-run", action="store_true",
                    help="打印每条将起命令的完整解析（model/effort/cwd/env），不 spawn")
    ap.add_argument("--plan", type=int, metavar="N", help="模拟打印未来 N 个 fire 的排程")
    ap.add_argument("--agents", metavar="a,b",
                    help="只驱动这些 agent（逗号分隔；接受 showrunner 或 showrunner-agent 形）")
    ap.add_argument("--for", dest="for_seconds", type=float, default=0.0, metavar="S",
                    help="运行 S 秒后优雅停止（0 = 直到 Ctrl-C）")
    ap.add_argument("--self-test", action="store_true",
                    help="跑 scripts/test-wl-run.py 自测并退出")
    args = ap.parse_args(argv)

    if args.self_test:
        test = os.path.join(SCRIPT_DIR, "test-wl-run.py")
        if not os.path.isfile(test):
            die("找不到 %s" % test)
        return subprocess.call([sys.executable, test])

    workspace = find_workspace()
    if not workspace:
        die("未在 workspace 内（从 CWD 向上找不到 .writing-loop/）—— 先 /add-script 立项")
    data_root = os.path.join(workspace, ".writing-loop")
    cfg = load_config(data_root)
    key, project = select_project(cfg, workspace, args.project)
    repo = resolve_repo(project, workspace)
    if not os.path.isdir(repo):
        die("项目 %s 的 repoPath 不存在：%s" % (key, repo))
    sched = build_sched(cfg, key, project)
    s = Scheduler(args, workspace, data_root, key, project, sched)
    if not s.selected:
        die("无入选 agent（全部 enabled:false？）")
    if args.plan is not None:
        return s.plan(args.plan)
    if args.dry_run:
        return s.dry_run()
    return s.run()


if __name__ == "__main__":
    sys.exit(main())
