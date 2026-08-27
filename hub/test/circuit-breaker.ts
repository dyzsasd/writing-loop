// 硬失败熔断器自测（WLSYS-325c25fa · 2026-08-25）。
// 背景实况：08-21T14:14Z 账号撞 claude.ai 限额，CLI 每 fire 启动即 4s exit 1 零 token，
// 调度器无熔断空转 75h/4,872 次。本套件：纯状态机矩阵 + E2E 风暴回归（修复前 12s 内
// 会按 1s interval 连发 ~10 fire；修复后恰 5 发即 OPEN、余下时间零 fire）。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CIRCUIT_COOLDOWN_BASE_S, CIRCUIT_COOLDOWN_MAX_S, CIRCUIT_TRIP_STREAK,
  circuitCanLaunch, circuitInit, circuitOnFireEnd, fireProducedOutput, isHardFail,
} from "../src/scheduler.ts";

let fails = 0;
const ok = (c: boolean, m: string, extra = ""): void => {
  console.log((c ? "PASS " : "FAIL ") + m + (c || !extra ? "" : `（${extra}）`));
  if (!c) fails++;
};

// ── isHardFail 判据矩阵 ─────────────────────────────────────────────────────
ok(isHardFail(1, false, 4, false, false), "4s exit 1 零计量 ⇒ 硬失败（风暴实况形）");
ok(isHardFail(1, false, 0, false, true), "spawn 失败 ⇒ 硬失败（坏二进制形）");
ok(!isHardFail(1, false, 4, true, false), "有真产出的失败 ⇒ 非硬失败（真干过活）");
// 2026-08-27 盲区回归：撞 spend limit 的 fire 秒级 exit1 但 CLI 吐了全 0 的 usage 结构。
// 旧判据 hasUsage=(usage!==null)=true ⇒ 误判非硬失败 ⇒ 熔断器永不 open（75min 空转实况）。
// 修复后 producedOutput 看真产出（cost/token>0），空 usage ⇒ false ⇒ 正确判硬失败。
ok(fireProducedOutput(null) === false, "无 usage ⇒ 无产出");
ok(fireProducedOutput({ source: "provider", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, costUsd: 0, currency: "USD" }) === false,
  "空 usage 结构（cost=0 out=0，撞限额形）⇒ 无真产出（旧判据在此漏判）");
ok(fireProducedOutput({ source: "provider", inputTokens: 1, outputTokens: 5, cacheReadTokens: 0,
  cacheWriteTokens: 0, costUsd: 0, currency: "USD" }) === true, "有 output token ⇒ 有产出");
ok(fireProducedOutput({ source: "provider", inputTokens: 1, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, costUsd: 0.5, currency: "USD" }) === true, "有 costUsd ⇒ 有产出");
ok(isHardFail(1, false, 5, fireProducedOutput({ source: "provider", inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, currency: "USD" }), false) === true,
  "全链路：5s exit1 + 空 usage（撞限额）⇒ 硬失败（修复前此处为 false = 熔断器盲区）");
ok(!isHardFail(143, true, 3601, false, false), "超时被杀 ⇒ 非硬失败（cap 是另一类问题）");
ok(!isHardFail(1, false, 45, false, false), "45s 失败 ⇒ 非硬失败（跑起来过）");
ok(!isHardFail(0, false, 4, false, false), "exit 0 ⇒ 非硬失败");
ok(!isHardFail(null, false, 4, false, false), "rc null 非 spawn 错 ⇒ 非硬失败（信号侧另判）");

// ── 状态机：跳闸 / 探针 / 退避 / 复位 ───────────────────────────────────────
{
  const NOW = 1000; const iso = "2026-08-25T00:00:00Z";
  let s = circuitInit();
  for (let i = 0; i < CIRCUIT_TRIP_STREAK - 1; i++) s = circuitOnFireEnd(s, true, false, "limit msg", NOW, iso);
  ok(s.status === "closed" && s.streak === CIRCUIT_TRIP_STREAK - 1, "阈值前保持 closed，streak 累积");
  ok(circuitCanLaunch(s, NOW).allow && !circuitCanLaunch(s, NOW).probe, "closed ⇒ 正常放行");
  s = circuitOnFireEnd(s, true, false, "You've hit your monthly spend limit", NOW, iso);
  ok(s.status === "open" && s.streak === CIRCUIT_TRIP_STREAK && s.cooldownSeconds === CIRCUIT_COOLDOWN_BASE_S
    && s.reason === "You've hit your monthly spend limit" && s.openedAtIso === iso,
    "第 5 次硬失败 ⇒ OPEN，退避 60s，reason/openedAt 落账");
  ok(!circuitCanLaunch(s, NOW + 10).allow, "冷却期内拒 launch");
  const cl = circuitCanLaunch(s, NOW + CIRCUIT_COOLDOWN_BASE_S + 1);
  ok(cl.allow && cl.probe, "冷却到点 ⇒ 放一发探针");
  // 探针在飞（probing=true 由调用方置）期间不放第二发
  const probing = { ...s, probing: true, probes: 1 };
  ok(!circuitCanLaunch(probing, NOW + 9999).allow, "探针在飞 ⇒ 不放第二发");
  // 探针硬失败 ⇒ 退避翻倍
  let s2 = circuitOnFireEnd(probing, true, true, "still limited", NOW + 70, iso);
  ok(s2.status === "open" && s2.cooldownSeconds === CIRCUIT_COOLDOWN_BASE_S * 2 && !s2.probing
    && s2.cooldownUntilMono === NOW + 70 + 120, "探针硬失败 ⇒ 退避翻倍（60→120s）");
  // 连续翻倍封顶 30min
  for (let i = 0; i < 10; i++) s2 = circuitOnFireEnd({ ...s2, probing: true }, true, true, "x", NOW + 100 + i, iso);
  ok(s2.cooldownSeconds === CIRCUIT_COOLDOWN_MAX_S, `退避封顶 ${CIRCUIT_COOLDOWN_MAX_S}s`);
  // open 期间在飞遗留（非探针）硬失败收账：不动退避
  const s3 = circuitOnFireEnd({ ...s2 }, true, false, "leftover", NOW + 200, iso);
  ok(s3.cooldownSeconds === s2.cooldownSeconds && s3.cooldownUntilMono === s2.cooldownUntilMono,
    "open 期非探针硬失败收账不改退避（避免在飞遗留多倍放大）");
  // 探针成功 ⇒ 全复位
  const s4 = circuitOnFireEnd({ ...s2, probing: true }, false, true, null, NOW + 300, iso);
  ok(s4.status === "closed" && s4.streak === 0 && s4.cooldownUntilMono === null, "探针成功 ⇒ CLOSED 全复位");
  // 中途一次真实活动打断连击
  let s5 = circuitInit();
  s5 = circuitOnFireEnd(s5, true, false, "a", NOW, iso);
  s5 = circuitOnFireEnd(s5, true, false, "b", NOW, iso);
  s5 = circuitOnFireEnd(s5, false, false, null, NOW, iso);
  ok(s5.status === "closed" && s5.streak === 0, "混合形：成功/真实失败复位 streak（单 agent 坏配置不误伤全局）");
}

// ── E2E 风暴回归（真 subprocess 全链路；修复前此断言必败：~10+ fire）──────────
{
  const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const runEntry = join(hubRoot, "src", "run.ts");
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "wl-circuit-")));
  try {
    mkdirSync(join(ws, ".writing-loop"), { recursive: true });
    mkdirSync(join(ws, "t1"), { recursive: true });
    // 假 CLI：启动即打印限额文案并 exit 1（风暴实况形，~50ms 零计量）
    writeFileSync(join(ws, "fail_cli.mjs"),
      "console.log(\"You've hit your monthly spend limit \\u00b7 raise it at claude.ai\");\nprocess.exit(1);\n");
    const agents: Record<string, unknown> = {};
    for (const a of ["showrunner", "source-analyst", "story-designer", "episode-writer", "reviewer",
      "evaluator", "sweep", "script-doctor", "market-watch", "reflect"]) {
      agents[a] = { enabled: false };
    }
    agents["showrunner"] = { enabled: true, intervalSeconds: 1, capSeconds: 30, staggerSeconds: 0,
      command: [process.execPath, join(ws, "fail_cli.mjs")] };
    writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
      version: 1,
      scheduler: { cli: "claude", laneGating: true, agents },
      projects: { t1: { title: "熔断测试", repoPath: "t1", enabled: true } },
    }, null, 2));
    const env = { ...process.env }; delete env.WRITING_LOOP_WORKSPACE;
    const r = spawnSync(process.execPath, [runEntry, "--project", "t1", "--for", "12"],
      { cwd: ws, encoding: "utf8", env, timeout: 120_000 });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    const ledger = join(ws, ".writing-loop", "t1", "fires.jsonl");
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch { /* 无账本 = 0 行 */ }
    ok(rows.length === CIRCUIT_TRIP_STREAK,
      `12s 风暴恰 ${CIRCUIT_TRIP_STREAK} 发即熔断（修复前按 1s interval 连发 ~10+）`, `实得 ${rows.length} 行`);
    ok(out.includes("[circuit] OPEN"), "console 打出 [circuit] OPEN 转换行");
    let rs: Record<string, unknown> = {};
    try { rs = JSON.parse(readFileSync(join(ws, ".writing-loop", "t1", "run-state.json"), "utf8")) as Record<string, unknown>; } catch { /* 缺失让断言败 */ }
    const circuit = rs.circuit as Record<string, unknown> | undefined;
    ok(circuit?.status === "open" && typeof circuit?.reason === "string"
      && String(circuit.reason).includes("monthly spend limit"),
      "run-state.json 的 circuit 块：open + 限额原文可读（操作者可见面）");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

console.log(fails === 0 ? "\nCIRCUIT_BREAKER_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
