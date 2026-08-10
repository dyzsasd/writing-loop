// Exact USD formatting for production facts. Binary floating point must never turn a positive
// reservation/exposure into a displayed zero or make half-cent rounding platform-dependent.

/** Format non-negative integer USD micros using exact half-up cents and an honest sub-cent label. */
export function formatProductionUsdMicros(amountMicros: number): string {
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 0) {
    throw new Error("production USD micros 必须是非负安全整数");
  }
  if (amountMicros > 0 && amountMicros < 10_000) return "<$0.01";
  const cents = (BigInt(amountMicros) + 5_000n) / 10_000n;
  const dollars = cents / 100n;
  const remainder = String(cents % 100n).padStart(2, "0");
  return `$${dollars}.${remainder}`;
}
