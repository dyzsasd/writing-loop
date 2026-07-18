// `writing-loop run` —— 内建调度器 wl-run 的入口（原生 TS：直接 import scheduler.ts 跑，
// 不 spawn 任何解释器）。参数解析 / workspace 定位 / 主循环全在 src/scheduler.ts；
// 本文件只是 cli.ts 路由表指到的自带 main 入口 + 可复用的 runScheduler() 门面。
// Ctrl-C = 优雅停（等 in-flight 收尾，再按一次立即杀）、--for 到点同语义，由调度器自己处理。
import { fileURLToPath } from "node:url";
import { schedulerMain } from "./scheduler.ts";

export async function runScheduler(argv = process.argv.slice(2)): Promise<number> {
  return schedulerMain(argv);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // exitCode 而非 process.exit：让 stdout/stderr（可能是 pipe）自然刷完再退。
  process.exitCode = await schedulerMain(process.argv.slice(2));
}
