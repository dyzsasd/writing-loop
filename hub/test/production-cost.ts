// v1 cost basis matrix. The basis decides whether a budget reservation may settle and how the
// amount may be displayed, so every accepted basis, the native-currency settlement record and the
// legacy records written before that record existed are pinned here.
import { PRODUCTION_COST_BASES, parseProductionCost } from "../src/production-domain.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

function rejects(value: unknown, fragment: string): boolean {
  try { parseProductionCost(value); return false; }
  catch (error) { return error instanceof Error && error.message.includes(fragment); }
}

const SETTLEMENT = {
  nativeCurrency: "CNY",
  nativeAmountMicros: 2_880_000,
  rateMicrosPerUnit: 138_000,
  rateAsOf: "2026-08-20T00:00:00.000Z",
  rateSource: "gateway-registry",
};

// 2_880_000 CNY micros × 138_000 USD micros/CNY / 1_000_000 = 397_440 USD micros.
const CONVERTED_AMOUNT_MICROS = 397_440;

const known = (
  basis: string,
  settlement?: unknown,
  amountMicros = 400_000,
): Record<string, unknown> => ({
  version: 1,
  state: "known",
  currency: "USD",
  amountMicros,
  basis,
  ...(settlement === undefined ? {} : { settlement }),
});

ok(PRODUCTION_COST_BASES.length === 5
  && PRODUCTION_COST_BASES.includes("tariff") && PRODUCTION_COST_BASES.includes("reported-converted"),
"v1 basis 表包含 tariff 与 reported-converted");

for (const basis of ["reported", "billed", "estimated", "tariff"] as const) {
  const cost = parseProductionCost(known(basis));
  ok(cost.state === "known" && cost.basis === basis && cost.settlement === null,
    `${basis} cost 在缺省 settlement 下按 null 解析`);
}

const converted = parseProductionCost(
  known("reported-converted", { ...SETTLEMENT }, CONVERTED_AMOUNT_MICROS),
);
ok(converted.state === "known" && converted.basis === "reported-converted"
  && converted.amountMicros === CONVERTED_AMOUNT_MICROS
  && converted.settlement !== null
  && converted.settlement.nativeCurrency === "CNY"
  && converted.settlement.nativeAmountMicros === 2_880_000
  && converted.settlement.rateMicrosPerUnit === 138_000
  && converted.settlement.rateAsOf === "2026-08-20T00:00:00.000Z"
  && converted.settlement.rateSource === "gateway-registry",
"reported-converted 保留原币金额、汇率、汇率日期与汇率来源");

ok(rejects(known("reported-converted"), "settlement")
  && rejects(known("reported-converted", null), "settlement"),
"reported-converted 缺少 settlement 被拒绝，不允许无凭据的折算金额");
for (const basis of ["reported", "billed", "estimated", "tariff"] as const) {
  ok(rejects(known(basis, { ...SETTLEMENT }), "settlement"),
    `${basis} 带 settlement 被拒绝，原币结算只属于 reported-converted`);
}

ok(rejects(known("reported-converted", { ...SETTLEMENT }, 400_000), "amountMicros")
  && rejects(known("reported-converted", { ...SETTLEMENT }, CONVERTED_AMOUNT_MICROS + 1), "amountMicros"),
"USD 金额与「原币金额 × 汇率」不符时被拒绝，折算结果不能被手工改写");
ok(rejects(known("reported-converted", { ...SETTLEMENT }, 0), "amountMicros"),
  "原币金额为正时 USD 金额不得记为 0");
const halfUp = parseProductionCost(known(
  "reported-converted",
  { ...SETTLEMENT, nativeAmountMicros: 1, rateMicrosPerUnit: 1_500_000 },
  2,
));
ok(halfUp.state === "known" && halfUp.amountMicros === 2,
  "折算按 half-up 取整：1.5 micros 进位为 2");

ok(rejects(known("provider-invoice"), "basis"), "未知 basis 被拒绝");
ok(rejects(known("reported-converted", { ...SETTLEMENT, nativeCurrency: "JPY" }), "nativeCurrency"),
  "v1 原币结算只接受 CNY");
ok(rejects(known("reported-converted", { ...SETTLEMENT, rateSource: "operator-memory" }), "rateSource"),
  "汇率来源只接受 gateway-registry 的声明");
ok(rejects(known("reported-converted", { ...SETTLEMENT, rateAsOf: "2026-08-20" }), "rateAsOf"),
  "汇率日期必须是规范 UTC ISO-8601 时间");
ok(rejects(known("reported-converted", { ...SETTLEMENT, rateMicrosPerUnit: 0 }), "rateMicrosPerUnit"),
  "汇率必须为正，零汇率不能把原币金额抹成 0");
ok(rejects(known("reported-converted", { ...SETTLEMENT, nativeAmountMicros: -1 }), "nativeAmountMicros"),
  "原币金额必须是非负安全整数");
ok(rejects(known("reported-converted", { ...SETTLEMENT, rateProvider: "gateway" }), "不支持字段"),
  "settlement 严格拒绝未知字段");

// Records written before the settlement field existed must keep their exact prior meaning.
const legacyReported = parseProductionCost({
  version: 1, state: "known", currency: "USD", amountMicros: 800_000, basis: "reported",
});
const legacyEstimated = parseProductionCost({
  version: 1, state: "known", currency: "USD", amountMicros: 3_500_000, basis: "estimated",
});
const legacyUnknown = parseProductionCost({
  version: 1, state: "unknown", reason: "provider-not-reported",
});
ok(JSON.stringify(legacyReported) === JSON.stringify({
  version: 1, state: "known", currency: "USD", amountMicros: 800_000, basis: "reported", settlement: null,
})
  && JSON.stringify(legacyEstimated) === JSON.stringify({
    version: 1, state: "known", currency: "USD", amountMicros: 3_500_000, basis: "estimated", settlement: null,
  })
  && JSON.stringify(legacyUnknown) === JSON.stringify({
    version: 1, state: "unknown", reason: "provider-not-reported",
  }),
"旧 cost 记录的既有字段逐字保持不变，只补 settlement: null");

if (fails) {
  console.error(`\n${fails} production cost test(s) failed`);
  process.exit(1);
}
console.log("\nproduction cost tests OK");
