import { createHash } from "node:crypto";

/**
 * Stable JSON used for cross-process production identities.
 *
 * This is deliberately separate from provider request digests: adapters still hash the exact
 * bytes they send. Workflow/profile identities instead need to survive harmless object-key
 * reordering between the worker, Gateway and a restarted registry.
 */
export class ProductionCanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionCanonicalJsonError";
  }
}

const MAX_DEPTH = 64;
const MAX_CONTAINER_ENTRIES = 100_000;

function fail(message: string): never {
  throw new ProductionCanonicalJsonError(message);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): string {
  if (depth > MAX_DEPTH) fail("production canonical JSON exceeds its depth limit");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      fail("production canonical JSON contains an unsafe number");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") fail("production canonical JSON contains a non-JSON value");
  if (ancestors.has(value)) fail("production canonical JSON contains a cycle");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_CONTAINER_ENTRIES) fail("production canonical JSON array is too large");
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          fail("production canonical JSON contains a sparse array");
        }
      }
      if (Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length !== 0) {
        fail("production canonical JSON array has non-index properties");
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          fail("production canonical JSON array has an accessor property");
        }
        items.push(canonical(descriptor.value, depth + 1, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("production canonical JSON contains a non-plain object");
    }
    const names = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value as Record<string, unknown>);
    if (names.length !== keys.length || Object.getOwnPropertySymbols(value).length !== 0) {
      fail("production canonical JSON object has hidden or symbol properties");
    }
    if (keys.length > MAX_CONTAINER_ENTRIES) fail("production canonical JSON object is too large");
    keys.sort(compareCodeUnits);
    const fields = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail("production canonical JSON object has an accessor property");
      }
      return `${JSON.stringify(key)}:${canonical(descriptor.value, depth + 1, ancestors)}`;
    });
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function productionCanonicalJson(value: unknown): string {
  return canonical(value, 0, new WeakSet<object>());
}

export function productionCanonicalJsonSha256(value: unknown): string {
  return createHash("sha256").update(productionCanonicalJson(value), "utf8").digest("hex");
}
