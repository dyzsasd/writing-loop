import { formatProductionUsdMicros } from "../src/production-money.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const throws = (value: number): boolean => {
  try { formatProductionUsdMicros(value); return false; } catch { return true; }
};

ok(formatProductionUsdMicros(0) === "$0.00", "精确零仍显示 $0.00");
ok(formatProductionUsdMicros(1) === "<$0.01" && formatProductionUsdMicros(4_999) === "<$0.01",
  "任何正数 sub-cent 成本/敞口都不会伪装为 $0.00");
ok(formatProductionUsdMicros(5_000) === "<$0.01",
  "不足一整 cent 的正值优先诚实显示范围，而非二进制/四舍五入零值");
ok(formatProductionUsdMicros(10_000) === "$0.01" && formatProductionUsdMicros(1_005_000) === "$1.01",
  "一 cent 以上使用整数 half-up rounding，1.005 不受 IEEE-754 tie 影响");
ok(formatProductionUsdMicros(Number.MAX_SAFE_INTEGER) === "$9007199254.74",
  "最大安全汇总金额仍通过 BigInt 精确格式化");
ok(throws(-1) && throws(0.5) && throws(Number.MAX_SAFE_INTEGER + 1),
  "负数、小数与不安全整数 fail-closed");

if (fails) {
  console.error(`PRODUCTION_MONEY_FAILED ${fails}`);
  process.exit(1);
}
console.log("\nPRODUCTION_MONEY_OK");
