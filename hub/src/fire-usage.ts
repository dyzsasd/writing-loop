// fire 的 token / 成本计量（dev-loop hub/src/fire-usage.ts 逐条迁移，三条车道形状各异）。
//
// 采集口径：每条车道加一个结构化输出旗标，fire 结束后从日志缓冲解析。任一字段形状不符
// 一律返回 null —— 记「本次未计量」，绝不写一行看似合理的错数（错的成本数字比没有数字更坏，
// 它会进聚合、进日报、进裁定）。
//
// 与 dev-loop 的差异：writing-loop 的 fire 用 fd 直接重定向到日志文件（进程组治理依赖
// detached + killpg，改成 pipe 会牵动那一层），因此 parse 的输入是「读回的日志文件内容」，
// 而非内存中的 stdout 缓冲。claude 车道额外提供 resultText：日志被 JSON 覆盖后由调度器用它
// 还原成人类可读正文，否则操作者读到的每份 agent 日志都会变成一坨转义 JSON。

export type FireUsage = {
  source: "provider";
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  currency: string | null;
};

export type UsageAdapter = {
  extraArgs: string[];
  parse(stdout: string): FireUsage | null;
  resultText?(stdout: string): string | null;
};

// codex `--json`：JSONL 事件流，usage 挂在事件上或嵌在 response 下，字段名为
// input_tokens / output_tokens / cache_read_tokens / cache_creation_tokens。
function fromCodexUsage(raw: unknown): FireUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const input = usage.input_tokens, output = usage.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  const cost = typeof usage.cost === "number" ? usage.cost : null;
  return { source: "provider", inputTokens: input, outputTokens: output,
    cacheReadTokens: typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : null,
    cacheWriteTokens: typeof usage.cache_creation_tokens === "number" ? usage.cache_creation_tokens : null,
    costUsd: cost, currency: cost !== null ? "USD" : null };
}

export const codexUsageAdapter: UsageAdapter = {
  extraArgs: ["--json"],
  parse(stdout) {
    try {
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim(); if (!trimmed) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
        const direct = fromCodexUsage(event.usage); if (direct) return direct;
        const response = event.response as Record<string, unknown> | undefined;
        if (response) { const nested = fromCodexUsage(response.usage); if (nested) return nested; }
      }
    } catch { /* 解析尽力而为，绝不把异常抛回调度器 */ }
    return null;
  },
};

// claude `--output-format json`：fire 结束时输出单个终端 JSON 对象（非流式），故一次 fire
// 恰好一份 usage，不存在取首条还是末条的问题。cache 字段名带 _input_tokens 后缀，成本在顶层
// total_cost_usd。
function fromClaudeUsage(raw: unknown): Omit<FireUsage, "costUsd" | "currency"> | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const input = usage.input_tokens, output = usage.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  return { source: "provider", inputTokens: input, outputTokens: output,
    cacheReadTokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : null,
    cacheWriteTokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : null };
}

export const claudeUsageAdapter: UsageAdapter = {
  extraArgs: ["--output-format", "json"],
  parse(stdout) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(stdout.trim()) as Record<string, unknown>; } catch { return null; }
    if (!obj || typeof obj !== "object") return null;
    const core = fromClaudeUsage(obj.usage); if (!core) return null;
    const cost = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : null;
    return { ...core, costUsd: cost, currency: cost !== null ? "USD" : null };
  },
  resultText(stdout) {
    try {
      const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
      return typeof obj?.result === "string" ? obj.result : null;
    } catch { return null; } // 截断/崩溃的缓冲 ⇒ 调用方保留原始日志，不至于清空
  },
};

// opencode `--format json`：JSONL 事件流，计量事件是 step_finish，数字嵌在 part 下
// （tokens.{input,output,cache:{read,write}} 与同级 cost）。取最后一条而非第一条：每个模型
// 轮次发一条，取首条只记到开场那一轮，是「看似合理的部分值」。
function fromOpencodeTokens(tokensRaw: unknown, costRaw: unknown): FireUsage | null {
  if (!tokensRaw || typeof tokensRaw !== "object") return null;
  const tokens = tokensRaw as Record<string, unknown>;
  const input = tokens.input, output = tokens.output;
  if (typeof input !== "number" || typeof output !== "number") return null;
  const cache = tokens.cache && typeof tokens.cache === "object" ? tokens.cache as Record<string, unknown> : undefined;
  const cost = typeof costRaw === "number" ? costRaw : null;
  return { source: "provider", inputTokens: input, outputTokens: output,
    cacheReadTokens: typeof cache?.read === "number" ? cache.read : null,
    cacheWriteTokens: typeof cache?.write === "number" ? cache.write : null,
    costUsd: cost, currency: cost !== null ? "USD" : null };
}

export const opencodeUsageAdapter: UsageAdapter = {
  extraArgs: ["--format", "json"],
  parse(stdout) {
    let last: FireUsage | null = null;
    try {
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim(); if (!trimmed) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
        const part = event.part && typeof event.part === "object" ? event.part as Record<string, unknown> : undefined;
        const usage = fromOpencodeTokens(part?.tokens ?? event.tokens, part?.cost ?? event.cost);
        if (usage) last = usage;
      }
    } catch { /* 同上 */ }
    return last;
  },
};

// 车道 → adapter。未知车道返回 null：该 fire 诚实记 usage:null，不猜。
export function resolveUsageAdapter(cli: string): UsageAdapter | null {
  if (cli === "claude") return claudeUsageAdapter;
  if (cli === "codex") return codexUsageAdapter;
  if (cli === "opencode") return opencodeUsageAdapter;
  return null;
}

// 聚合：按维度汇总 fires.jsonl 的 usage。null 语义贯穿——没有任何一行带某字段时该字段为 null
// （「未计量」），而非 0（「计量到 0」）。
export type UsageCell = {
  fires: number; metered: number;
  inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null;
  costUsd: number | null; costMetered: number;
};

export const emptyUsageCell = (): UsageCell => ({ fires: 0, metered: 0, inputTokens: null,
  outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costMetered: 0 });

const addField = (cell: UsageCell, key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens",
  value: number | null | undefined): void => {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  cell[key] = (cell[key] ?? 0) + value;
};

export function addUsageRow(cell: UsageCell, usage: FireUsage | null | undefined): void {
  cell.fires++;
  if (!usage) return;
  cell.metered++;
  addField(cell, "inputTokens", usage.inputTokens);
  addField(cell, "outputTokens", usage.outputTokens);
  addField(cell, "cacheReadTokens", usage.cacheReadTokens);
  addField(cell, "cacheWriteTokens", usage.cacheWriteTokens);
  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd)) {
    cell.costUsd = (cell.costUsd ?? 0) + usage.costUsd; cell.costMetered++;
  }
}

// 缓存命中率 = cacheRead / (cacheRead + input)。两者都缺 ⇒ null（未计量），不返回 0。
export function cacheHitRate(cell: UsageCell): number | null {
  const read = cell.cacheReadTokens, input = cell.inputTokens;
  if (read === null && input === null) return null;
  const denominator = (read ?? 0) + (input ?? 0);
  return denominator === 0 ? null : (read ?? 0) / denominator;
}
