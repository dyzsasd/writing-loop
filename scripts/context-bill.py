#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""writing-loop 每-agent 每-fire 上下文账单（stdlib-only，file-board 基底，无 hub、无 CLI 动词）。

本脚本是两个「机器权威」的宿主：

1. **BUDGETS 表** —— 每 SKILL 的散文预算（行 + 字符双约束，CJK 校准）。
   docs/design/2026-07-review-decisions.md D2 是它的镜像；两者不一致时以本表为准并回改 D2。
   scripts/lint.py 通过 import 读取本表执法（Phase 5 迁移前为 WARN-only，--strict 才 fail）。

2. **每 fire 账单** —— 各 agent 一次工作 fire 的强制读取量：
   SKILL 全文 + conventions（见下）+ boot 强制姊妹参考 + §14 lessons 上限估算。

度量口径（也被 lint.py 复用，保证两边一致）：
- prose（预算口径）= SKILL.md 去除 YAML frontmatter 后的正文；
  行 = splitlines() 计数（含空行）；字符 = len()（解码后字符串，含换行——CJK 每字计 1）。
- 账单里的 SKILL 条目 = 整个文件（frontmatter 也是 boot 上下文）。
- conventions：SKILL 无 `Sections:` 行 ⇒ 整份计入（Phase 4 之前的现实）。
  SKILL 的 boot 节若出现 `Sections: §0 §2 §5a …` 行（Phase 4 落地形态），本脚本**已经**
  支持：只计 前言+目录+拓扑一览（always-read）+ 所引各节 span 的并集——Phase 4 无需改脚本。
  span 语义：锚点标题起，到下一个同级或更浅标题前一行止（fenced code 内的 # 行不算标题）。
- boot 强制姊妹参考：解析 `## 0` 节（扣除 Step-0 探针块——探针按定义不读任何 reference），
  提及 references/*.md 或 templates/*.md（含裸名如「craft-rules」）即计；所在段落含
  「按需」或「可选」字样 ⇒ 不计入强制账单。
- ~tokens 估算（趋势用，不作计费）：CJK 字符 ≈ 1 token/字；其余按 UTF-8 ≈ 4 字节/token。
- lessons：§14 上限 ≤150 行 ≈ 6 KB ⇒ 常数估入（bytes=6144, chars≈2048, tokens≈2048）。

用法：python3 scripts/context-bill.py   （输出 markdown，可直接 >> $GITHUB_STEP_SUMMARY）
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS_DIR = os.path.join(ROOT, "skills")
REFS_DIR = os.path.join(ROOT, "references")
CONVENTIONS = os.path.join(REFS_DIR, "conventions.md")

# ---------------------------------------------------------------------------
# BUDGETS —— 机器权威（镜像：docs/design/2026-07-review-decisions.md D2）
# 行 + 字符双约束，先触先算超。字符按 len()（CJK 校准：≈1 token/字）。
# ---------------------------------------------------------------------------
BUDGETS = {
    # showrunner（PM 原型）——9500→10100：WL-44 第五逃逸口（操作者批准）+ D5 决策点
    # 重验/R6.2 邻卡 cite 为强制载荷，不可削（D6）。
    "showrunner-agent": {"lines": 300, "chars": 10100},
    # writer 层
    "story-designer-agent": {"lines": 240, "chars": 7800},
    "episode-writer-agent": {"lines": 240, "chars": 7800},
    # reviewer：携带审读门全流程走查，+10% 豁免（同 dev-agent 携带 Step 0-7 先例）
    "reviewer-agent": {"lines": 260, "chars": 8500},
    # observer 层（evaluator/sweep 6800→7100：D5 完备性断言/时钟纪律 cite 强制载荷，D6）
    "evaluator-agent": {"lines": 210, "chars": 7100},
    "script-doctor-agent": {"lines": 210, "chars": 6800},
    "market-watch-agent": {"lines": 210, "chars": 6800},
    "reflect-agent": {"lines": 210, "chars": 6800},
    "sweep-agent": {"lines": 210, "chars": 7100},
    # 立项 skill
    "add-script": {"lines": 270, "chars": 8800},
}

# 结构预算（D2）：frontmatter description、Step-0 探针谓词块、boot 节。
FRONTMATTER_DESC_MAX_CHARS = 400   # 硬（Phase 0 已落地）
PROBE_MAX_LINES = 19               # Phase 5 前 WARN-only；12→19：WL-44 第五逃逸口
                                   # （墙钟谓词）按语义只能落探针块内（D6）
BOOT_MAX_LINES = 35                # Phase 5 前 WARN-only

# §14 lessons 上限的账单估算常数（≤150 行 ≈ 6KB）。
LESSONS_CAP = {"lines": 150, "bytes": 6144, "chars": 2048, "tokens": 2048}

# 无探针的 operator skill（结构检查与账单解析都按此区分）。
OPERATOR_SKILLS = {"add-script"}

SISTER_REF_NAMES = [
    "script-format", "craft-rules", "evaluation-rubric",
    "config-schema", "codex-integration",
]

CJK_RANGES = (
    (0x3000, 0x303F), (0x3400, 0x4DBF), (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF), (0xFF00, 0xFFEF),
)


# ---------------------------------------------------------------------------
# 共享度量函数（lint.py import 复用）
# ---------------------------------------------------------------------------

def read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def split_frontmatter(text):
    """返回 (frontmatter 含定界线, body)。无 frontmatter ⇒ ("", text)。"""
    if not text.startswith("---"):
        return "", text
    lines = text.splitlines(keepends=True)
    for i, ln in enumerate(lines[1:], start=1):
        if ln.rstrip("\n") == "---":
            return "".join(lines[: i + 1]), "".join(lines[i + 1:])
    return "", text


def prose_metrics(body):
    """预算口径：(行, 字符)。行含空行；字符 = len(body)（含换行）。"""
    return len(body.splitlines()), len(body)


def is_cjk(ch):
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in CJK_RANGES)


def est_tokens(text):
    """CJK ≈1 token/字；非 CJK 按 UTF-8 ≈4 字节/token。粗估，只用于趋势。"""
    cjk = sum(1 for ch in text if is_cjk(ch))
    other_bytes = len("".join(ch for ch in text if not is_cjk(ch)).encode("utf-8"))
    return cjk + (other_bytes + 3) // 4


def parse_headings(text):
    """[(行号0基, level, title)]，跳过 fenced code 里的 # 行。"""
    out, fenced = [], False
    for i, ln in enumerate(text.splitlines()):
        if ln.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            continue
        m = re.match(r"^(#{1,4})\s+(.*)$", ln)
        if m:
            out.append((i, len(m.group(1)), m.group(2).strip()))
    return out


ANCHOR_IN_TITLE = re.compile(r"^§(\d{1,2})([a-z])?(?:-([a-z]+))?\.")


def conventions_spans(text):
    """conventions 的锚点 span 表。

    返回 (spans, always_lines, total_lines)：
      spans: {"0": (s,e), "5a": (s,e), "21a-design": (s,e), …}（行号半开区间）
      always_lines: always-read 前言的行号集合（文件头至第一个 ## 前 + 目录 + 拓扑一览）
    """
    lines = text.splitlines()
    heads = parse_headings(text)
    spans, always = {}, set()
    first_h2 = next((i for i, lv, _ in heads if lv == 2), len(lines))
    always.update(range(0, first_h2))
    for idx, (i, lv, title) in enumerate(heads):
        end = len(lines)
        for j, jlv, _ in heads[idx + 1:]:
            if jlv <= lv:
                end = j
                break
        m = ANCHOR_IN_TITLE.match(title)
        if m:
            key = m.group(1) + (m.group(2) or "") + (("-" + m.group(3)) if m.group(3) else "")
            spans[key] = (i, end)
        elif title.startswith("目录") or title.startswith("拓扑一览"):
            always.update(range(i, end))
    return spans, always, len(lines)


SECTIONS_LINE = re.compile(r"^Sections:\s*(§\S+(?:\s+§\S+)*)\s*$", re.M)


def sections_line_anchors(body):
    """SKILL 的 `Sections:` 行（Phase 4 形态）⇒ 锚点 key 列表；无 ⇒ None。"""
    m = SECTIONS_LINE.search(body)
    if not m:
        return None
    return [a.lstrip("§") for a in m.group(1).split()]


def boot_section(body):
    """(## 0 节的行列表, 起始行号)。找不到 ⇒ ([], -1)。"""
    lines = body.splitlines()
    start = end = -1
    for i, ln in enumerate(lines):
        if start < 0 and re.match(r"^## 0[\.、 ]", ln):
            start = i
        elif start >= 0 and re.match(r"^## ", ln) and i > start:
            end = i
            break
    if start < 0:
        return [], -1
    return lines[start: end if end > 0 else len(lines)], start


PROBE_HEAD = re.compile(r"^### Step 0 .*(探针|cheap boot)")
READLIST_HEAD = re.compile(r"^(?:\*\*)?(?:最)?先读")


def probe_block(boot_lines):
    """Step-0 探针块在 boot 节内的 (start, end) 半开区间（相对 boot 节）；无 ⇒ None。

    探针块 = 探针标题行起，至读取清单前言（先读…/最先读…）或下一标题止。
    """
    start = None
    for i, ln in enumerate(boot_lines):
        if start is None and PROBE_HEAD.match(ln):
            start = i
            continue
        if start is not None and (READLIST_HEAD.match(ln) or re.match(r"^#{2,3} ", ln)):
            return (start, i)
    return (start, len(boot_lines)) if start is not None else None


def boot_read_list(body):
    """boot 强制姊妹参考（不含 conventions）：{"references/craft-rules.md", "templates/…", …}。

    只扫 ## 0 节、扣除探针块；段落（空行分隔）含「按需」/「可选」⇒ 整段不计；
    「见 / 详见 X」形式的指路提及（如 market-watch「其校准状态见 craft-rules 附录 A」）
    不算读取义务，单条不计。
    """
    boot_lines, off = boot_section(body)
    if not boot_lines:
        return set()
    pb = probe_block(boot_lines)
    if pb:
        boot_lines = boot_lines[: pb[0]] + boot_lines[pb[1]:]
    paras, cur = [], []
    for ln in boot_lines:
        if ln.strip():
            cur.append(ln)
        elif cur:
            paras.append("\n".join(cur))
            cur = []
    if cur:
        paras.append("\n".join(cur))
    found = set()
    name_re = re.compile(r"\b(" + "|".join(SISTER_REF_NAMES) + r")\b")
    tpl_re = re.compile(r"templates/([A-Za-z0-9_-]+\.md)")
    for p in paras:
        if "按需" in p or "可选" in p:
            continue
        for m in name_re.finditer(p):
            if p[max(0, m.start() - 2): m.start()].rstrip().endswith("见"):
                continue  # 「见 …」= 指路，不是读取义务
            found.add("references/%s.md" % m.group(1))
        for m in tpl_re.finditer(p):
            found.add("templates/%s" % m.group(1))
    return found


# ---------------------------------------------------------------------------
# 账单
# ---------------------------------------------------------------------------

def conventions_charge(conv_text, anchors):
    """conventions 计费：anchors=None ⇒ 整份；否则 always-read + 各锚点 span 并集。"""
    if anchors is None:
        return conv_text, "整份"
    spans, always, _total = conventions_spans(conv_text)
    lines = conv_text.splitlines()
    take = set(always)
    for a in anchors:
        if a in spans:
            take.update(range(*spans[a]))
    text = "\n".join(lines[i] for i in sorted(take))
    return text, "Sections: %d 节" % len(anchors)


def build_bill():
    conv_text = read_text(CONVENTIONS)
    rows = []
    for name in sorted(os.listdir(SKILLS_DIR)):
        path = os.path.join(SKILLS_DIR, name, "SKILL.md")
        if not os.path.isfile(path):
            continue
        text = read_text(path)
        _fm, body = split_frontmatter(text)
        anchors = sections_line_anchors(body)
        conv_part, conv_mode = conventions_charge(conv_text, anchors)
        sisters = sorted(boot_read_list(body))
        sister_texts = []
        for rel in sisters:
            p = os.path.join(ROOT, rel)
            if os.path.isfile(p):
                sister_texts.append(read_text(p))
        parts = [text, conv_part] + sister_texts
        chars = sum(len(t) for t in parts) + LESSONS_CAP["chars"]
        bts = sum(len(t.encode("utf-8")) for t in parts) + LESSONS_CAP["bytes"]
        toks = sum(est_tokens(t) for t in parts) + LESSONS_CAP["tokens"]
        p_lines, p_chars = prose_metrics(body)
        rows.append({
            "agent": name,
            "prose_lines": p_lines, "prose_chars": p_chars,
            "skill_chars": len(text),
            "conv_mode": conv_mode, "conv_chars": len(conv_part),
            "sisters": sisters,
            "sisters_chars": sum(len(t) for t in sister_texts),
            "total_chars": chars, "total_bytes": bts, "total_tokens": toks,
        })
    rows.sort(key=lambda r: -r["total_tokens"])
    return rows


def main():
    rows = build_bill()
    print("## writing-loop 每 fire 上下文账单（强制读取量）\n")
    print("| agent | SKILL 行/字符 | conventions | 姊妹参考（boot 强制） | 总字符 | 总字节 | ~tokens |")
    print("|---|---|---|---|---:|---:|---:|")
    for r in rows:
        sis = ", ".join(s.split("/")[-1] for s in r["sisters"]) or "—"
        print("| %s | %d / %s | %s（%s 字符） | %s（%s 字符） | %s | %s | %s |" % (
            r["agent"], r["prose_lines"], format(r["prose_chars"], ","),
            r["conv_mode"], format(r["conv_chars"], ","),
            sis, format(r["sisters_chars"], ","),
            format(r["total_chars"], ","), format(r["total_bytes"], ","),
            format(r["total_tokens"], ","),
        ))
    print("\n估算口径：CJK ≈1 token/字，其余 ≈4 UTF-8 字节/token；lessons 按 §14 上限"
          "（≤150 行 ≈ 6KB）估入每行账单。conventions 列「整份」= Phase 4 前的现实；"
          "SKILL 出现 `Sections:` 行后自动只计 always-read + 所引节 span。\n")
    print("## BUDGETS（散文预算，机器权威；Phase 5 前 lint 仅 WARN）\n")
    print("| SKILL | 行上限 | 字符上限 | 现值（行/字符） | 状态 |")
    print("|---|---:|---:|---|---|")
    by_name = {r["agent"]: r for r in rows}
    for name, b in BUDGETS.items():
        r = by_name.get(name)
        if not r:
            continue
        over = r["prose_lines"] > b["lines"] or r["prose_chars"] > b["chars"]
        print("| %s | %d | %s | %d / %s | %s |" % (
            name, b["lines"], format(b["chars"], ","),
            r["prose_lines"], format(r["prose_chars"], ","),
            "超（Phase 5 迁移目标）" if over else "达标",
        ))
    print("\n结构预算：frontmatter description ≤%d 字符（硬）；Step-0 探针块 ≤%d 行、"
          "boot 节 ≤%d 行（Phase 5 前 WARN-only）。" % (
              FRONTMATTER_DESC_MAX_CHARS, PROBE_MAX_LINES, BOOT_MAX_LINES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
