#!/usr/bin/env node
// `writing-loop` —— 面向操作者的统一 CLI（npm 包 @dyzsasd/writing-loop 的 bin）。
// 与 dev-loop hub/src/cli.ts 同构的薄分派器：每个子命令是 src/ 下一个自带 main 的入口模块，
// 本文件只查表 + spawnSync 转发，剩余参数原样交给入口自己的解析器。零依赖：
// 源码态由 Node >=23.6 直接 type-strip 运行 .ts；发布态跑编译出的 dist/*.js。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // hub/src（源码态）| dist（发布态）
// 以本文件自己的扩展名解析兄弟入口：`.ts` = 源码零构建直跑；`.js` = 发布产物
//（node 拒绝 type-strip node_modules 下的 .ts，发布包只带编译 JS）。
const EXT = fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts";
const [cmd, ...rest] = process.argv.slice(2);

// 子命令 → [入口基名（无扩展名）, ...前置参数]。
// 注：release-version 故意不入表——它改的是源码仓库的 manifests（.claude-plugin/* 等），
// 发布包里根本没有这些文件；仓库内用 `node hub/src/release-version.ts <semver>`（仿 dev-loop）。
const ROUTES: Record<string, [string, ...string[]]> = {
  init:                    ["init"],                  // 铺 workspace 骨架（.writing-loop/ + 空 config.json）
  run:                     ["run"],                   // 起内建调度器 wl-run（原生 TS，src/scheduler.ts）
  status:                  ["status"],                // 只读板摘要（state 计数 / 停靠票 / 写作前沿 / 陈旧锁 / 末 5 fire）
  snapshot:                ["snapshot"],              // 多项目稳定 JSON 投影（UI/外部编排共用）
  studio:                  ["studio"],                // loopback-only 本地编剧工作台
  ui:                      ["studio"],                // studio 的短别名
  project:                 ["project"],               // 项目清单与安全启停
  source:                  ["source"],                // 原著登记、不可变分块与拆书票
  story:                   ["story"],                 // 结构化故事伴随文件的确定性质量门
  script:                  ["script"],                // 单集正文的确定性预提交 lint（script-format 机器半边）
  system:                  ["system"],                // workspace 级框架改进收件箱（不进项目板）
  production:              ["production"],            // 远程制片的本地权威状态与零网络 enqueue
  visual:                  ["visual"],                // 视觉制作清单的人工裁决（候选图批准轨道）
  workspace:               ["workspace-registry-cli"], // 本机 workspace ID 索引（不参与根解析）
  doctor:                  ["doctor"],                // 只读体检；末行 WRITING_LOOP_DOCTOR_OK / _FAILED + NEXT:
  "sync-opencode":         ["sync-opencode"],          // providers 注册表 → opencode.json（create-or-merge）
  fires:                   ["fires"],                 // fires.jsonl 遥测尾巴 + 按 agent 聚合成功率
  "install-claude-plugin": ["install-claude-plugin"], // 注册本地 npm-source marketplace 给 Claude Code
  bundle:                  ["bundle"],                // workspace 打包/导入/查看——跨机器 MOVE，不是同步
};

const version = (): string => {
  try {
    return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
};

const usage = (): void => {
  console.log(`writing-loop ${version()} — 自治短剧编剧团队（writers' room）CLI

用法: writing-loop <command> [args]

  init [--dir D]              铺 workspace 骨架（.writing-loop/ + 空 config.json）；已有则列项目清单
  run [--project K] [--once] [--dry-run] [--plan N] [--agents a,b] [--for S]
      [--cli claude|codex|opencode]
                              起内建调度器 wl-run（包内原生 TS，零依赖）——写 repo 角色
                              全局单飞、keystone 自动升档、fires.jsonl 遥测；Ctrl-C 优雅停
  status [--project K] [--json]
                              只读板摘要：各 state 计数、In Review / In Progress 明细、
                              needs-* 停靠票、写作前沿（episodes/ep-*.md 最大集号）、
                              陈旧锁扫描、fires.jsonl 末 5 行
  snapshot [--project K] [--compact]
                              输出 workspace / 剧本项目的稳定 JSON 投影（包含暂停项目）
  studio [--host 127.0.0.1|localhost|::1] [--port 8791] [--workspace ID] [--single]
                              启动仅限本机访问的编剧工作台；registry 有多个登记项时显示
                              创作总台，--workspace 选默认工作区，--single 保留单工作区 URL
  project list [--json]       列出全部剧本项目（包含暂停项目）
  project enable|disable K    原子更新项目启停开关，并保留 config 未知字段
  project plan --input request.json
                              零写入预览立项计划并返回确认指纹
  project create --input request.json --confirm PLAN_ID [--json]
                              以匹配的确认指纹原子发布 repo、运行态板与 config
  project verify KEY [--json] 独立核验立项后的 repo、首票与运行态布局
  source plan --project K --input FILE
                              零写入预览原著指纹、分块与处理授权
  source register --project K --input FILE --confirm PLAN_ID [--json]
                              本地登记原著与改编设计，并创建 writing-loop 拆书票
  source status --project K [--json]
                              查看全书扫描、本季取材及 source-analysis 进度
  source survey-start|survey-checkpoint|survey-finalize …
                              Source Analyst 的全书扫描恢复/checkpoint 门
  story status --project K [--json]
                              查看结构化故事、派生资产与质量门（只读；通常由 Studio 使用）
  story validate --project K [--stage skeleton|beats|full] [--json]
                              独立复核 story/outline.v1.json + story/assets.v1.json
  story context --project K --ticket ID --agent A [--max-bytes N] [--json]
                              按工单、角色与集数生成结构化有界 Context Pack；不读取原著正文
  system proposal list [--json]
  system proposal show WLSYS-ID [--json]
  system proposal file --input FILE [--json]
  system proposal migrate-ticket --project K --ticket ID ...
                              管理 workspace 级 Writing Loop 改进建议；永不进入剧集项目看板
  script lint --project K --episode N [--file PATH] [--ticket ID] [--json]
                              单集正文预提交 lint：场景头/场数/调度单/情绪前缀/集号自指/frontmatter/
                              注册表闭合/台词句数；0 error 才可转 In Review（退出码 0/1/2）
  production status [--project K] [--json]
                              查看不可变镜头 revision、远程任务、QC 与成本事实；包含暂停项目
  production enqueue --plan --project K --input FILE [--json]
                              零写入计划并返回确认指纹
  production enqueue --project K --input FILE --confirm PLAN_ID [--json]
                              以匹配指纹持久化 immutable intent + task + dispatch；零远端网络
  production plan-shots --plan --project K --input FILE --config RUNTIME
      [--from-script EP [--scene N]…] [--json]
                              零写入批次审批文档：读 runtime config 声明的只读 execution profile
                              快照做估算，输出每镜估算与后端理由、承接链波次、退化与校验汇总、
                              samplePolicy 与 batchPlanId
  production plan-shots --confirm BATCH_PLAN_ID --project K --input FILE --config RUNTIME
      [--from-script EP [--scene N]…] [--json]
                              以匹配指纹逐镜把 ShotRequest 写入 workspace CAS 并 enqueue；
                              phase: bulk 先检查 samplePolicy 指名的样片 task 均为 approved
  production qc --approve|--reject --project K --task ID --by WHO [--note TEXT] [--json]
                              人工 QC 裁决：写 approved/rejected 事件并绑定审批前的 qc revision；
                              非 qc-pending 的 task 一律拒绝
  production handoff --project K --input FILE [--contract v1|v2] [--json]
                              输出仅含人工 approved take 的 Studio 交接清单；缺省 scripted-drama
                              契约 v2（takes 带 shotRequest / execution / cost / assetRoles /
                              gates / license），--contract v1 输出旧四流水线契约；不连接远端
  production handoff --project K --input FILE --export-dir DIR --config RUNTIME [--json]
                              另写 handoff.json（规范 JSON 字节）、handoff.digest 与全部资产
                              （<sha256>.<ext>）：cas:// 优先读本机 workspace CAS，其余经 gateway
                              的 assets GET 路由取回并逐文件校验 sha256 与字节长度
  visual approve-candidate --project K --candidate ID --by WHO [--reject] [--json]
                              候选图批准轨道：更新 visual/production.v1.json 的
                              status/reviewedBy/reviewedAt；只允许 keyframe-review 阶段
  workspace list [--json]     列出本机 workspace ID 索引（含 missing/corrupt 状态）
  workspace add [DIR] [--label L]
                              创建/复用稳定 ID，并按 canonical root 注册
  workspace remove ID          只删本机索引指针，绝不删除 workspace
  doctor                      只读体检：node/workspace/config/各项目/调度 CLI 引擎；
                              暖警告不失败、结构性问题才 FAIL；末行 DOCTOR_OK/FAILED + NEXT:
  sync-opencode [--dir D]     把 config.json 顶层 providers 注册表同步进 opencode.json
                              （create-or-merge；providers 为空则 no-op；绝不碰全局配置）
  fires [--project K] [--last N] [--json]
                              fires.jsonl 遥测尾巴（默认末 20 行）+ 按 agent 聚合成功率
  bundle export --out FILE.tar.gz [--include-logs]
                              打包整个 workspace（剧本 repo 完整历史、运行态板、资产库、原著、
                              workspace 身份）；调度器运行中或 repo 有未提交改动时拒绝
  bundle import FILE.tar.gz --dir NEW_ROOT [--label L]
                              落进空目录：逐文件校验 SHA-256、clone 剧本 repo、写 registry、
                              项目全部置为暂停态——之后 doctor → project enable → run
  bundle inspect FILE.tar.gz [--json]
                              只读打印清单，不解包
  install-claude-plugin [--version V] [--dry-run]
                              写本地 npm-source marketplace，让 Claude Code 从 npm 装
                              writing-loop 插件（版本默认钉住本 CLI 自身）
  version | help

板/账本等运行时状态都在 <workspace>/.writing-loop/ 下（workspace 根 = 从 CWD 向上首个含
.writing-loop/ 的目录；env WRITING_LOOP_WORKSPACE 可显式指定，坏值硬错不降级）。
立项 interview 在 Claude Code 里跑 /writing-loop:add-script。
文档: https://github.com/dyzsasd/writing-loop（docs/GUIDE*.md, references/config-schema.md）`);
};

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { usage(); process.exit(0); }
if (cmd === "version" || cmd === "--version" || cmd === "-v") { console.log(version()); process.exit(0); }

const route = ROUTES[cmd];
if (!route) {
  console.error(`writing-loop: 未知命令 '${cmd}'\n`);
  usage();
  process.exit(2);
}

// Ctrl-C 时不抢先死：终端把 SIGINT 发给整个前台进程组（含 wl-run），这里装个 no-op 监听，
// 等子进程自己收尾（run 的优雅停由 wl-run 做）后仍能转发它的真实退出码。
process.on("SIGINT", () => { /* 等子进程收尾 */ });

const [entryBase, ...prefix] = route;
const r = spawnSync(process.execPath, [join(here, entryBase + EXT), ...prefix, ...rest], { stdio: "inherit" });
process.exit(r.status ?? 1);
