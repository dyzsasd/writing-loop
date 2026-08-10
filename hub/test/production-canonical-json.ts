import {
  ProductionCanonicalJsonError,
  productionCanonicalJson,
  productionCanonicalJsonSha256,
} from "../src/production-canonical-json.ts";

let failures = 0;
const ok = (condition: boolean, message: string): void => {
  console.log(`${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) failures++;
};

const left = {
  z: [{ second: 2, first: 1 }],
  graph: {
    "10": { inputs: { width: 768, source: ["2", 0] }, class_type: "Generator" },
    "2": { class_type: "LoadImage", inputs: { image: "cas/aa/digest" } },
  },
  minusZero: -0,
};
const right = {
  minusZero: 0,
  graph: {
    "2": { inputs: { image: "cas/aa/digest" }, class_type: "LoadImage" },
    "10": { class_type: "Generator", inputs: { source: ["2", 0], width: 768 } },
  },
  z: [{ first: 1, second: 2 }],
};

ok(productionCanonicalJson(left) === productionCanonicalJson(right)
  && productionCanonicalJsonSha256(left) === productionCanonicalJsonSha256(right),
"递归对象键重排与 -0 不改变跨 worker/Gateway workflow identity");
ok(productionCanonicalJson({ Z: 1, _: 2, a: 3 }).indexOf('"Z"')
  < productionCanonicalJson({ Z: 1, _: 2, a: 3 }).indexOf('"_"')
  && productionCanonicalJson({ Z: 1, _: 2, a: 3 }).indexOf('"_"')
  < productionCanonicalJson({ Z: 1, _: 2, a: 3 }).indexOf('"a"'),
"canonical object keys 使用稳定 Unicode code-unit 顺序而非 locale collation");
ok(productionCanonicalJsonSha256({ values: [1, 2] })
  !== productionCanonicalJsonSha256({ values: [2, 1] }),
"数组顺序保持语义，不被 canonicalization 重排");

function rejects(value: unknown): boolean {
  try {
    productionCanonicalJson(value);
    return false;
  } catch (error) {
    return error instanceof ProductionCanonicalJsonError;
  }
}

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
const sparse = new Array(2);
sparse[1] = "present";
const accessor = {} as Record<string, unknown>;
Object.defineProperty(accessor, "value", { enumerable: true, get: () => "side-effect" });
const hidden = { visible: true } as Record<string, unknown>;
Object.defineProperty(hidden, "secret", { enumerable: false, value: "CANARY" });
let arrayGetterCalls = 0;
const accessorArray: unknown[] = [];
Object.defineProperty(accessorArray, "0", {
  enumerable: true,
  get: () => {
    arrayGetterCalls++;
    return "side-effect";
  },
});
accessorArray.length = 1;

ok(rejects(Number.NaN) && rejects(Number.POSITIVE_INFINITY)
  && rejects(Number.MAX_SAFE_INTEGER + 1),
"非有限与不安全整数不会被 JSON 静默改写后参与生产摘要");
ok(rejects({ missing: undefined }) && rejects(cyclic) && rejects(sparse),
"undefined、循环与稀疏数组统一 fail-closed");
ok(rejects(new Date()) && rejects(accessor) && rejects(hidden),
"非 plain object、getter 与隐藏字段不能绕过 canonical identity");
ok(rejects(accessorArray) && arrayGetterCalls === 0,
"数组索引 getter 在执行前 fail-closed，不允许摘要过程触发调用方副作用");

console.log(failures === 0 ? "\nPRODUCTION_CANONICAL_JSON_OK" : `\n${failures} 项检查失败`);
process.exit(failures === 0 ? 0 : 1);
