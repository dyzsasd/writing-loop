# Harness CLI 支持

**中文** · [English](HARNESS.md) · [Français](HARNESS.fr.md)

writing-loop 只有三个一级 Harness CLI ID。它们可用于 `scheduler.cli` 和
`writing-loop run --cli`，并由调度器契约测试覆盖。

| Harness ID | 进程形态 | Prompt 传输 | 模型处理 |
| --- | --- | --- | --- |
| `claude` | `claude -p ...` | `slash`（默认）或 `inline` | Claude 档位和 effort 原样传递 |
| `codex` | `codex exec ...` | `slash`（默认）或 `inline` | `opus`/`sonnet` 映射到当前 Codex 档位；`max` 映射为 `xhigh` |
| `opencode` | `opencode run ...` | 恒为 `inline` | `provider/model` 通过 `-m` 传递；否则使用 OpenCode 默认模型 |

```bash
writing-loop run --cli claude
writing-loop run --cli codex
writing-loop run --cli opencode
```

解析优先级为：`--cli` > 项目 `scheduler.cli` > workspace `scheduler.cli` > 默认
`claude`。其他 `--cli` 值会在启动子进程前被拒绝。

## Provider 边界

workspace 的 `providers{}` 注册表只用于路由 `opencode` Harness。它把
OpenAI-compatible 端点渲染进 workspace 的 `opencode.json`，凭据仍只引用环境变量。
配置解析器会对所有车道校验该注册表，但 Claude Code 和 Codex 不用它路由或认证。

OpenCode 没有 writing-loop slash plugin 传输，所以调度器把 agent skill 以内联 prompt
运行；fire 默认使用隔离配置目录，并注入有界的 `OPENCODE_PERMISSION` 策略。

OpenCode 收到的是编剧房的 9 个 agent skill，不包括 attended `add-script` skill。只使用
OpenCode 时，请先通过 Studio 或确定性的 `writing-loop project plan` / `writing-loop project
create` 命令立项。

## 自定义命令逃生口

`scheduler.agents.<name>.command` 可以替换单个 agent 的 argv。它是测试/操作者逃生口，
不是第四种一级 Harness。通过这里接入 Gemini、Kimi 或其他命令，不会自动获得经过认证的
prompt 传输、模型映射、认证、权限、遥测归因或可移植性保证。scheduler 仍应用所选
`scheduler.cli` 车道的环境与遥测语义，不会从 override 的 executable 推断新 Harness 身份。

`scheduler.cli: "codex"` 表示选择 Codex 作为编剧房 Harness；它与 conventions §24 的项目级
`codex.enabled` 可选加速器互相独立。后者只控制图像生成和 advisory 第二引擎审查，两者可以
分别启用。

## 剧本写作与视频制作的边界

上述三个 Harness 负责编剧房：大纲、bible、分集正文、审读、评估和市场工作。看板、仓库
与 scheduler 控制面留在本地；Harness 仍可能访问已配置的文本模型 provider。这些阶段
**不需要** ComfyUI、MiniMax H3 或 GPU 服务器。

H3 是独立的镜头级音视频执行后端。只有剧本/镜头 revision 已冻结、production intent
进入渲染队列后，才启动 GPU 制作链。GPU fleet 缩到 0 时，Studio、看板、剧本生成和审读
仍然正常可用。

## 就绪检查

选择 Harness 前，先验证可执行文件，再运行调度器 dry-run：

```bash
command -v claude    # 或 codex / opencode
writing-loop doctor
writing-loop run --cli claude --dry-run
```

`command -v` 只能证明 launcher 路径存在；真实 fire 还需要完整的 vendor binary、有效认证，
远程 provider 还需要网络可达。
