# Harness CLI support

[中文](HARNESS.zh-CN.md) · **English** · [Français](HARNESS.fr.md)

writing-loop has exactly three first-class Harness CLI IDs. They are accepted by
`scheduler.cli` and `writing-loop run --cli` and are covered by scheduler contract tests.

| Harness ID | Process shape | Prompt transport | Model handling |
| --- | --- | --- | --- |
| `claude` | `claude -p ...` | `slash` (default) or `inline` | Claude tier names and effort pass through |
| `codex` | `codex exec ...` | `slash` (default) or `inline` | `opus`/`sonnet` map to the current Codex tier; `max` maps to `xhigh` |
| `opencode` | `opencode run ...` | always `inline` | `provider/model` is passed with `-m`; otherwise OpenCode's default model is used |

```bash
writing-loop run --cli claude
writing-loop run --cli codex
writing-loop run --cli opencode
```

Resolution order is `--cli` > project `scheduler.cli` > workspace `scheduler.cli` >
the default `claude`. Any other `--cli` value is rejected before a child process starts.

## Provider boundary

The workspace `providers{}` registry is only used to route the `opencode` Harness. It renders
OpenAI-compatible endpoints into the workspace's `opencode.json`; credentials remain
environment-variable references. The config parser validates the registry for every lane,
but Claude Code and Codex do not use it for routing or authentication.

OpenCode runs the bundled agent skills as inline prompts because it has no writing-loop
slash-plugin transport. Its fire environment is hermetic by default, and the scheduler
injects the bounded `OPENCODE_PERMISSION` policy.

OpenCode receives the nine writers' room agent skills, not the attended `add-script` skill.
For OpenCode-only onboarding, create the project with Studio or the deterministic
`writing-loop project plan` and `writing-loop project create` commands first.

## Custom command escape hatch

`scheduler.agents.<name>.command` can replace one agent's rendered argv. This is a test and
operator escape hatch, not a fourth first-class Harness. A Gemini, Kimi, or other command
configured this way does not gain certified prompt transport, model mapping, authentication,
permissions, telemetry attribution, or portability guarantees. The scheduler still applies
the environment and telemetry semantics of the selected `scheduler.cli` lane; it does not
infer a new Harness identity from the override's executable.

Selecting `scheduler.cli: "codex"` chooses Codex as the writers' room Harness. It is separate
from the project's optional `codex.enabled` accelerator in conventions §24, which gates image
generation and advisory second-engine review. Either switch can be enabled without the other.

## Script writing versus video production

The three Harnesses above run the writers' room: outline, bible, episode writing, review,
evaluation, and market work. The board, repository, and scheduler control plane remain local;
a Harness may still contact its configured text-model provider. These stages do **not**
require ComfyUI, MiniMax H3, or a GPU server.

H3 is a separate, shot-level audio/video execution backend. Start the GPU production path
only after script and shot revisions are frozen and production intents enter the render queue.
Studio, board inspection, script generation, and script review remain usable while the GPU
fleet is scaled to zero.

## Readiness check

Before selecting a Harness, verify its executable and then run the scheduler dry-run:

```bash
command -v claude    # or codex / opencode
writing-loop doctor
writing-loop run --cli claude --dry-run
```

`command -v` only proves that a launcher exists. A real fire still requires a working vendor
binary, valid authentication, and (for remote providers) network access.
