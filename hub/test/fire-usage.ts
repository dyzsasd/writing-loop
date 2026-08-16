// fire 计量回归：三条车道的 usage 解析、null 降级纪律与聚合口径。
// fixture 用各 CLI 的真实输出形状（dev-loop 实测样本），不是手写的理想结构。
import { addUsageRow, cacheHitRate, claudeUsageAdapter, codexUsageAdapter, emptyUsageCell,
  opencodeUsageAdapter, resolveUsageAdapter } from "../src/fire-usage.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message); if (!condition) fails++;
};

// ---- claude：单个终端 JSON 对象（--output-format json）----
const claudeOut = JSON.stringify({
  type: "result", subtype: "success", is_error: false,
  result: "本 fire 完成 ep-020 正文，人物调度单已补齐。",
  usage: { input_tokens: 1_234, output_tokens: 567,
    cache_creation_input_tokens: 8_900, cache_read_input_tokens: 45_000 },
  total_cost_usd: 0.4231,
});
const claudeUsage = claudeUsageAdapter.parse(claudeOut);
ok(claudeUsage?.inputTokens === 1_234 && claudeUsage.outputTokens === 567
  && claudeUsage.cacheReadTokens === 45_000 && claudeUsage.cacheWriteTokens === 8_900
  && claudeUsage.costUsd === 0.4231 && claudeUsage.currency === "USD",
"claude 车道解析 input/output/cache 读写与 total_cost_usd");
ok(claudeUsageAdapter.resultText?.(claudeOut) === "本 fire 完成 ep-020 正文，人物调度单已补齐。",
"claude 车道能取回 result 正文供日志还原");
ok(claudeUsageAdapter.parse("Execution error") === null
  && claudeUsageAdapter.resultText?.("Execution error") === null,
"claude 车道遇非 JSON 缓冲降级为 null，不产出臆造数字");
ok(claudeUsageAdapter.parse(JSON.stringify({ type: "result", usage: { input_tokens: "1234" } })) === null,
"claude 车道字段类型不符即 null（字符串 token 数不接受）");

// ---- codex：JSONL 事件流（--json）----
const codexOut = [
  JSON.stringify({ type: "task_started" }),
  JSON.stringify({ type: "token_count", usage: { input_tokens: 900, output_tokens: 120,
    cache_read_tokens: 30_000, cache_creation_tokens: 400, cost: 0.15 } }),
].join("\n");
const codexUsage = codexUsageAdapter.parse(codexOut);
ok(codexUsage?.inputTokens === 900 && codexUsage.cacheReadTokens === 30_000 && codexUsage.costUsd === 0.15,
"codex 车道从 JSONL 事件流中取出 usage");
ok(codexUsageAdapter.parse(JSON.stringify({ response: { usage: { input_tokens: 5, output_tokens: 6 } } }))?.inputTokens === 5,
"codex 车道也读嵌在 response 下的 usage");
ok(codexUsageAdapter.parse("not json\nstill not json") === null, "codex 车道整段非 JSON 时记 null");

// ---- opencode：JSONL，计量事件嵌在 part 下，取最后一条 ----
const opencodeOut = [
  JSON.stringify({ type: "step_finish", part: { type: "step-finish",
    tokens: { input: 100, output: 20, cache: { read: 1_000, write: 50 } }, cost: 0.01 } }),
  JSON.stringify({ type: "step_finish", part: { type: "step-finish",
    tokens: { input: 300, output: 90, cache: { read: 5_000, write: 80 } }, cost: 0.05 } }),
].join("\n");
const opencodeUsage = opencodeUsageAdapter.parse(opencodeOut);
ok(opencodeUsage?.inputTokens === 300 && opencodeUsage.costUsd === 0.05,
"opencode 车道取最后一个 step_finish，不把开场那一轮当作 fire 总量");
ok(opencodeUsageAdapter.parse(JSON.stringify({ type: "step_finish", part: { tokens: {} } })) === null,
"opencode 车道遇空 tokens 记 null，不写一行零填充");

// ---- 车道解析 ----
ok(resolveUsageAdapter("claude")?.extraArgs.join(" ") === "--output-format json"
  && resolveUsageAdapter("codex")?.extraArgs.join(" ") === "--json"
  && resolveUsageAdapter("opencode")?.extraArgs.join(" ") === "--format json"
  && resolveUsageAdapter("gemini") === null,
"每条车道有对应计量旗标，未知车道返回 null 而非猜测");

// ---- 聚合：null 语义 ----
const cell = emptyUsageCell();
addUsageRow(cell, null);
ok(cell.fires === 1 && cell.metered === 0 && cell.inputTokens === null && cell.costUsd === null,
"未计量的 fire 计入 fires 但不计入 metered，字段保持 null 而非 0");
addUsageRow(cell, claudeUsage);
addUsageRow(cell, { source: "provider", inputTokens: 1_000, outputTokens: 100,
  cacheReadTokens: 5_000, cacheWriteTokens: null, costUsd: null, currency: null });
ok(cell.fires === 3 && cell.metered === 2 && cell.inputTokens === 2_234 && cell.outputTokens === 667,
"聚合只累加带 usage 的行");
ok(cell.cacheWriteTokens === 8_900 && cell.costUsd === 0.4231 && cell.costMetered === 1,
"缺某字段的行不破坏该字段的合计；成本覆盖数独立于 token 覆盖数");
ok(cacheHitRate(cell) !== null && Math.abs(cacheHitRate(cell)! - 50_000 / 52_234) < 1e-9,
"缓存命中率 = cacheRead /（cacheRead + input）");
ok(cacheHitRate(emptyUsageCell()) === null, "全未计量时命中率为 null，不报 0%");

console.log(fails === 0 ? "\nFIRE_USAGE_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
