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

const guides = [read("docs", "GUIDE.md"), read("docs", "GUIDE.zh-CN.md"), read("docs", "GUIDE.fr.md")];
for (const [index, guide] of guides.entries()) {
  ok(guide.includes("OpenCode") && guide.includes("add-script")
    && guide.includes("project plan") && guide.includes("project create"),
  `指南 ${index + 1} 明示 OpenCode-only 的非 slash 立项入口`);
}
const design = read("docs", "DESIGN.md");
ok(design.includes("三 Harness 可移植性（Claude/Codex/OpenCode）")
  && !design.includes("§25 第二 CLI 可移植性"),
"设计文档不再把 Harness 合同限制为第二 CLI");

console.log(fails === 0 ? "\nHARNESS_CONTRACT_DOCS_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
