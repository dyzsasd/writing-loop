// opencode.json 的 provider 渲染 + 同步（dev-loop opencode-sync.ts:15-26, 48-101 逐字迁移的
// 算法；writing-loop 侧去掉 team 包装，直接对 workspace 顶层 config.json 的 `providers` 键
// 生效——见 scheduler.ts 的 ProviderEntry/parseProviders）。
//
// 硬约束（绝不违反）：
// - 只碰 `<workspace-root>/opencode.json` 这一份**项目级**配置；绝不读写
//   `~/.config/opencode/opencode.json` 或任何其他全局/用户级 opencode 配置。
// - create-or-merge，绝不覆盖操作者手写内容：注册表之外的 provider 条目、opencode.json
//   的其余顶层键，原样保留——只有本注册表管辖的 id 会被写入/更新。
// - 原地覆盖用 JSON.stringify 字节比对判定是否需要改动（幂等：内容不变则不写文件）。
// - 文件已存在但损坏（非法 JSON / 顶层非对象 / provider 键非对象）⇒ 报错，文件原样
//   不动——绝不「修复」或覆盖操作者可能还没来得及排查的手改中间态。
// - 原子写：先写 `<path>.tmp-<pid>` 再 renameSync 覆盖目标，防进程中途被杀留半写文件。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderEntry } from "./scheduler.ts";

// 单条 provider ⇒ opencode.json provider 块的一条渲染（dev-loop opencode-sync.ts:15-26 逐字
// 迁移）。apiKey 用 opencode 自己的 `{env:VAR}` 间接引用——config.json 与 opencode.json
// 两处都绝不出现字面密钥值。
export function renderProviderEntry(id: string, e: ProviderEntry): Record<string, unknown> {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: id,
    options: { baseURL: e.baseUrl, apiKey: `{env:${e.authTokenEnv}}`, ...(e.extraOptions ?? {}) },
    models: Object.fromEntries(e.models.map((m) => [m, {}])),
  };
}

export function renderOpencodeProviders(providers: Record<string, ProviderEntry>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(providers).map(([id, e]) => [id, renderProviderEntry(id, e)]));
}

function atomicWriteJson(target: string, cfg: unknown): void {
  const tmpPath = `${target}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(cfg, null, 2) + "\n");
  renameSync(tmpPath, target); // 同目录内 rename 是原子操作——绝不留半写文件
}

// 既有 opencode.json 的一次性解析结果：ok=true ⇒ {cfg, block}（block 可能是新分配的空对象，
// 当原文件没有 provider 键时）；ok=false ⇒ 携带一个粗分类 reason，供 sync（抛错）与
// drift（报字符串，不抛错）各自转译成各自的措辞。
type ParsedConfig =
  | { ok: true; cfg: Record<string, unknown>; block: Record<string, unknown> }
  | { ok: false; reason: "bad-json" | "not-object" | "bad-provider" };

function parseExistingConfig(target: string): ParsedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    return { ok: false, reason: "bad-json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not-object" };
  }
  const cfg = parsed as Record<string, unknown>;
  if (cfg.provider === undefined) return { ok: true, cfg, block: {} };
  if (cfg.provider === null || typeof cfg.provider !== "object" || Array.isArray(cfg.provider)) {
    return { ok: false, reason: "bad-provider" };
  }
  return { ok: true, cfg, block: cfg.provider as Record<string, unknown> };
}

export type OpencodeSyncAction = "empty" | "created" | "merged" | "updated" | "unchanged";
export type OpencodeSyncResult = { action: OpencodeSyncAction; providers: string[] };

// create-or-merge 同步：注册表为空 ⇒ no-op；目标文件不存在 ⇒ 新建；存在 ⇒ 逐 id 原地
// 覆盖（JSON.stringify 字节相同则跳过），注册表之外的手写 provider 与其余顶层键绝不触碰。
// action：无 id 预先存在 ⇒ "merged"；至少一个预先存在 ⇒ "updated"；全部一致（零改动）
// ⇒ "unchanged"。
export function syncOpencodeConfig(workspaceRoot: string, providers: Record<string, ProviderEntry>): OpencodeSyncResult {
  const ids = Object.keys(providers);
  if (ids.length === 0) return { action: "empty", providers: [] };
  const target = join(workspaceRoot, "opencode.json");
  const rendered = renderOpencodeProviders(providers);

  if (!existsSync(target)) {
    atomicWriteJson(target, { $schema: "https://opencode.ai/config.json", provider: rendered });
    return { action: "created", providers: ids };
  }

  const parsed = parseExistingConfig(target);
  if (!parsed.ok) {
    const label = parsed.reason === "bad-json" ? "不是合法 JSON"
      : parsed.reason === "not-object" ? "顶层不是 JSON 对象"
      : "的 provider 键不是对象";
    throw new Error(`${target} ${label} —— 文件未改动`);
  }
  const { cfg, block } = parsed;

  let anyChanged = false;
  let anyPreexisted = false;
  for (const id of ids) {
    const had = Object.prototype.hasOwnProperty.call(block, id);
    if (had) anyPreexisted = true;
    if (!had || JSON.stringify(block[id]) !== JSON.stringify(rendered[id])) {
      block[id] = rendered[id];
      anyChanged = true;
    }
  }
  if (!anyChanged) return { action: "unchanged", providers: ids };
  cfg.provider = block;
  atomicWriteJson(target, cfg);
  return { action: anyPreexisted ? "updated" : "merged", providers: ids };
}

// 只读漂移检测：null = 已同步/无需同步；否则一句话描述现状，供 doctor W10 使用。绝不写
// 任何文件（连临时文件都不碰）。
export function opencodeSyncDrift(workspaceRoot: string, providers: Record<string, ProviderEntry>): string | null {
  const ids = Object.keys(providers);
  if (ids.length === 0) return null;
  const target = join(workspaceRoot, "opencode.json");
  if (!existsSync(target)) return "opencode.json 缺失";

  const parsed = parseExistingConfig(target);
  if (!parsed.ok) {
    return parsed.reason === "bad-provider" ? "opencode.json 无 provider 块" : "opencode.json 不是合法 JSON";
  }
  const { block } = parsed;
  const rendered = renderOpencodeProviders(providers);
  const stale = ids.filter((id) => !Object.prototype.hasOwnProperty.call(block, id)
    || JSON.stringify(block[id]) !== JSON.stringify(rendered[id]));
  return stale.length ? `opencode.json 的 provider 缺失/过期：${stale.join(", ")}` : null;
}
