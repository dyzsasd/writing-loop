# Codex 集成 — 命令与机械细节（how-to）

> conventions §24 是契约；本文件是执行细节。仅当 `codex.enabled:true`（§11）且 `codex`
> CLI 在 PATH 上才生效；否则一切照常（优雅降级）。Codex **绝不碰看板**——只碰文件与只读审查。

## 0. 前置检查（每次用前）

```bash
command -v codex            # 不在 PATH ⇒ 视作 codex.enabled:false，继续，不报错
codex features list | grep image_generation   # 用图像能力前确认工具在
```

不可用 = §12a 外部前提事实，不是 block。记一行「codex 不可用，跳过」继续本 fire。

## 1. 通用调用形（所有 Codex 调用都遵守）

```bash
codex exec \
  -C "<剧本 repo 绝对路径>" \
  --sandbox <read-only | workspace-write> \
  --ask-for-approval never \
  [--model "<codex.model>"] \
  [其余按能力] \
  "<prompt>" < /dev/null
```

- `codex exec`：同步，跑完返回（**不**用后台 `--background` + 轮询——那是给盯屏操作者的）。
- `< /dev/null`：**必须**——否则 `codex exec` 等 stdin，挂住本 fire。
- `-C`：进到本剧本 repo（Codex 的工作目录 = 生成/读取的根）。
- `--ask-for-approval never`：绝不用会暂停等人的形式。
- `--model` / `effort`：仅在 `codex.model` / `codex.effort` 设了才带（否则用 Codex 默认）。
- 审查用 `--sandbox read-only`；图像生成用 `--sandbox workspace-write`（`exec` 默认只读，
  会**静默不写盘**）。

## 2. 图像生成（§24a，`codex.imageGen`）— story-designer 用

**用途**：写完 `bible/characters.md` / `world.md` 后，把视觉 token 变成概念图，落到
`codex.assetsDir`（默认 `assets/concept/`），作为下游制作/生图管线的定位参考。

**load-bearing 机制**：`image_generation` 工具**总是**把 PNG 存到
`~/.codex/generated_images/<session-id>/ig_<hash>.png`——它**不认** prompt 里指定的
文件名/尺寸，且 Codex 自报的「saved to …」是编造的。所以必须**定位真实文件再拷出**：

```bash
# 1) 生成（workspace-write 必需；prompt 用 characters.md 的视觉 token）
codex exec -C "<repo>" --sandbox workspace-write --ask-for-approval never \
  "Use the image_generation tool to render a character concept art:
   <粘贴该角色的视觉 token：发型/服装/形态/明星参考>. After generating, copy the produced
   PNG to ./assets/concept/<角色key>.png in the current repo." < /dev/null

# 2) 兜底定位（若 Codex 没自己 cp）：取最新 session 目录里的 PNG 拷出
latest=$(ls -td ~/.codex/generated_images/*/ | head -1)
img=$(ls -t "$latest"ig_*.png 2>/dev/null | head -1)
[ -n "$img" ] && cp "$img" "<repo>/assets/concept/<角色key>.png"
```

**门禁**：生成的静态图是 §15 交付义务**豁免**（正文/账本照常；图是附带资产，交付评论注明
路径即可）。生成失败**绝不**阻塞剧本推进——优雅降级，记一行继续。

（可扩展：evaluator 一卡门可同法为切片清单生成**切片视觉/分镜关键帧**；v1 先只做
story-designer 的人物/场景概念图。）

## 3. 独立对抗性审查（§24b，`codex.review`，只读）— reviewer / script-doctor 用

**用途**：在 agent 自己的三分类/审计**之外**，加一道异构第二引擎复审，抓同族模型盲点。

```bash
codex exec -C "<repo>" --sandbox read-only --ask-for-approval never \
  "Adversarially review episode <ep-NNN> against its beat card <arcs/arc-NN.md#ep-NNN> and
   the ledgers. Classify each finding severity Critical/High/Medium/Low. Focus on: 承接断裂,
   账本事实冲突, 伏笔到期未回收, 人设/战力矛盾, 节奏拖沓. Output findings only, no edits." < /dev/null
```

**裁决**（reviewer / doctor 侧）：
- **Critical / High** ⇒ 按自己发现同等对待：阻断，本轮修；修不动走 fail 三级路由（§21a）。
- **Medium / Low** ⇒ 非阻断，记录即可。
- **Codex 与作者相左 = 信号不是否决**：可越过认为的误报继续，但必须在交接评论说明。
- 只读，`dry-run` 下也可跑并打印；**绝不**据此自动改正文（改由 agent 走正常门禁 §21a）。

## 4. 安全与边界（对齐 conventions §2/§16/§17）

- Codex 只在**本剧本 repo**（`-C`）内动，绝不碰 `.writing-loop/` 看板、绝不碰他剧。
- 秘密留在环境（§16）；prompt 里绝不粘 PII / 未授权原著大段（改编版权边界，§16）。
- Codex **绝不**改 conventions / SKILL / craft-rules（§17）——它是产物/审查工具，不是治理者。
- 一切 Codex 输出都是 agent 判断的**输入**，最终落盘、转态、验收仍是 agent 经 backend 完成。
