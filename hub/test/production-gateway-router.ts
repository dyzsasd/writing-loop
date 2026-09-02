import {
  ProductionGatewayRouter,
  startProductionGatewayRouter,
  type ProductionGatewayRouteHandler,
} from "../src/production-gateway-router.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

class FakeHandler implements ProductionGatewayRouteHandler {
  readonly name: string;
  calls: Request[] = [];
  closes = 0;
  error: Error | null = null;

  constructor(name: string) { this.name = name; }

  async handle(request: Request): Promise<Response> {
    this.calls.push(request);
    if (this.error) throw this.error;
    return new Response(JSON.stringify({ version: 1, handler: this.name }), {
      headers: { "content-type": "application/json", "x-test-handler": this.name },
    });
  }

  close(): void { this.closes++; }
}

const jobs = new FakeHandler("jobs");
const stages = new FakeHandler("stages");
const artifacts = new FakeHandler("artifacts");
const router = new ProductionGatewayRouter({ jobs, stages, artifacts });
const base = "https://gateway.internal/v1/scopes/ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/drama-a";

for (const [method, suffix, expected] of [
  ["PUT", "jobs/job-1", jobs],
  ["GET", "jobs/job-1", jobs],
  ["PUT", "jobs/job-1/cancellations/" + "a".repeat(64), jobs],
  ["PUT", "stages/" + "b".repeat(64), stages],
  ["PUT", "ingests/" + "c".repeat(64), artifacts],
  ["GET", "assets/sha256/" + "d".repeat(64), artifacts],
  ["HEAD", "assets/sha256/" + "d".repeat(64), artifacts],
  ["PUT", "assets/sha256/" + "d".repeat(64), artifacts],
] as const) {
  const before = expected.calls.length;
  const request = new Request(`${base}/${suffix}`, { method });
  const response = await router.handle(request);
  ok(response.status === 200 && response.headers.get("x-test-handler") === expected.name
    && expected.calls.length === before + 1 && expected.calls.at(-1) === request,
  `${method} ${suffix.split("/", 1)[0]} 只委派给 exact private handler，并保留原 Request`);
}

const totalCalls = (): number => jobs.calls.length + stages.calls.length + artifacts.calls.length;
for (const [method, url] of [
  ["POST", `${base}/jobs/job-1`],
  ["DELETE", `${base}/stages/${"a".repeat(64)}`],
  ["DELETE", `${base}/assets/sha256/${"a".repeat(64)}`],
  ["HEAD", `${base}/ingests/${"a".repeat(64)}`],
  ["PUT", `${base}/jo%62s/job-1`],
  ["PUT", `${base}/%2Fjobs/job-1`],
  ["PUT", `${base}/prompts/job-1`],
  ["PUT", `https://gateway.internal/v1/ingests/${"a".repeat(64)}`],
  ["PUT", `${base}/jobs/job-1?token=ROUTER_SECRET_CANARY`],
] as const) {
  const before = totalCalls();
  const response = await router.handle(new Request(url, { method }));
  const body = await response.text();
  ok(response.status === 404 && totalCalls() === before
    && !body.includes("ROUTER_SECRET_CANARY")
    && response.headers.get("access-control-allow-origin") === null,
  "method/resource/encoding/query confusion 固定 404，零 handler/auth 调用且不回显 secret");
}

jobs.error = new Error("HANDLER_SECRET_CANARY");
const failed = await router.handle(new Request(`${base}/jobs/job-error`, { method: "GET" }));
ok(failed.status === 500 && !(await failed.text()).includes("HANDLER_SECRET_CANARY"),
  "handler rejection 被固定 internal envelope 脱敏，不泄露 cause");

const shared = new FakeHandler("shared");
const sharedRouter = new ProductionGatewayRouter({ jobs: shared, stages: shared, artifacts: shared });
sharedRouter.close();
sharedRouter.close();
const closed = await sharedRouter.handle(new Request(`${base}/jobs/job-1`, { method: "GET" }));
ok(shared.closes === 1 && closed.status === 503 && shared.calls.length === 0,
  "close 对共享 handler 幂等聚合；关闭后拒绝新请求且不进入任何内核");

let publicBindRejected = false;
try {
  await startProductionGatewayRouter(
    new ProductionGatewayRouter({ jobs: new FakeHandler("j"), stages: new FakeHandler("s"), artifacts: new FakeHandler("a") }),
    { bindHost: "0.0.0.0", bindPort: 0 },
  );
} catch { publicBindRejected = true; }
ok(publicBindRejected, "Node boundary 在 listen 前拒绝 wildcard/public/hostname bind，只接受 literal private IP");

const liveJobs = new FakeHandler("live-jobs");
const liveStages = new FakeHandler("live-stages");
const liveArtifacts = new FakeHandler("live-artifacts");
const live = await startProductionGatewayRouter(
  new ProductionGatewayRouter({ jobs: liveJobs, stages: liveStages, artifacts: liveArtifacts }),
  { bindHost: "127.0.0.1", bindPort: 0 },
);
const liveResponse = await fetch(
  `http://127.0.0.1:${live.address.port}/v1/scopes/ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/drama-a/jobs/live-job`,
);
ok(liveResponse.status === 200 && liveJobs.calls.length === 1
  && new URL(liveJobs.calls[0]!.url).port === String(live.address.port)
  && liveStages.calls.length === 0 && liveArtifacts.calls.length === 0,
  "真实 Node loopback bridge 将原始 path/method 与实际随机端口交给同一 strict router");
await live.close();

router.close();
ok(jobs.closes === 1 && stages.closes === 1 && artifacts.closes === 1,
  "router shutdown 始终通知全部独立 gateway kernel");

if (fails) {
  console.error(`\n${fails} production gateway router assertion(s) failed`);
  process.exit(1);
}
console.log("\nPRODUCTION_GATEWAY_ROUTER_OK");
