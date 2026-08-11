// Executable documentation contract for the three first-class writers' room Harnesses.
import { readFileSync } from "node:fs";
import { join } from "node:path";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

const root = join(import.meta.dirname, "..", "..");
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");
const harnessDocs = [
  read("docs", "HARNESS.md"),
  read("docs", "HARNESS.zh-CN.md"),
  read("docs", "HARNESS.fr.md"),
];
const storyDesigner = read("skills", "story-designer-agent", "SKILL.md");
const showrunner = read("skills", "showrunner-agent", "SKILL.md");
const evaluator = read("skills", "evaluator-agent", "SKILL.md");
const episodeWriter = read("skills", "episode-writer-agent", "SKILL.md");
const reviewer = read("skills", "reviewer-agent", "SKILL.md");
const reflect = read("skills", "reflect-agent", "SKILL.md");
const scriptDoctor = read("skills", "script-doctor-agent", "SKILL.md");

for (const [index, doc] of harnessDocs.entries()) {
  ok(doc.includes("writing-loop run --cli claude")
    && doc.includes("writing-loop run --cli codex")
    && doc.includes("writing-loop run --cli opencode"),
  `Harness 文档 ${index + 1} 固化三种一级 CLI 命令`);
  ok(doc.includes("ComfyUI") && /MiniMax\s+H3/.test(doc) && doc.includes("GPU"),
    `Harness 文档 ${index + 1} 明示剧本模型与 H3/GPU 制作层分离`);
}

const canonical = harnessDocs[0];
ok(canonical.includes("exactly three first-class Harness CLI IDs")
  && canonical.includes("Any other `--cli` value is rejected"),
"canonical Harness 文档不把 command override 冒充第四种一级 CLI");
ok(canonical.includes("`providers{}` registry is only used to route the `opencode` Harness")
  && canonical.includes("OpenAI-compatible endpoints"),
"canonical Harness 文档锁定 OpenCode-only provider registry 边界");
ok(canonical.includes("`scheduler.agents.<name>.command`")
  && canonical.includes("not a fourth first-class Harness")
  && /does not\s+infer a new Harness identity/.test(canonical),
"canonical Harness 文档把逐 agent command 定位为逃生口");
ok(canonical.includes("`scheduler.cli: \"codex\"`")
  && canonical.includes("`codex.enabled` accelerator")
  && read("references", "conventions.md").includes("两套独立开关"),
"Harness 选择与 Codex 可选加速器不被混为同一开关");

ok(read("README.md").includes("docs/HARNESS.md")
  && read("README.zh-CN.md").includes("docs/HARNESS.zh-CN.md")
  && read("README.fr.md").includes("docs/HARNESS.fr.md"),
"三语根 README 均链接对应 Harness 合同");
ok(read("hub", "README.md").includes("github.com/dyzsasd/writing-loop/blob/main/docs/HARNESS.md"),
"npm README 提供安装包外 canonical Harness 文档链接");
ok(read("references", "config-schema.md").includes("Harness 契约只有 `claude | codex | opencode` 三个一级 ID")
  && read("references", "config-schema.md").includes("ComfyUI/H3/GPU 是独立的镜头制作执行层"),
"配置 schema 同步一级 Harness 集合与 GPU 边界");

ok(storyDesigner.includes("SOURCE-ANALYSIS 模式（writing-loop 内生拆书）")
  && storyDesigner.includes("writing-loop source checkpoint")
  && storyDesigner.includes("writing-loop source finalize")
  && storyDesigner.includes("不得调用 `story-long-analyze`")
  && showrunner.includes("A0 · source-analysis ⇒ 原著拆解门")
  && showrunner.includes("control.phase=`review-ready`")
  && showrunner.includes("outline 继续 Backlog"),
"改编拆书由 writing-loop source-analysis/checkpoint/showrunner 门闭环，明确拒绝外部 skill 旁路");
ok(storyDesigner.includes("story/outline.v1.json")
  && storyDesigner.includes("writing-loop story validate")
  && showrunner.includes("--stage full")
  && evaluator.includes("story validate --project <project> --stage full --json")
  && read("references", "story-design-schema.md").includes("skipped` 表示阶段未到")
  && read("references", "config-schema.md").includes("结构化故事伴随文件与质量门"),
"Story Designer 写严格 companion，Showrunner/Evaluator 独立重验，阶段未到不伪绿");
ok(storyDesigner.includes("story/assets.v1.json") && storyDesigner.includes("chronologyIndex")
  && episodeWriter.includes("story context --project <project> --ticket <ID> --agent episode-writer")
  && reviewer.includes("story context --project <project> --ticket <ID> --agent")
  && showrunner.includes("story context --project <project> --ticket <ID> --agent showrunner")
  && evaluator.includes("story context --project <project> --ticket <ID> --agent")
  && read("references", "story-assets-schema.md").includes("观众揭示顺序")
  && read("references", "story-assets-schema.md").includes("绝不回退成全文扫 bible/ledger"),
"剧情资产、双轨时间线与 ticket-scoped Context Pack 是写作/审读/评估共同硬契约");

const guides = [read("docs", "GUIDE.md"), read("docs", "GUIDE.zh-CN.md"), read("docs", "GUIDE.fr.md")];
const automaticSourcePhrases = [
  "There is no second manual registration step in normal onboarding",
  "正常立项没有第二次手工登记",
  "Le parcours normal n'a pas de seconde inscription manuelle",
];
for (const [index, guide] of guides.entries()) {
  ok(guide.includes("OpenCode") && guide.includes("add-script")
    && guide.includes("project plan") && guide.includes("project create"),
  `指南 ${index + 1} 明示 OpenCode-only 的非 slash 立项入口`);
  ok(guide.includes(automaticSourcePhrases[index]!) && guide.includes("source-analysis")
    && guide.includes("source status --project my-drama") && !guide.includes("my-drama/source/novel.txt"),
  `指南 ${index + 1} 把原著交给立项后自动 source-analysis，而非要求第二次手工登记或外部拆书`);
  ok(guide.includes("story/outline.v1.json") && guide.includes("story/assets.v1.json")
    && guide.includes("Context Pack") && guide.includes("skeleton") && guide.includes("beats") && guide.includes("full"),
  `指南 ${index + 1} 同步结构伴随文件与三阶段质量门`);
}
ok(read("skills", "add-script", "SKILL.md").includes("不是正常立项步骤")
  && read("skills", "add-script", "SKILL.md").includes("同一次确认会在项目发布后自动登记原著")
  && read("references", "config-schema.md").includes("改编原著 source intake 与拆书门")
  && read("references", "config-schema.md").includes("正常立项之后直接启动 scheduler")
  && read("hub", "README.md").includes("no second operator command is part of the normal path"),
"add-script、schema 与 npm README 同步一键原著登记/内生拆书职责边界");
const design = read("docs", "DESIGN.md");
ok(design.includes("三 Harness 可移植性（Claude/Codex/OpenCode）")
  && !design.includes("§25 第二 CLI 可移植性"),
"设计文档不再把 Harness 合同限制为第二 CLI");
ok(reflect.includes("writing-loop system proposal file --input")
  && reflect.includes("`[reflect-proposal]` 项目 Ticket")
  && reflect.includes("**严禁**")
  && scriptDoctor.includes("episodes/.gitkeep")
  && scriptDoctor.includes("不能先付模型 boot 再 no-op"),
"Reflect 把框架提案送往系统收件箱，Script Doctor 在无分集时模型启动前机械门控");
ok(read("references", "conventions.md").includes(".writing-loop/system/proposals/WLSYS-")
  && read("references", "config-schema.md").includes("writing-loop system proposal list")
  && read("hub", "README.md").includes("/system")
  && guides.every((guide) => guide.includes("writing-loop system proposal list")),
"规范、schema、Studio 与三语指南固定 workspace 系统收件箱，不把机制改进伪装为剧集 Ticket");

console.log(fails === 0 ? "\nHARNESS_CONTRACT_DOCS_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
