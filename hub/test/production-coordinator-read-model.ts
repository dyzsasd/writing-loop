import {
  type CoordinatorFailure,
  type CoordinatorOperation,
  parseProductionCoordinatorControlState,
  type ProductionCoordinatorTaskControl,
} from "../src/production-coordinator-domain.ts";
import {
  buildProductionCoordinatorReadModel,
  type ProductionCoordinatorTaskView,
} from "../src/production-coordinator-read-model.ts";
import type { RemoteJobState } from "../src/production-adapter.ts";
import type { ProductionTaskEvent } from "../src/production-domain.ts";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Expect<Value extends true> = Value;
type _RetryOperationContract = Expect<Equal<
  ProductionCoordinatorTaskView["retry"]["operation"], CoordinatorOperation | null
>>;
type _RetryCodeContract = Expect<Equal<
  ProductionCoordinatorTaskView["retry"]["code"], CoordinatorFailure["code"] | null
>>;
type _RemoteStateContract = Expect<Equal<
  ProductionCoordinatorTaskView["remote"]["state"], RemoteJobState | null
>>;
type _PendingEventContract = Expect<Equal<
  ProductionCoordinatorTaskView["pendingEvent"], ProductionTaskEvent["type"] | null
>>;

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const WS = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA = "a".repeat(64);

const task = (taskId: string, state: "reserved" | "exposed" | "released"): ProductionCoordinatorTaskControl => ({
  version: 1,
  taskId,
  observedTaskRevision: 3,
  budgetReservation: state === "reserved"
    ? {
        version: 1,
        state: "reserved",
        currency: "USD",
        reservedAmountMicros: 200_000,
        reservedAt: "2026-08-10T16:00:00.000Z",
        exposedAt: null,
        releasedAt: null,
      }
    : state === "exposed" ? {
        version: 1,
        state: "exposed",
        currency: "USD",
        reservedAmountMicros: 500_000,
        reservedAt: "2026-08-10T16:00:00.000Z",
        exposedAt: "2026-08-10T16:00:01.000Z",
        releasedAt: null,
      }
    : {
        version: 1,
        state: "released",
        currency: "USD",
        reservedAmountMicros: 700_000,
        reservedAt: "2026-08-10T16:00:00.000Z",
        exposedAt: "2026-08-10T16:00:01.000Z",
        releasedAt: "2026-08-10T16:00:03.000Z",
      },
  retryState: taskId === "take-b"
    ? {
        version: 1,
        attempt: 1,
        notBefore: "2026-08-10T16:01:00.000Z",
        lastFailure: { version: 1, operation: "inspect", code: "remote-unavailable", occurredAt: "2026-08-10T16:00:02.000Z" },
      }
    : { version: 1, attempt: 0, notBefore: null, lastFailure: null },
  cancelAttempt: null,
  lastObservation: taskId === "take-b"
    ? {
        version: 1,
        backendInstanceId: "comfy-prod",
        remoteJobId: "11111111-1111-4111-8111-111111111111",
        state: "not-found",
        observedAt: "2026-08-10T16:00:02.000Z",
        outputs: [],
        errorSummary: null,
        responseDigest: SHA,
      }
    : null,
  pendingEvent: null,
});

const model = buildProductionCoordinatorReadModel(parseProductionCoordinatorControlState({
  version: 1,
  workspaceId: WS,
  project: "demo",
  revision: 1,
  updatedAt: "2026-08-10T16:00:03.000Z",
  tasks: [task("take-c", "released"), task("take-b", "exposed"), task("take-a", "reserved")],
}));

ok(model.tasks.map((item) => item.taskId).join(",") === "take-a,take-b,take-c",
  "control read model 以稳定 taskId 排序且不依赖 now/network");
ok(model.summary.budget.reservedAmountMicros === 200_000
  && model.summary.budget.exposedAmountMicros === 500_000,
"尚未联网的 reservation 与可能已计费 exposure 分栏汇总");
ok(model.tasks[2]?.budget.state === "released"
  && model.tasks[2]?.budget.exposedAt === "2026-08-10T16:00:01.000Z"
  && model.tasks[2]?.budget.releasedAt === "2026-08-10T16:00:03.000Z"
  && model.summary.budget.exposedAmountMicros === 500_000,
"released reservation 不占 active exposure，但保留曾暴露及释放时间供审计");
ok(model.summary.tasksWithRetryHistory === 1 && model.summary.lastObservedNotFound === 1
  && model.tasks[1]?.retry.code === "remote-unavailable",
"以历史语义投影稳定 retry/remote 类别，不把终态后的旧 observation 冒充当前动作");
ok(JSON.stringify(model).includes("https://") === false && JSON.stringify(model).includes("token") === false,
  "control read model 不含 endpoint、signed URL 或 credential 字段");

if (fails) {
  console.error(`PRODUCTION_COORDINATOR_READ_MODEL_FAILED ${fails}`);
  process.exit(1);
}
console.log("\nPRODUCTION_COORDINATOR_READ_MODEL_OK");
