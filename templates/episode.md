---
ep: {N}
arc: arc-{NN}
beat-card: arcs/arc-{NN}-{slug}.md#ep-{NNN}
beat-card-hash: {sha256 前 12 位——arc 文件在写作时刻的内容哈希；doctor 比对即知「所依据的节拍单已被改过」}
hook-type: {H1-H7|H0}
words: {自检时填实际字数}
foreshadow-ops: [{plant|refresh|payoff} F-{xx}]
keystone: {标记或删除本行}
mode: {direct-write 重写票时标注，否则删除本行}
written-by: {agent} (run {token})
model: {model}/{effort}
rules-version: craft-rules@{ver} script-format@{ver}
---

第{N}集{（钩子式标题）}{（一卡）}

{N}-1 {地点} {日/夜} {内/外}
人物：{角色甲、角色乙、群演*N}
▲ {一行动作 = 一个镜头；生产标注内联：【特写】【特效】【音效】【BGM】【字幕：】}
{角色甲}（{情绪/动作}）：{台词，≤25 字/句，≤3 行}
{角色乙}（OS）：{内心独白}

{N}-2 {…}

▲ 【画面定格】{尾钩画面——必须与 frontmatter hook-type 一致}

<!-- 交付义务（conventions §15）：
     1. 单 commit 原子性：本文件 + ledgers/ 全部更新必须在同一个 commit；工单转态在 commit 之后。
     2. 账本 delta 声明：在工单评论逐条列出本集产生的状态/关系/信息差/数字锚点变化，
        每条附正文行号引用——reviewer 逐条核对（漏项 = MISSING = fail）。
     3. production.md：本集场景/具名角色必须 ∈ 注册表；打斗/群戏/特效计数累加。
     4. 自检清单显式写入工单评论（机器项 + 三分类自证 + 金句候选）。 -->
