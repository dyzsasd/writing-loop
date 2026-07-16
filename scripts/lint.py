#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""writing-loop 治理文件 lint（stdlib-only）。

检查（范围：skills/*/SKILL.md + references/*.md）：
  1. §-引用解析（硬）：裸 §N[a][-流程][.M] 一律按 conventions 锚点集解析；
     带文件名限定（如「script-format §4」）按该文件自己的标题解析；
     script-format.md 文内的裸 § 先按其自身编号节解析（唯一例外，见 conventions 锚点语法节）；
     点号锚点 §N.M 解析到该节直属编号清单第 M 条——命中多条独立清单 = 歧义 = 错误
     （§21a 四条流程必须用 §21a-design 等流程子锚点）。
     R-引用（craft-rules 命名空间）：RN/RNa 解析到 craft-rules 标题，RN.M 解析到其
     `**RN.M**` 规则定义。
     fenced code 与行内反引号内不扫（示例/模板文字不是引用）。
  2. frontmatter description ≤400 字符（硬，Phase 0 已落地）。
  3. 散文预算（BUDGETS 表，行+字符，机器权威在 scripts/context-bill.py）——
     Phase 5 迁移前 WARN-only；--strict 才算失败。
  4. 新鲜度（硬）：对本插件自有文件的字面尺寸声明（如「~51KB conventions」类）须在实测
     ±10% 内——防自述漂移（Phase 0 已把 conventions 的字面数字非字面化，此检查保住它）。
  5. 结构（硬）：每 agent SKILL 具备四段骨架（## 0 boot / Step-0 探针 / Guardrails /
     收尾报告；add-script 无探针）；探针块 ≤12 行与 boot 节 ≤35 行为 WARN-only（--strict 升级）。
  6. 被引用的 templates/*.md 必须存在（硬）。

退出码：有硬错误 ⇒ 1；--strict 下 WARN 也计为失败。
"""

import argparse
import importlib.util
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_spec = importlib.util.spec_from_file_location(
    "context_bill", os.path.join(ROOT, "scripts", "context-bill.py"))
cb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cb)

REF_FILES = ["conventions", "script-format", "craft-rules",
             "evaluation-rubric", "config-schema", "codex-integration"]

SEC_REF = re.compile(r"§(\d{1,2})([a-z])?(?:-([a-z]+))?(?:\.(\d{1,2}))?")
R_REF = re.compile(r"\bR(\d{1,2})([a-z])?(?:\.(\d{1,2}))?\b")
# 名字与 § 之间只允许空格/「的」——「craft-rules（§17）」这类列举后括号内的 § 仍是
# conventions 命名空间（见 codex-integration §4 的实例），不算文件限定。
QUALIFIER = re.compile(
    r"(conventions|script-format|craft-rules|config-schema|codex-integration|"
    r"evaluation-rubric)(?:\.md)?[ 的]*$")

errors, warnings = [], []


def err(path, line, msg):
    errors.append("%s:%d: %s" % (os.path.relpath(path, ROOT), line, msg))


def warn(path, line, msg):
    warnings.append("%s:%d: %s" % (os.path.relpath(path, ROOT), line, msg))


def blank_code(line):
    """把行内反引号 code span 的内容置空格（保住偏移），示例文字不算引用。"""
    out, parts = [], line.split("`")
    for i, seg in enumerate(parts):
        out.append(seg if i % 2 == 0 else " " * len(seg))
    return "`".join(out) if len(parts) > 1 else line


def scan_lines(text):
    """[(行号1基, 已去 code 的行)]，跳过 fenced code block。"""
    out, fenced = [], False
    for i, ln in enumerate(text.splitlines(), 1):
        if ln.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if not fenced:
            out.append((i, blank_code(ln)))
    return out


# ---------------------------------------------------------------------------
# 锚点/清单模型
# ---------------------------------------------------------------------------

def numbered_lists(lines, start, end, headings_at):
    """span 内的独立编号清单集：[{item 号,…}, …]。标题或编号断档即开新清单。"""
    lists, cur, prev = [], set(), 0
    for i in range(start, end):
        if i in headings_at:
            if cur:
                lists.append(cur)
            cur, prev = set(), 0
            continue
        m = re.match(r"^(\d{1,2})\.\s", lines[i])
        if m:
            n = int(m.group(1))
            if cur and n != prev + 1:
                lists.append(cur)
                cur = set()
            cur.add(n)
            prev = n
    if cur:
        lists.append(cur)
    return lists


class Namespace:
    """一个文件的可引用锚点集 + 点号清单解析。"""

    def __init__(self, text, anchor_re):
        self.lines = []
        fenced = False
        for ln in text.splitlines():
            if ln.lstrip().startswith("```"):
                fenced = not fenced
                self.lines.append("")
                continue
            self.lines.append("" if fenced else ln)
        self.spans, self.headings_at = {}, set()
        heads = []
        for i, ln in enumerate(self.lines):
            m = re.match(r"^(#{1,4})\s+(.*)$", ln)
            if m:
                heads.append((i, len(m.group(1)), m.group(2).strip()))
                self.headings_at.add(i)
        for idx, (i, lv, title) in enumerate(heads):
            end = len(self.lines)
            for j, jlv, _t in heads[idx + 1:]:
                if jlv <= lv:
                    end = j
                    break
            m = anchor_re.match(title)
            if m:
                key = "".join(g for g in m.groups() if g)
                self.spans[key] = (i, end)

    def resolve(self, key, item):
        """'ok' | 'no-anchor' | 'no-item' | 'ambiguous'"""
        if key not in self.spans:
            return "no-anchor"
        if item is None:
            return "ok"
        s, e = self.spans[key]
        hits = [ls for ls in numbered_lists(self.lines, s + 1, e, self.headings_at)
                if item in ls]
        if not hits:
            return "no-item"
        if len(hits) > 1:
            return "ambiguous"
        return "ok"


def build_namespaces():
    conv = Namespace(cb.read_text(os.path.join(ROOT, "references", "conventions.md")),
                     re.compile(r"^§(\d{1,2})([a-z])?(-[a-z]+)?\."))
    sf = Namespace(cb.read_text(os.path.join(ROOT, "references", "script-format.md")),
                   re.compile(r"^(\d{1,2})\."))
    cr_text = cb.read_text(os.path.join(ROOT, "references", "craft-rules.md"))
    r_heads = set()
    for m in re.finditer(r"^## R(\d{1,2})([a-z])?\b", cr_text, re.M):
        r_heads.add(m.group(1) + (m.group(2) or ""))
    r_dotted = set(m.group(1) for m in re.finditer(r"\*\*R(\d{1,2}\.\d{1,2})\*\*", cr_text))
    return conv, sf, r_heads, r_dotted


# ---------------------------------------------------------------------------
# 检查 1：引用解析
# ---------------------------------------------------------------------------

def check_refs(path, text, conv, sf, r_heads, r_dotted):
    base = os.path.basename(path)
    for lineno, ln in scan_lines(text):
        for m in SEC_REF.finditer(ln):
            num, letter, flow, item = m.groups()
            key = num + (letter or "") + (("-" + flow) if flow else "")
            item = int(item) if item else None
            qual = QUALIFIER.search(ln[: m.start()])
            ns_name = qual.group(1) if qual else None
            if ns_name == "script-format" or (ns_name is None and base == "script-format.md"):
                ns, label = sf, "script-format"
                if letter or flow:
                    err(path, lineno, "script-format 无字母/流程锚点：§%s" % m.group(0)[1:])
                    continue
                res = ns.resolve(num, item)
                if res == "no-anchor" and ns_name is None:
                    ns, label = conv, "conventions"   # 文内裸 § 回落 conventions
                    res = ns.resolve(key, item)
            elif ns_name in ("craft-rules", "config-schema", "codex-integration",
                             "evaluation-rubric"):
                err(path, lineno, "「%s §…」不是合法引用形（该文件无 § 命名空间）：%s"
                    % (ns_name, m.group(0)))
                continue
            else:
                ns, label = conv, "conventions"
                res = ns.resolve(key, item)
            if res == "no-anchor":
                err(path, lineno, "§引用无法解析（%s 无此锚点）：%s" % (label, m.group(0)))
            elif res == "no-item":
                err(path, lineno, "点号锚点无对应清单条目：%s（%s §%s 直属编号清单无第 %d 条）"
                    % (m.group(0), label, key, item))
            elif res == "ambiguous":
                err(path, lineno, "点号锚点歧义：%s 命中 %s §%s 内多条独立编号清单"
                    "——用流程子锚点（如 §21a-design.%d）" % (m.group(0), label, key, item))
        for m in R_REF.finditer(ln):
            num, letter, item = m.groups()
            if item:
                if num + "." + item not in r_dotted:
                    err(path, lineno, "R 引用无法解析：R%s.%s 不在 craft-rules 的 **RN.M** 定义集"
                        % (num, item))
            elif num + (letter or "") not in r_heads:
                err(path, lineno, "R 引用无法解析：R%s%s 不是 craft-rules 标题"
                    % (num, letter or ""))


# ---------------------------------------------------------------------------
# 检查 2：frontmatter description
# ---------------------------------------------------------------------------

def parse_description(fm):
    lines = fm.splitlines()
    for i, ln in enumerate(lines):
        m = re.match(r"^description:\s*(.*)$", ln)
        if not m:
            continue
        val = m.group(1).strip()
        if val in (">", ">-", "|", "|-"):
            parts = []
            for nxt in lines[i + 1:]:
                if nxt.strip() and not nxt.startswith((" ", "\t")):
                    break
                if nxt.strip():
                    parts.append(nxt.strip())
            return " ".join(parts)
        return val
    return ""


def check_frontmatter(path, fm):
    desc = parse_description(fm)
    n = len(desc)
    if n == 0:
        err(path, 1, "frontmatter 缺 description")
    elif n > cb.FRONTMATTER_DESC_MAX_CHARS:
        err(path, 1, "frontmatter description %d 字符 > 上限 %d"
            % (n, cb.FRONTMATTER_DESC_MAX_CHARS))


# ---------------------------------------------------------------------------
# 检查 3/5：预算 + 结构
# ---------------------------------------------------------------------------

def check_budget_structure(path, name, body):
    p_lines, p_chars = cb.prose_metrics(body)
    b = cb.BUDGETS.get(name)
    if b is None:
        err(path, 1, "SKILL 无 BUDGETS 条目（预算表机器权威在 scripts/context-bill.py）")
    else:
        if p_lines > b["lines"]:
            warn(path, 1, "散文 %d 行 > 预算 %d（Phase 5 迁移目标）" % (p_lines, b["lines"]))
        if p_chars > b["chars"]:
            warn(path, 1, "散文 %d 字符 > 预算 %d（Phase 5 迁移目标）" % (p_chars, b["chars"]))

    lines = body.splitlines()
    fm_off = cb.read_text(path).count("\n") - len(lines)  # frontmatter 行数偏移
    def has_h2(pat):
        return any(re.match(r"^## ", ln) and re.search(pat, ln) for ln in lines)

    boot_lines, boot_start = cb.boot_section(body)
    if not boot_lines:
        err(path, 1, "缺 boot 节（## 0 …）")
        return
    if not has_h2(r"Guardrails|护栏"):
        err(path, 1, "缺 Guardrails 节")
    if not (has_h2(r"收尾报告") or has_h2(r"(?i)close with a report|report")):
        err(path, 1, "缺收尾报告节")

    pb = cb.probe_block(boot_lines)
    if name in cb.OPERATOR_SKILLS:
        return  # add-script：operator-present 一次性 skill，无探针
    if pb is None:
        err(path, fm_off + boot_start + 1, "缺 Step-0 廉价车道探针块（### Step 0 …探针）")
        return
    probe_n = sum(1 for ln in boot_lines[pb[0] + 1: pb[1]] if ln.strip())
    if probe_n > cb.PROBE_MAX_LINES:
        warn(path, fm_off + boot_start + pb[0] + 1,
             "Step-0 探针块 %d 非空行 > 预算 %d（Phase 5 谓词-only 迁移目标）"
             % (probe_n, cb.PROBE_MAX_LINES))
    boot_n = sum(1 for ln in boot_lines if ln.strip())
    if boot_n > cb.BOOT_MAX_LINES:
        warn(path, fm_off + boot_start + 1,
             "boot 节 %d 非空行 > 预算 %d（Phase 5 迁移目标）" % (boot_n, cb.BOOT_MAX_LINES))


# ---------------------------------------------------------------------------
# 检查 4：字面尺寸声明新鲜度
# ---------------------------------------------------------------------------

SIZE_CLAIM = re.compile(r"[~≈约]?\s*(\d[\d,]*(?:\.\d+)?)\s*(KB|MB|字节|bytes)", re.I)
FILE_TOKEN = re.compile(r"(conventions|script-format|craft-rules|evaluation-rubric|"
                        r"config-schema|SKILL)")


def check_freshness(path, text):
    for lineno, ln in scan_lines(text):
        sizes = list(SIZE_CLAIM.finditer(ln))
        if not sizes:
            continue
        tokens = set(FILE_TOKEN.findall(ln))
        if not tokens:
            continue
        for sm in sizes:
            val = float(sm.group(1).replace(",", ""))
            unit = sm.group(2).upper()
            claimed = val * {"KB": 1024, "MB": 1024 * 1024, "字节": 1, "BYTES": 1}[unit]
            ok = False
            for tok in tokens:
                cand = (path if tok == "SKILL"
                        else os.path.join(ROOT, "references", tok + ".md"))
                if os.path.isfile(cand):
                    actual = os.path.getsize(cand)
                    if abs(actual - claimed) <= 0.10 * actual:
                        ok = True
            if not ok:
                err(path, lineno, "字面尺寸声明疑似漂移：「%s」不在所提文件实测 ±10%% 内"
                    "（自述性数字应非字面化，如「整份 conventions」）" % sm.group(0).strip())


# ---------------------------------------------------------------------------
# 检查 6：templates 存在
# ---------------------------------------------------------------------------

def check_templates(path, text):
    for lineno, ln in [(i, l) for i, l in enumerate(text.splitlines(), 1)]:
        for m in re.finditer(r"templates/([A-Za-z0-9_-]+\.md)", ln):
            if not os.path.isfile(os.path.join(ROOT, "templates", m.group(1))):
                err(path, lineno, "引用的模板不存在：templates/%s" % m.group(1))


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true",
                    help="预算/探针/boot 长度 WARN 升级为失败（Phase 5 迁移后默认开启）")
    args = ap.parse_args()

    conv, sf, r_heads, r_dotted = build_namespaces()

    skill_paths = sorted(
        os.path.join(ROOT, "skills", d, "SKILL.md")
        for d in os.listdir(os.path.join(ROOT, "skills"))
        if os.path.isfile(os.path.join(ROOT, "skills", d, "SKILL.md")))
    ref_paths = sorted(
        os.path.join(ROOT, "references", f)
        for f in os.listdir(os.path.join(ROOT, "references")) if f.endswith(".md"))

    for path in skill_paths + ref_paths:
        text = cb.read_text(path)
        check_refs(path, text, conv, sf, r_heads, r_dotted)
        check_freshness(path, text)
        check_templates(path, text)
        if path in skill_paths:
            fm, body = cb.split_frontmatter(text)
            name = os.path.basename(os.path.dirname(path))
            check_frontmatter(path, fm)
            check_budget_structure(path, name, body)

    for e in errors:
        print("ERROR %s" % e)
    for w in warnings:
        print("WARN  %s" % w)
    print("lint: %d error(s), %d warning(s)%s" % (
        len(errors), len(warnings), " [--strict]" if args.strict else ""))
    if errors or (args.strict and warnings):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
