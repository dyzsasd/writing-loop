// provider-routing 自测 —— dev-loop 1.3.0「任意模型 provider 经 opencode」的移植测试面
// （照抄 dev-loop test/provider-routing.ts 的覆盖分组，适配 writing-loop 单 workspace 模型：
// providers 挂 workspace 顶层 config.json，无 team 包装）。node 直跑 .ts、自断言、非零退出
// 即败——不引入新框架，助手/临时文件手法照抄 test/scheduler-engines.ts 与 test/scheduler.ts。
// 覆盖分组：
//   1. 纯函数：opencodeProviderPrefix / providerOf / providerAuthGap
//   2. 校验（parseProviders）：合法 entry 通过 + 逐条反例
//   3. 渲染（renderProviderEntry / renderOpencodeProviders）
//   4. opencode.json 同步（syncOpencodeConfig / opencodeSyncDrift）：真实临时目录
//   5. 调度器 opencode 车道：dry-run note、真实 launch 拦截/放行、ledger 字段、claude 车道零泄漏
//   6. doctor W09/W10
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  opencodeProviderPrefix, parseProviders, providerAuthGap, providerOf, WlExit,
  type ProviderEntry,
} from "../src/scheduler.ts";
import {
  opencodeSyncDrift, renderOpencodeProviders, renderProviderEntry, syncOpencodeConfig,
} from "../src/opencode-sync.ts";
import type { WlConfig } from "../src/workspace.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runEntry = join(hubRoot, "src", "run.ts");
const doctorEntry = join(hubRoot, "src", "doctor.ts");
const firesEntry = join(hubRoot, "src", "fires.ts");

const AGENTS = ["showrunner", "story-designer", "episode-writer", "reviewer", "evaluator",
  "sweep", "script-doctor", "market-watch", "reflect"];

let npass = 0, nfail = 0;
function check(desc: string, cond: boolean, extra = ""): void {
  if (cond) { npass++; console.log(`PASS ${desc}`); }
  else { nfail++; console.log(`FAIL ${desc}${extra ? `（${extra}）` : ""}`); }
}

const tmpDir = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

// ---------------------------------------------------------------------------
// 1. 纯函数：opencodeProviderPrefix / providerOf / providerAuthGap
// ---------------------------------------------------------------------------
function testPureHelpers(): void {
  check("opencodeProviderPrefix：含 / 的 model 取斜杠前段",
    opencodeProviderPrefix("openrouter/anthropic/claude-x") === "openrouter");
  check("opencodeProviderPrefix：Claude 档位名（无 /）⇒ null", opencodeProviderPrefix("opus") === null);
  check("opencodeProviderPrefix：undefined ⇒ null", opencodeProviderPrefix(undefined) === null);

  check("providerOf：claude 车道恒 anthropic", providerOf("claude", "opus") === "anthropic");
  check("providerOf：codex 车道恒 openai", providerOf("codex", "gpt-5.5") === "openai");
  check("providerOf：opencode + provider/model 形 ⇒ 取前缀", providerOf("opencode", "testprov/m1") === "testprov");
  check("providerOf：opencode + Claude 档位名（无 /）⇒ null（不虚构归因）", providerOf("opencode", "opus") === null);

  const providers: Record<string, ProviderEntry> = {
    testprov: {
      kind: "openai-compatible", baseUrl: "https://x.example/v1",
      authTokenEnv: "WL_TEST_PURE_AUTH", models: ["m1"],
    },
  };
  delete process.env.WL_TEST_PURE_AUTH;
  check("providerAuthGap：非 opencode 车道 ⇒ 恒 null（不拦截）",
    providerAuthGap(providers, "claude", "testprov/m1") === null);
  check("providerAuthGap：无 provider 前缀 ⇒ null", providerAuthGap(providers, "opencode", "opus") === null);
  check("providerAuthGap：前缀未命中注册表 ⇒ null（内建 provider，不校验）",
    providerAuthGap(providers, "opencode", "builtin/m1") === null);
  check("providerAuthGap：命中且认证未设置 ⇒ 返回 {prefix, authTokenEnv, reason:unset}",
    JSON.stringify(providerAuthGap(providers, "opencode", "testprov/m1"))
    === JSON.stringify({ prefix: "testprov", authTokenEnv: "WL_TEST_PURE_AUTH", reason: "unset" }));
  process.env.WL_TEST_PURE_AUTH = "";
  check("providerAuthGap：空串同判不可解析（`export KEY=` 手滑形）⇒ reason:empty",
    providerAuthGap(providers, "opencode", "testprov/m1")?.reason === "empty");
  process.env.WL_TEST_PURE_AUTH = "x";
  check("providerAuthGap：认证可解析（非空）⇒ null", providerAuthGap(providers, "opencode", "testprov/m1") === null);
  delete process.env.WL_TEST_PURE_AUTH;
}

// ---------------------------------------------------------------------------
// 2. 校验（parseProviders）
// ---------------------------------------------------------------------------
function testValidation(): void {
  const okEntry: ProviderEntry = {
    kind: "openai-compatible", baseUrl: "https://api.synthetic.new/v1",
    authTokenEnv: "SYNTHETIC_API_KEY", models: ["m1", "m2"],
  };
  const cfgWith = (providers: unknown): WlConfig => ({ providers } as unknown as WlConfig);
  const dies = (cfg: WlConfig, needle?: string): boolean => {
    try { parseProviders(cfg); return false; }
    catch (e) { return e instanceof WlExit && (!needle || e.message.includes(needle)); }
  };

  const parsed = parseProviders(cfgWith({ synthetic: okEntry }));
  check("校验：合法 entry 通过", parsed.synthetic?.baseUrl === okEntry.baseUrl && parsed.synthetic?.models.length === 2);
  check("校验：providers 缺省 ⇒ 空注册表", Object.keys(parseProviders({})).length === 0);

  check("校验：数组形式的 providers 拒绝", dies(cfgWith([okEntry])));
  check("校验：providers 本身非对象（字符串）拒绝", dies(cfgWith("nope")));
  check("校验：大写 id 拒绝", dies(cfgWith({ Synthetic: okEntry }), "不合法"));
  check("校验：kind:anthropic 拒绝", dies(cfgWith({ x: { ...okEntry, kind: "anthropic" } }), "openai-compatible"));
  check("校验：非 http(s) baseUrl 拒绝", dies(cfgWith({ x: { ...okEntry, baseUrl: "ftp://x" } }), "baseUrl"));
  check("校验：authTokenEnv 含 :// 拒绝",
    dies(cfgWith({ x: { ...okEntry, authTokenEnv: "https://evil" } }), "://"));
  check("校验：小写 authTokenEnv 拒绝",
    dies(cfgWith({ x: { ...okEntry, authTokenEnv: "synthetic_key" } }), "authTokenEnv"));
  check("校验：空 models 拒绝", dies(cfgWith({ x: { ...okEntry, models: [] } }), "models"));
  const noModels = { ...okEntry } as Partial<ProviderEntry>;
  delete noModels.models;
  check("校验：缺失 models 拒绝", dies(cfgWith({ x: noModels }), "models"));
  check("校验：未知键拒绝", dies(cfgWith({ x: { ...okEntry, bogus: 1 } }), "bogus"));
  check("校验：坏 effortMode 拒绝", dies(cfgWith({ x: { ...okEntry, effortMode: "bogus" } }), "effortMode"));
  // 保留键防线：extraOptions 渲染时展开在 baseURL/apiKey 之后，若不拒绝，extraOptions.apiKey
  // 可把字面密钥写进 opencode.json（「config 永不放密钥值」硬不变量的破口）
  check("校验：extraOptions 含 apiKey 拒绝（字面密钥破口）",
    dies(cfgWith({ x: { ...okEntry, extraOptions: { apiKey: "sk-live-oops" } } }), "apiKey"));
  check("校验：extraOptions 含 baseURL 拒绝",
    dies(cfgWith({ x: { ...okEntry, extraOptions: { baseURL: "https://elsewhere" } } }), "baseURL"));
  check("校验：extraOptions 含 baseUrl（混拼形）拒绝",
    dies(cfgWith({ x: { ...okEntry, extraOptions: { baseUrl: "https://elsewhere" } } }), "baseUrl"));

  const withStrip = parseProviders(cfgWith({
    x: { ...okEntry, effortMode: "strip", extraOptions: { headers: { a: "b" } } },
  }));
  check("校验：effortMode:strip + extraOptions 通过",
    withStrip.x?.effortMode === "strip" && (withStrip.x?.extraOptions as { headers?: { a?: string } })?.headers?.a === "b");
}

// ---------------------------------------------------------------------------
// 3. 渲染
// ---------------------------------------------------------------------------
function testRender(): void {
  const e: ProviderEntry = {
    kind: "openai-compatible", baseUrl: "https://api.synthetic.new/v1",
    authTokenEnv: "SYNTHETIC_API_KEY", models: ["m1", "m2"],
  };
  const r = renderProviderEntry("synthetic", e);
  check("渲染：npm 字段固定值", r.npm === "@ai-sdk/openai-compatible");
  check("渲染：name = id", r.name === "synthetic");
  const opts = r.options as Record<string, unknown>;
  check("渲染：options.baseURL 透传", opts.baseURL === e.baseUrl);
  check("渲染：options.apiKey 是 {env:VAR} 间接引用（绝非字面密钥）", opts.apiKey === "{env:SYNTHETIC_API_KEY}");
  check("渲染：models 渲成 id-only 对象（值为 {}）",
    JSON.stringify(r.models) === JSON.stringify({ m1: {}, m2: {} }));

  const withExtra = renderProviderEntry("x", { ...e, extraOptions: { headers: { a: "b" } } });
  const optsX = withExtra.options as Record<string, unknown>;
  check("渲染：extraOptions 展开进 options（不覆盖 baseURL/apiKey）",
    optsX.baseURL === e.baseUrl && optsX.apiKey === "{env:SYNTHETIC_API_KEY}"
    && JSON.stringify(optsX.headers) === JSON.stringify({ a: "b" }));

  const all = renderOpencodeProviders({ synthetic: e });
  check("渲染：renderOpencodeProviders 按 id 分发到 renderProviderEntry",
    JSON.stringify(all.synthetic) === JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// 4. opencode.json 同步（真实临时目录）
// ---------------------------------------------------------------------------
type OpencodeJsonFixture = {
  $schema?: string;
  theme?: string;
  provider?: Record<string, { models?: Record<string, unknown>; [k: string]: unknown }>;
};

function testSync(): void {
  const e: ProviderEntry = {
    kind: "openai-compatible", baseUrl: "https://api.synthetic.new/v1",
    authTokenEnv: "SYNTHETIC_API_KEY", models: ["m1"],
  };

  // 空注册表 ⇒ no-op，文件不动
  let ws = tmpDir("wl-opencode-sync-");
  let r = syncOpencodeConfig(ws, {});
  check("同步：空注册表 no-op（action=empty，不写文件）",
    r.action === "empty" && r.providers.length === 0 && !existsSync(join(ws, "opencode.json")));
  check("drift：空注册表 ⇒ 恒 null（无需同步）", opencodeSyncDrift(ws, {}) === null);
  rmSync(ws, { recursive: true, force: true });

  // 新建
  ws = tmpDir("wl-opencode-sync-");
  r = syncOpencodeConfig(ws, { synthetic: e });
  check("同步：文件不存在 ⇒ created", r.action === "created" && r.providers.join(",") === "synthetic");
  let onDisk = JSON.parse(readFileSync(join(ws, "opencode.json"), "utf8")) as OpencodeJsonFixture;
  check("同步：新建文件含 $schema + provider 渲染",
    onDisk.$schema === "https://opencode.ai/config.json"
    && JSON.stringify(onDisk.provider?.synthetic) === JSON.stringify(renderProviderEntry("synthetic", e)));

  // 重跑幂等 ⇒ unchanged
  r = syncOpencodeConfig(ws, { synthetic: e });
  check("同步：重跑幂等 ⇒ unchanged", r.action === "unchanged");
  check("drift：已同步 ⇒ null", opencodeSyncDrift(ws, { synthetic: e }) === null);
  rmSync(ws, { recursive: true, force: true });

  // 合并：手写 provider + 其余顶层键保留
  ws = tmpDir("wl-opencode-sync-");
  writeFileSync(join(ws, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json", theme: "dark",
    provider: { handwritten: { npm: "@ai-sdk/openai", name: "handwritten" } },
  }, null, 2));
  r = syncOpencodeConfig(ws, { synthetic: e });
  check("同步：新 id 合并进已有文件 ⇒ merged", r.action === "merged");
  onDisk = JSON.parse(readFileSync(join(ws, "opencode.json"), "utf8")) as OpencodeJsonFixture;
  check("同步：手写 provider 保留",
    JSON.stringify(onDisk.provider?.handwritten) === JSON.stringify({ npm: "@ai-sdk/openai", name: "handwritten" }));
  check("同步：其余顶层键保留（theme）", onDisk.theme === "dark");

  // 已存在条目原地更新，邻居不受影响
  const changed: ProviderEntry = { ...e, models: ["m1", "m2-new"] };
  r = syncOpencodeConfig(ws, { synthetic: changed });
  check("同步：已存在条目内容变化 ⇒ updated", r.action === "updated");
  onDisk = JSON.parse(readFileSync(join(ws, "opencode.json"), "utf8")) as OpencodeJsonFixture;
  check("同步：原地更新后 models 反映新值",
    JSON.stringify(Object.keys(onDisk.provider?.synthetic?.models ?? {})) === JSON.stringify(["m1", "m2-new"]));
  check("同步：更新时邻居 handwritten 不受影响",
    JSON.stringify(onDisk.provider?.handwritten) === JSON.stringify({ npm: "@ai-sdk/openai", name: "handwritten" }));
  rmSync(ws, { recursive: true, force: true });

  // 损坏 JSON：报错且文件不动；drift 同样报告
  ws = tmpDir("wl-opencode-sync-");
  writeFileSync(join(ws, "opencode.json"), "{ not json");
  let threw = false;
  try { syncOpencodeConfig(ws, { synthetic: e }); } catch { threw = true; }
  check("同步：损坏 JSON ⇒ 抛错", threw);
  check("同步：损坏 JSON ⇒ 文件原样不动", readFileSync(join(ws, "opencode.json"), "utf8") === "{ not json");
  check("drift：损坏文件 ⇒ 报告不是合法 JSON",
    (opencodeSyncDrift(ws, { synthetic: e }) ?? "").includes("不是合法 JSON"));
  rmSync(ws, { recursive: true, force: true });

  // 非对象 provider 块：报错不动
  ws = tmpDir("wl-opencode-sync-");
  writeFileSync(join(ws, "opencode.json"), JSON.stringify({ provider: "nope" }));
  threw = false;
  try { syncOpencodeConfig(ws, { synthetic: e }); } catch { threw = true; }
  check("同步：provider 块非对象 ⇒ 抛错不动",
    threw && (JSON.parse(readFileSync(join(ws, "opencode.json"), "utf8")) as { provider?: unknown }).provider === "nope");
  check("drift：provider 块非对象 ⇒ 报告无 provider 块",
    (opencodeSyncDrift(ws, { synthetic: e }) ?? "").includes("无 provider 块"));
  rmSync(ws, { recursive: true, force: true });

  // drift 对缺失文件报告「缺失」
  ws = tmpDir("wl-opencode-sync-");
  check("drift：文件缺失 ⇒ 报告缺失", (opencodeSyncDrift(ws, { synthetic: e }) ?? "").includes("缺失"));
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 5. 调度器 opencode 车道（假二进制，仿 test/scheduler-engines.ts 手法）
// ---------------------------------------------------------------------------
// 假 agent 把 spawn 事实 + 收到的 OPENCODE_CONFIG（第二行）一并写进 marker——后者用于断言
// fireEnv 的 git 边界修复（0.7.0 事故：workspace 根 opencode.json 对 cwd=git repo 的 fire 不可见）。
const FAKE_AGENT = `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], "spawned\\n" + (process.env.OPENCODE_CONFIG ?? "") + "\\n" + (process.env.XDG_CONFIG_HOME ?? ""));
console.log("done");
`;

const AUTH_VAR = "WL_TEST_PROVIDER_AUTH_TOKEN";
const GUARD_PROVIDERS = {
  testprov: {
    kind: "openai-compatible", baseUrl: "https://x.example/v1",
    authTokenEnv: AUTH_VAR, models: ["fake-model"],
  },
};

function makeGuardWs(agentModel: string): { ws: string; marker: string } {
  const ws = tmpDir("wl-provider-guard-");
  mkdirSync(join(ws, ".writing-loop"), { recursive: true });
  mkdirSync(join(ws, "t1"), { recursive: true });
  writeFileSync(join(ws, "fake_agent.mjs"), FAKE_AGENT);
  const marker = join(ws, "spawned.marker");
  const agents: Record<string, unknown> = {};
  for (const a of AGENTS) agents[a] = { enabled: false };
  agents.sweep = {
    enabled: true, intervalSeconds: 1, capSeconds: 30, staggerSeconds: 0, model: agentModel,
    command: [process.execPath, join(ws, "fake_agent.mjs"), marker],
  };
  writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
    version: 1, providers: GUARD_PROVIDERS,
    scheduler: { cli: "opencode", agents },
    projects: { t1: { title: "t", repoPath: "t1", enabled: true } },
  }, null, 2));
  return { ws, marker };
}

function runWl(ws: string, extraEnv: Record<string, string>, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.WRITING_LOOP_WORKSPACE;
  const r = spawnSync(process.execPath, [runEntry, ...args], { cwd: ws, encoding: "utf8", env, timeout: 60_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runTool(entry: string, ws: string, ...args: string[]): { code: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.WRITING_LOOP_WORKSPACE;
  const r = spawnSync(process.execPath, [entry, ...args], { cwd: ws, encoding: "utf8", env, timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function ledger(ws: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(ws, ".writing-loop", "t1", "fires.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch { return []; }
}

function testSchedulerGuard(): void {
  // dry-run：认证缺失只打 note、零 spawn、零写 ledger
  {
    const { ws } = makeGuardWs("testprov/fake-model");
    const r = runWl(ws, {}, "--project", "t1", "--dry-run");
    check("guard dry-run：rc=0", r.code === 0, `stderr=${r.stderr.slice(-300)}`);
    check("guard dry-run：note 提示认证不可解析",
      r.stdout.includes(`note: provider 'testprov' 认证环境变量 ${AUTH_VAR} 不可解析`)
      && r.stdout.includes("doctor 会体检此项"), `stdout=${r.stdout.slice(-600)}`);
    check("guard dry-run：零写 ledger（dry-run 本就不写账本）", ledger(ws).length === 0);
    rmSync(ws, { recursive: true, force: true });
  }

  // 真实 launch：认证缺失 ⇒ 不调用假二进制（零 token）、ledger 含 providerAuthMissing + provider
  {
    const { ws, marker } = makeGuardWs("testprov/fake-model");
    const r = runWl(ws, {}, "--project", "t1", "--once", "--agents", "sweep");
    check("guard launch：rc=0（guard 拦截不是调度器错误）", r.code === 0,
      `stdout=${r.stdout.slice(-500)} stderr=${r.stderr.slice(-300)}`);
    check("guard launch：假二进制从未被调用（marker 文件不存在，零 token）", !existsSync(marker));
    const rows = ledger(ws);
    const last = rows[rows.length - 1];
    check("guard launch：ledger 末行含 providerAuthMissing=<变量名>",
      last?.providerAuthMissing === AUTH_VAR, `last=${JSON.stringify(last)}`);
    check("guard launch：ledger 末行 provider 字段 = 注册表 id", last?.provider === "testprov");
    check("guard launch：ledger 末行同 spawnError 分支模式（exitCode null / noop false / timedOut false）",
      last?.exitCode === null && last?.noop === false && last?.timedOut === false);
    check("guard launch：FAIL 提示行含变量名与 doctor 指引",
      r.stdout.includes(`认证环境变量 ${AUTH_VAR} 不可解析`) && r.stdout.includes("doctor 会体检此项"));
    check("guard launch：FAIL 提示要求重启 wl-run（进程内 env 不刷新，export 后重试是无效指引）",
      r.stdout.includes("重启 wl-run"));
    // fires 遥测面必须能看见 guard 拦截（0.7.0 回归：provider/providerAuthMissing 只写不显）
    const fr = runTool(firesEntry, ws, "--project", "t1");
    check("fires：guard 拦截行 exit 列显 auth!、provider 列显 testprov",
      fr.out.includes("auth!") && fr.out.includes("testprov"), `out=${fr.out.slice(-500)}`);
    check("fires：按 agent 汇总单列认证拦截计数（不当谜团失败）", fr.out.includes("认证拦截 1"));
    rmSync(ws, { recursive: true, force: true });
  }

  // 洪泛回归（0.7.0 事故形：guard 拦截不推 due ⇒ 200ms tick 级重试，1 秒 ~5 行账本、且
  // 永不自愈）：连续模式 --for 1 全程账本行数必须是 interval 节律的 1-2 行，不是 tick 级的 ~5 行
  {
    const { ws, marker } = makeGuardWs("testprov/fake-model");
    const r = runWl(ws, {}, "--project", "t1", "--for", "1", "--agents", "sweep");
    const rows = ledger(ws);
    check("guard 洪泛回归：--for 1 连续模式下账本 ≤2 行（interval 节律，非 tick 级刷账）",
      rows.length >= 1 && rows.length <= 2, `rows=${rows.length}`);
    check("guard 洪泛回归：假二进制始终未被调用", !existsSync(marker));
    check("guard 洪泛回归：rc=0（guard 拦截不是调度器错误）", r.code === 0, `stderr=${r.stderr.slice(-300)}`);
    rmSync(ws, { recursive: true, force: true });
  }

  // 认证可解析：正常 spawn，ledger 的 provider 字段正确
  {
    const { ws, marker } = makeGuardWs("testprov/fake-model");
    const r = runWl(ws, { [AUTH_VAR]: "dummy-token" }, "--project", "t1", "--once", "--agents", "sweep");
    check("guard 放行：rc=0", r.code === 0, `stdout=${r.stdout.slice(-500)}`);
    check("guard 放行：假二进制被正常调用（marker 文件写入）", existsSync(marker));
    const rows = ledger(ws);
    const last = rows[rows.length - 1];
    check("guard 放行：ledger 无 providerAuthMissing 字段", last?.providerAuthMissing === undefined, `last=${JSON.stringify(last)}`);
    check("guard 放行：ledger 的 provider 字段 = testprov", last?.provider === "testprov");
    check("guard 放行：exitCode=0（假脚本正常退出）", last?.exitCode === 0, `last=${JSON.stringify(last)}`);
    check("guard 放行：spawn env 带 OPENCODE_CONFIG=workspace 根 opencode.json（git 边界修复——" +
      "opencode 项目级 config findUp 止步 cwd 的 git 根，不显式指路则同步产物对 fire 不可见）",
      readFileSync(marker, "utf8").split("\n")[1] === join(ws, "opencode.json"),
      `marker=${readFileSync(marker, "utf8")}`);
    check("guard 放行：spawn env 带 XDG_CONFIG_HOME=workspace 密闭目录（0.7.2 fire 密闭默认开——" +
      "全局 ~/.config/opencode 插件不进 fire）",
      readFileSync(marker, "utf8").split("\n")[2] === join(ws, ".writing-loop", "opencode-xdg"),
      `marker=${readFileSync(marker, "utf8")}`);
    check("guard 放行：密闭目录已创建", existsSync(join(ws, ".writing-loop", "opencode-xdg")));
    rmSync(ws, { recursive: true, force: true });
  }

  // opencodeHermetic:false 显式关 ⇒ XDG_CONFIG_HOME 不注入（沿用继承环境）
  {
    const { ws, marker } = makeGuardWs("testprov/fake-model");
    const cfgPath = join(ws, ".writing-loop", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { scheduler: Record<string, unknown> };
    cfg.scheduler.opencodeHermetic = false;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const env: NodeJS.ProcessEnv = { ...process.env, [AUTH_VAR]: "dummy-token" };
    delete env.XDG_CONFIG_HOME; // 干净基线：继承环境里无此变量 ⇒ 关密闭后 fire 也不该有
    delete env.WRITING_LOOP_WORKSPACE;
    const r = spawnSync(process.execPath, [runEntry, "--project", "t1", "--once", "--agents", "sweep"],
      { cwd: ws, encoding: "utf8", env, timeout: 60_000 });
    check("密闭关：rc=0", (r.status ?? 1) === 0, `stderr=${(r.stderr ?? "").slice(-300)}`);
    check("密闭关：spawn env 无 XDG_CONFIG_HOME（第三行空）",
      existsSync(marker) && readFileSync(marker, "utf8").split("\n")[2] === "",
      `marker=${existsSync(marker) ? readFileSync(marker, "utf8") : "<missing>"}`);
    rmSync(ws, { recursive: true, force: true });
  }

  // claude 车道：dry-run 渲染不受 provider guard 影响，无相关字段/文案泄漏
  {
    const ws = tmpDir("wl-provider-guard-");
    mkdirSync(join(ws, ".writing-loop"), { recursive: true });
    mkdirSync(join(ws, "t1"), { recursive: true });
    const agents: Record<string, unknown> = {};
    for (const a of AGENTS) agents[a] = { enabled: false };
    agents.showrunner = { enabled: true }; // 默认 claude 车道、Claude 档位名 opus（无 provider 前缀）
    writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
      version: 1, providers: GUARD_PROVIDERS, // 注册表非空，但本次车道是 claude
      scheduler: { agents },
      projects: { t1: { title: "t", repoPath: "t1", enabled: true } },
    }, null, 2));
    const r = runWl(ws, {}, "--project", "t1", "--dry-run");
    check("claude 车道零泄漏：无 note:/perm: 行", !r.stdout.includes("note:") && !r.stdout.includes("perm:"));
    check("claude 车道零泄漏：无 providerAuthMissing/testprov 字样",
      !r.stdout.includes("providerAuthMissing") && !r.stdout.includes("testprov"));
    check("claude 车道：dry-run 仍正常渲染 claude 命令", r.code === 0 && r.stdout.includes("cli=claude"));
    rmSync(ws, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5b. effortMode / OPENCODE_CONFIG 的 dry-run 渲染面（无 command 覆盖 ⇒ 走 fireArgv 的
//     opencode 分支；dry-run 零 spawn，不需要真 opencode 二进制）
// ---------------------------------------------------------------------------
function makeVariantWs(effortMode?: "passthrough" | "strip"): string {
  const ws = tmpDir("wl-provider-variant-");
  mkdirSync(join(ws, ".writing-loop"), { recursive: true });
  mkdirSync(join(ws, "t1"), { recursive: true });
  const agents: Record<string, unknown> = {};
  for (const a of AGENTS) agents[a] = { enabled: false };
  agents.sweep = { enabled: true, model: "testprov/fake-model" }; // effort 走 SPECS 默认（high，非空）
  writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    providers: { testprov: { ...GUARD_PROVIDERS.testprov, ...(effortMode ? { effortMode } : {}) } },
    scheduler: { cli: "opencode", agents },
    projects: { t1: { title: "t", repoPath: "t1", enabled: true } },
  }, null, 2));
  return ws;
}

function testVariantStrip(): void {
  // 默认（passthrough）：--variant 照传；注册表非空 ⇒ conf 行声明 OPENCODE_CONFIG 指路
  {
    const ws = makeVariantWs();
    const r = runWl(ws, { [AUTH_VAR]: "x" }, "--project", "t1", "--dry-run");
    check("variant：默认 passthrough ⇒ dry-run cmd 含 --variant",
      r.code === 0 && r.stdout.includes("--variant"), `stdout=${r.stdout.slice(-600)}`);
    check("variant：-m testprov/fake-model 照传", r.stdout.includes("-m testprov/fake-model"));
    check("OPENCODE_CONFIG：注册表非空 ⇒ dry-run conf 行指路 workspace 根",
      r.stdout.includes(`conf: OPENCODE_CONFIG=${join(ws, "opencode.json")}`), `stdout=${r.stdout.slice(-600)}`);
    check("fire 密闭：默认开 ⇒ dry-run xdg 行声明 XDG_CONFIG_HOME 密闭目录",
      r.stdout.includes(`xdg : XDG_CONFIG_HOME=${join(ws, ".writing-loop", "opencode-xdg")}`), `stdout=${r.stdout.slice(-600)}`);
    rmSync(ws, { recursive: true, force: true });
  }
  // strip：--variant 整个省略（0.7.0 死旋钮回归——校验/文档齐备但 fireArgv 从未消费）
  {
    const ws = makeVariantWs("strip");
    const r = runWl(ws, { [AUTH_VAR]: "x" }, "--project", "t1", "--dry-run");
    check("variant：effortMode:strip ⇒ dry-run cmd 无 --variant",
      r.code === 0 && !r.stdout.includes("--variant"), `stdout=${r.stdout.slice(-600)}`);
    check("variant：strip 不影响 -m 传参", r.stdout.includes("-m testprov/fake-model"));
    rmSync(ws, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 6. doctor W09/W10
// ---------------------------------------------------------------------------
function runDoctor(ws: string, extraEnv: Record<string, string> = {}): { code: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.WRITING_LOOP_WORKSPACE;
  const r = spawnSync(process.execPath, [doctorEntry], { cwd: ws, encoding: "utf8", env, timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function testDoctor(): void {
  const AUTH = "WL_TEST_DOCTOR_AUTH_TOKEN";
  const providers = { testprov: { kind: "openai-compatible", baseUrl: "https://x.example/v1", authTokenEnv: AUTH, models: ["m1"] } };

  // W09：认证不可解析 ⇒ warn；可解析 ⇒ ok（绝不打印变量的值）
  {
    const ws = tmpDir("wl-provider-doctor-");
    mkdirSync(join(ws, ".writing-loop"), { recursive: true });
    writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({ version: 1, providers, projects: {} }, null, 2));

    const missing = runDoctor(ws);
    check("doctor W09：认证不可解析 ⇒ WARN W09（点名变量名）",
      missing.out.includes("WARN W09") && missing.out.includes(AUTH) && missing.out.includes("testprov"),
      `out=${missing.out.slice(-600)}`);
    check("doctor：W09 warn 不导致整体 FAILED（暖警告不失败）", missing.code === 0);

    const empty = runDoctor(ws, { [AUTH]: "" });
    check("doctor W09：空串同判不可解析（`export KEY=` 手滑形，点名两态之别）",
      empty.out.includes("WARN W09") && empty.out.includes("已设置但为空串"), `out=${empty.out.slice(-600)}`);

    const present = runDoctor(ws, { [AUTH]: "dummy-secret-value" });
    check("doctor W09：认证可解析 ⇒ ok 且不再 WARN W09",
      present.out.includes(`provider 'testprov' 认证 ${AUTH} 可解析`) && !present.out.includes("WARN W09"),
      `out=${present.out.slice(-600)}`);
    check("doctor W09：绝不打印变量的值（哪怕认证可解析）", !present.out.includes("dummy-secret-value"));
    rmSync(ws, { recursive: true, force: true });
  }

  // W10：未同步 ⇒ warn 指引 sync-opencode；同步后 ⇒ ok
  {
    const ws = tmpDir("wl-provider-doctor-");
    mkdirSync(join(ws, ".writing-loop"), { recursive: true });
    writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({ version: 1, providers, projects: {} }, null, 2));

    const before = runDoctor(ws, { [AUTH]: "dummy-secret-value" });
    check("doctor W10：未同步 ⇒ WARN W10 指引 sync-opencode",
      before.out.includes("WARN W10") && before.out.includes("sync-opencode"), `out=${before.out.slice(-600)}`);

    syncOpencodeConfig(ws, parseProviders({ providers } as unknown as WlConfig));
    const after = runDoctor(ws, { [AUTH]: "dummy-secret-value" });
    check("doctor W10：同步后 ⇒ ok 且不再 WARN W10",
      after.out.includes("opencode.json 已含") && !after.out.includes("WARN W10"), `out=${after.out.slice(-600)}`);
    rmSync(ws, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
for (const [name, fn] of [
  ["testPureHelpers", testPureHelpers],
  ["testValidation", testValidation],
  ["testRender", testRender],
  ["testSync", testSync],
  ["testSchedulerGuard", testSchedulerGuard],
  ["testVariantStrip", testVariantStrip],
  ["testDoctor", testDoctor],
] as Array<[string, () => void]>) {
  try { fn(); }
  catch (e) { nfail++; console.log(`FAIL ${name} 异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`); }
}
console.log(`\ntest-provider-routing: ${npass} pass, ${nfail} fail${nfail === 0 ? "\nPROVIDER_ROUTING_OK" : ""}`);
process.exit(nfail ? 1 : 0);
