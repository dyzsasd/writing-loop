// `production evidence register`（DESIGN §4.7 的 rights / moderation / license evidence）：
// 内容嗅探 mediaType、写入 workspace CAS、按 kind 输出可直接填入批次文档的片段，重复登记幂等。
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionMain } from "../src/production.ts";
import { parseAssetRef } from "../src/production-domain.ts";
import { parseProductionLicenseEvidence } from "../src/production-intent.ts";
import { readProductionCasObject } from "../src/production-cas.ts";
import {
  MAX_PRODUCTION_EVIDENCE_BYTES,
  registerProductionEvidence,
  sniffProductionEvidenceMediaType,
} from "../src/production-evidence.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

async function capture(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...values: unknown[]) => { out.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { err.push(values.map(String).join(" ")); };
  try { return { code: await productionMain(args, cwd), out: out.join("\n"), err: err.join("\n") }; }
  finally { console.log = oldLog; console.error = oldError; }
}

const errorOf = (fn: () => unknown): string => {
  try { fn(); return ""; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
};

const WORKSPACE_ID = `ws_${"a".repeat(32)}`;
const AT = "2026-09-02T00:00:00.000Z";
const EXAMPLE_RUNTIME = JSON.parse(readFileSync(
  join(import.meta.dirname, "..", "examples", "production", "representative-h3", "production-runtime.json"),
  "utf8",
)) as Record<string, any>;

const RIGHTS_JSON = JSON.stringify({
  version: 1, subject: "《官居一品》改编开发", clearedBy: "legal:lead", territories: ["SG"],
}, null, 2) + "\n";
const LICENSE_TEXT = "MiniMax H3 Community License\n\nExhibit A. 第 12 条：向公开环境传播机器生成内容须清楚披露。\n";
const MODERATION_PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n", "latin1"),
  Buffer.from([0x00, 0x01, 0x02]),
  Buffer.from("\n%%EOF\n", "latin1"),
]);

type Fixture = { root: string; configFile: string; files: Record<string, string> };

function makeWorkspace(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-evidence-")));
  const data = join(root, ".writing-loop");
  mkdirSync(join(data, "demo"), { recursive: true });
  writeFileSync(join(data, "workspace.json"), JSON.stringify({ version: 1, id: WORKSPACE_ID }, null, 2) + "\n");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title: "玉京旧事", repoPath: "repo", enabled: true } },
  }, null, 2) + "\n");
  mkdirSync(join(root, "repo"), { recursive: true });

  const configFile = join(root, "production-runtime.json");
  writeFileSync(configFile, JSON.stringify({
    ...EXAMPLE_RUNTIME,
    workspaceId: WORKSPACE_ID,
    projects: [{
      version: 1,
      project: "demo",
      enabled: true,
      backendInstanceIds: ["gateway-h3-fl2va"],
      deploymentTerritories: ["CN"],
      availableBudgetMicros: 50_000_000,
      allowedProcessingRegions: ["CN"],
      licenseCompliance: { annualRevenueUsdBelow: 1_000_000, attributionSurfaces: ["片尾字幕"] },
      usesOutputToImproveModels: false,
    }],
    workflows: [{ ...EXAMPLE_RUNTIME.workflows[0], projects: ["demo"] }],
  }, null, 2) + "\n");
  chmodSync(configFile, 0o600);

  const files: Record<string, string> = {
    rights: join(root, "rights.json"),
    license: join(root, "LICENSE"),
    moderation: join(root, "moderation.pdf"),
  };
  writeFileSync(files.rights!, RIGHTS_JSON);
  writeFileSync(files.license!, LICENSE_TEXT);
  writeFileSync(files.moderation!, MODERATION_PDF);
  return { root, configFile, files };
}

// —— mediaType 嗅探：按内容，不按扩展名 ——
{
  ok(sniffProductionEvidenceMediaType(Buffer.from(RIGHTS_JSON, "utf8")) === "application/json",
    "以 { 开头且能解析的 UTF-8 判为 application/json");
  ok(sniffProductionEvidenceMediaType(Buffer.from("[1,2,3]\n", "utf8")) === "application/json",
    "以 [ 开头的 JSON 数组同样判为 application/json");
  ok(sniffProductionEvidenceMediaType(Buffer.from(LICENSE_TEXT, "utf8")) === "text/plain",
    "无控制字符的 UTF-8 正文判为 text/plain");
  ok(sniffProductionEvidenceMediaType(MODERATION_PDF) === "application/pdf",
    "%PDF- 魔数判为 application/pdf（内容含 NUL 也不影响）");
  ok(sniffProductionEvidenceMediaType(Buffer.from("20260902\n", "utf8")) === "text/plain",
    "只写了一个数字的文件是文本证据，不判为 JSON 标量");
  ok(sniffProductionEvidenceMediaType(Buffer.from("{ 未闭合\n", "utf8")) === "text/plain",
    "以 { 开头但解析失败时回落到 text/plain 判据");
  ok(sniffProductionEvidenceMediaType(Buffer.from("\ufeff" + RIGHTS_JSON, "utf8")) === "text/plain",
    "带 BOM 的 JSON 解析失败，回落为 text/plain 而不是被拒");
  ok(sniffProductionEvidenceMediaType(Buffer.from("[Exhibit A] 第 12 条：披露义务。\n", "utf8")) === "text/plain",
    "以 [Exhibit A] 开头的许可证正文判为 text/plain");
  ok(sniffProductionEvidenceMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) === null,
    "PNG 等非 UTF-8 二进制判不出类型");
  ok(sniffProductionEvidenceMediaType(Buffer.from("a\u0007b", "utf8")) === null,
    "含控制字符的 UTF-8 判不出类型");
}

// —— 三种 kind 的片段与幂等 ——
{
  const fixture = makeWorkspace();
  try {
    const rights = registerProductionEvidence({
      root: fixture.root, project: "demo", kind: "rights", file: fixture.files.rights!,
      casAuthority: "wl-sg",
    });
    ok(rights.mediaType === "application/json" && rights.byteLength === Buffer.byteLength(RIGHTS_JSON)
      && /^[a-f0-9]{64}$/.test(rights.sha256) && rights.casObjectCreated === true
      && rights.asset.uri === `cas://wl-sg/sha256/${rights.sha256}`,
    `rights 登记出 AssetRef 与 sha256（实得 ${JSON.stringify(rights.asset)}）`);
    ok(Object.keys(rights.fragment).join(",") === "evidence"
      && parseAssetRef(rights.fragment.evidence).sha256 === rights.sha256,
    "rights 片段只给 evidence（地域与有效期是人工事实，命令不代填）");
    ok(readProductionCasObject(fixture.root, "demo", rights.sha256)?.toString("utf8") === RIGHTS_JSON,
      "证据字节逐字进入 workspace CAS，文件名即内容 sha256");

    const again = registerProductionEvidence({
      root: fixture.root, project: "demo", kind: "rights", file: fixture.files.rights!,
      casAuthority: "wl-sg",
    });
    ok(again.casObjectCreated === false && again.sha256 === rights.sha256
      && JSON.stringify(again.asset) === JSON.stringify(rights.asset),
    "重复登记同一份文件是幂等的（内容寻址，不重复写对象）");

    const moderation = registerProductionEvidence({
      root: fixture.root, project: "demo", kind: "moderation", file: fixture.files.moderation!,
      casAuthority: "wl-sg", moderation: { status: "passed", reviewedAt: AT },
    });
    ok(moderation.mediaType === "application/pdf"
      && Object.keys(moderation.fragment).sort().join(",") === "evidence,reviewedAt,status"
      && moderation.fragment.status === "passed" && moderation.fragment.reviewedAt === AT,
    `moderation 片段原样带入 --status / --reviewed-at（实得 ${JSON.stringify(moderation.fragment)}）`);
    const notReviewed = registerProductionEvidence({
      root: fixture.root, project: "demo", kind: "moderation", file: fixture.files.moderation!,
      casAuthority: "wl-sg", moderation: { status: "not-reviewed", reviewedAt: "2026-09-01T08:00:00.000Z" },
    });
    ok(notReviewed.fragment.status === "not-reviewed"
      && notReviewed.fragment.reviewedAt === "2026-09-01T08:00:00.000Z",
    "moderation 结论不被代填为 passed，也不取登记时刻");
    ok(errorOf(() => registerProductionEvidence({
      root: fixture.root, project: "demo", kind: "moderation", file: fixture.files.moderation!,
      casAuthority: "wl-sg",
    })).includes("必须同时给出 --status 与 --reviewed-at"), "moderation 缺 status/reviewedAt 时被拒");
    ok(errorOf(() => registerProductionEvidence({
      root: fixture.root, project: "demo", kind: "moderation", file: fixture.files.moderation!,
      casAuthority: "wl-sg", moderation: { status: "approved", reviewedAt: AT },
    })).includes("--status 必须是"), "moderation status 只接受 intent 侧词表的取值");
    ok(errorOf(() => registerProductionEvidence({
      root: fixture.root, project: "demo", kind: "moderation", file: fixture.files.moderation!,
      casAuthority: "wl-sg", moderation: { status: "passed", reviewedAt: "2026-09-01 08:00:00" },
    })).includes("规范 UTC ISO-8601"), "moderation reviewedAt 必须是规范 UTC ISO");
    ok(errorOf(() => registerProductionEvidence({
      root: fixture.root, project: "demo", kind: "rights", file: fixture.files.rights!,
      casAuthority: "wl-sg", moderation: { status: "passed", reviewedAt: AT },
    })).includes("只属于 --kind moderation"), "非 moderation 的 kind 不接受 status/reviewedAt");

    const license = registerProductionEvidence({
      root: fixture.root, project: "demo", kind: "license", file: fixture.files.license!,
      casAuthority: "wl-sg",
    });
    ok(license.mediaType === "text/plain"
      && Object.keys(license.fragment).sort().join(",") === "evidence,licenseSha256"
      && license.fragment.licenseSha256 === license.sha256,
    `license 片段带 licenseSha256 与 evidence（实得 ${JSON.stringify(license.fragment)}）`);
    const parsed = parseProductionLicenseEvidence({
      version: 1, status: "verified", basis: "written-license", territories: ["SG"],
      issuedBy: "MiniMax (Nanonoble Pte. Ltd.)", issuedAt: AT, expiresAt: null, obligations: null,
      ...license.fragment,
    }, "fixture license");
    ok(parsed.licenseSha256 === license.sha256 && parsed.evidence?.sha256 === license.sha256,
      "license 片段补齐人工字段后能被 intent 的 license 解析器接受");

    ok(errorOf(() => registerProductionEvidence({
      root: fixture.root, project: "demo", kind: "license", file: join(fixture.root, "missing.txt"),
      casAuthority: "wl-sg",
    })).includes("文件不存在"), "登记不存在的文件被拒");

    const empty = join(fixture.root, "empty.txt");
    writeFileSync(empty, "");
    ok(errorOf(() => registerProductionEvidence({
      root: fixture.root, project: "demo", kind: "license", file: empty, casAuthority: "wl-sg",
    })).includes("空文件"), "空文件不是证据");

    const oversize = join(fixture.root, "oversize.txt");
    writeFileSync(oversize, Buffer.alloc(MAX_PRODUCTION_EVIDENCE_BYTES + 1, 0x61));
    ok(errorOf(() => registerProductionEvidence({
      root: fixture.root, project: "demo", kind: "license", file: oversize, casAuthority: "wl-sg",
    })).includes("安全上限"), "超过安全上限的证据被拒");

    const binary = join(fixture.root, "frame.png");
    writeFileSync(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    ok(errorOf(() => registerProductionEvidence({
      root: fixture.root, project: "demo", kind: "license", file: binary, casAuthority: "wl-sg",
    })).includes("不属于允许的证据形态"), "类型不在允许集合内的文件被拒，扩展名不参与判定");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}

// —— CLI 入口 ——
{
  const fixture = makeWorkspace();
  try {
    const registered = await capture([
      "evidence", "register", "--project", "demo", "--kind", "license",
      "--file", fixture.files.license!, "--config", fixture.configFile, "--json",
    ], fixture.root);
    ok(registered.code === 0, `production evidence register 退出 0（实得 ${registered.code}；${registered.err}）`);
    const payload = JSON.parse(registered.out) as Record<string, any>;
    ok(payload.kind === "license" && payload.mediaType === "text/plain"
      && payload.asset.uri === `cas://wl-sg/sha256/${payload.sha256}`
      && payload.fragment.licenseSha256 === payload.sha256,
    `CLI 输出 AssetRef、sha256 与可填入的片段（实得 ${registered.out.slice(0, 160)}）`);
    ok(readProductionCasObject(fixture.root, "demo", payload.sha256) !== null,
      "CLI 登记的证据确实落进 workspace CAS");

    const human = await capture([
      "evidence", "register", "--project", "demo", "--kind", "moderation",
      "--file", fixture.files.moderation!, "--config", fixture.configFile,
      "--status", "passed", "--reviewed-at", AT,
    ], fixture.root);
    ok(human.code === 0 && human.out.includes("application/pdf") && human.out.includes("cas=created")
      && human.out.includes("\"status\": \"passed\""),
    `非 --json 输出给出可直接粘贴的片段（实得 ${human.out.slice(0, 160)}）`);

    const badKind = await capture([
      "evidence", "register", "--project", "demo", "--kind", "contract",
      "--file", fixture.files.license!, "--config", fixture.configFile,
    ], fixture.root);
    ok(badKind.code === 2 && badKind.err.includes("--kind 只接受"), "未知 --kind 是用法错误");

    const noConfig = await capture([
      "evidence", "register", "--project", "demo", "--kind", "license", "--file", fixture.files.license!,
    ], fixture.root);
    ok(noConfig.code === 2 && noConfig.err.includes("CAS authority"),
      "缺 --config 时拒绝：CAS authority 只在 runtime config 的 localAssetSource");

    const badSub = await capture(["evidence", "list", "--project", "demo"], fixture.root);
    ok(badSub.code === 2 && badSub.err.includes("只支持 register"), "evidence 只有 register 子命令");

    const unknownProject = await capture([
      "evidence", "register", "--project", "nope", "--kind", "license",
      "--file", fixture.files.license!, "--config", fixture.configFile,
    ], fixture.root);
    ok(unknownProject.code === 1 && unknownProject.err.includes("没有项目"), "未登记项目被拒");

    const bareModeration = await capture([
      "evidence", "register", "--project", "demo", "--kind", "moderation",
      "--file", fixture.files.moderation!, "--config", fixture.configFile,
    ], fixture.root);
    ok(bareModeration.code === 2 && bareModeration.err.includes("必须同时提供 --status 与 --reviewed-at"),
      "CLI 的 --kind moderation 缺 --status / --reviewed-at 时是用法错误");
    const strayStatus = await capture([
      "evidence", "register", "--project", "demo", "--kind", "license",
      "--file", fixture.files.license!, "--config", fixture.configFile, "--status", "passed",
    ], fixture.root);
    ok(strayStatus.code === 2 && strayStatus.err.includes("只属于 --kind moderation"),
      "非 moderation 的 kind 带 --status 是用法错误");
    const badStatus = await capture([
      "evidence", "register", "--project", "demo", "--kind", "moderation",
      "--file", fixture.files.moderation!, "--config", fixture.configFile,
      "--status", "approved", "--reviewed-at", AT,
    ], fixture.root);
    ok(badStatus.code === 2 && badStatus.err.includes("--status 只接受"), "CLI 拒绝词表外的 --status");
    const badReviewedAt = await capture([
      "evidence", "register", "--project", "demo", "--kind", "moderation",
      "--file", fixture.files.moderation!, "--config", fixture.configFile,
      "--status", "passed", "--reviewed-at", "2026-09-01 08:00:00",
    ], fixture.root);
    ok(badReviewedAt.code === 1 && badReviewedAt.err.includes("规范 UTC ISO-8601"),
      "CLI 拒绝非规范 UTC ISO 的 --reviewed-at");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}

if (fails) {
  console.error(`${fails} 项失败`);
  process.exit(1);
}
