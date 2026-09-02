// Pure mapping from a bounded remote observation to durable production facts.
//
// This module performs no I/O, reads no clock and creates no event IDs.  The coordinator owns
// those side effects and must persist each returned fact as an exact event before continuing.
import {
  isTerminalProductionStatus,
  parseProductionTask,
  type ProductionCancellationConfirmation,
  type ProductionCost,
  type ProductionTask,
} from "./production-domain.ts";
import type { RemoteObservation, RemoteOutputLocator } from "./production-adapter.ts";

export type ProductionReconcileFact =
  | { type: "submission-uncertain"; reason: "coordinator-recovered-prepared-submit" }
  | { type: "submission-confirmed"; backendInstanceId: string; remoteJobId: string }
  | { type: "remote-started"; backendInstanceId: string; remoteJobId: string }
  | { type: "ingestion-started" }
  | { type: "qc-requested"; assets: ProductionTask["assets"]; cost: ProductionCost }
  | { type: "cancelled"; reason: "remote-cancelled-confirmed"; confirmation: ProductionCancellationConfirmation }
  | { type: "failed"; reason: string };

export type ProductionReconcileDecision = {
  version: 1;
  disposition: "noop" | "events" | "ingest" | "manual-attention";
  reason:
    | "terminal"
    | "not-dispatched"
    | "remote-pending"
    | "remote-regressed"
    | "remote-not-found"
    | "cancel-awaiting-terminal"
    | "qc-awaiting-human"
    | "apply-events"
    | "ingest-output";
  facts: ProductionReconcileFact[];
  observation: RemoteObservation;
};

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_ERROR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OUTPUT_KINDS = new Set(["image", "video", "audio", "file"]);
const FOLDER_TYPES = new Set(["input", "output", "temp"]);
const MAX_OUTPUTS = 128;

function fail(detail: string): never {
  throw new Error(`RemoteObservation ${detail}`);
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function exactKeys(value: Record<string, unknown>, keys: readonly string[], subject: string): void {
  const actual = Object.keys(value);
  const extras = actual.filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (extras.length || missing.length) {
    fail(`${subject} keys invalid`);
  }
}

function iso(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) fail("observedAt invalid");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) fail("observedAt invalid");
  return value;
}

function locator(value: unknown, index: number): RemoteOutputLocator {
  if (!object(value)) fail(`outputs[${index}] must be an object`);
  // §4.5：locator 按 source 分支，缺少 source 时按 comfy-view 读取。provider-output 需要 adapter 的
  // openOutput 取回路径（§8.6 的 ingest kernel 行，下一切片），此处 fail-closed 拒绝。
  const source = Object.prototype.hasOwnProperty.call(value, "source") ? value.source : "comfy-view";
  if (source === "provider-output") {
    fail(`outputs[${index}].source provider-output 的 openOutput 取回路径尚未装配`);
  }
  if (source !== "comfy-view") fail(`outputs[${index}].source must be comfy-view or provider-output`);
  const comfyKeys = ["nodeId", "kind", "filename", "subfolder", "folderType"];
  exactKeys(
    value,
    Object.prototype.hasOwnProperty.call(value, "source") ? ["source", ...comfyKeys] : comfyKeys,
    `outputs[${index}]`,
  );
  const text = (field: "nodeId" | "filename" | "subfolder"): string => {
    const item = value[field];
    if (typeof item !== "string" || item.length > 1_024 || /[\u0000-\u001f\u007f]/.test(item)) {
      fail(`outputs[${index}].${field} invalid`);
    }
    return item;
  };
  const nodeId = text("nodeId");
  const filename = text("filename");
  const subfolder = text("subfolder");
  if (!nodeId || !filename || filename.includes("/") || filename.includes("\\") || filename === "." || filename === "..") {
    fail(`outputs[${index}] contains an unsafe identity/path`);
  }
  if (subfolder.startsWith("/") || subfolder.startsWith("\\")
    || subfolder.split(/[\\/]/).some((part) => part === "..")) {
    fail(`outputs[${index}].subfolder contains traversal`);
  }
  if (!OUTPUT_KINDS.has(String(value.kind)) || !FOLDER_TYPES.has(String(value.folderType))) {
    fail(`outputs[${index}] enum invalid`);
  }
  // 归一化时不落 source：ingest 请求体的 exactKeys 仍是固定五字段。
  return {
    nodeId,
    kind: value.kind as RemoteOutputLocator["kind"],
    filename,
    subfolder,
    folderType: value.folderType as RemoteOutputLocator["folderType"],
  };
}

/** Strictly canonicalize observations before they participate in a durable decision. */
export function parseRemoteObservation(value: unknown): RemoteObservation {
  if (!object(value)) fail("must be an object");
  exactKeys(value, ["remoteJobId", "state", "observedAt", "outputs", "errorSummary", "responseDigest"], "");
  if (typeof value.remoteJobId !== "string" || !IDENTIFIER.test(value.remoteJobId)) fail("remoteJobId invalid");
  const states = new Set(["pending", "running", "succeeded", "failed", "cancelled", "not-found"]);
  if (typeof value.state !== "string" || !states.has(value.state)) fail("state invalid");
  if (!Array.isArray(value.outputs) || value.outputs.length > MAX_OUTPUTS) fail("outputs invalid");
  if (value.errorSummary !== null
    && (typeof value.errorSummary !== "string" || !SAFE_ERROR.test(value.errorSummary))) {
    fail("errorSummary is not persistence-safe");
  }
  if (typeof value.responseDigest !== "string" || !SHA256.test(value.responseDigest)) fail("responseDigest invalid");
  return {
    remoteJobId: value.remoteJobId,
    state: value.state as RemoteObservation["state"],
    observedAt: iso(value.observedAt),
    outputs: value.outputs.map(locator),
    errorSummary: value.errorSummary as string | null,
    responseDigest: value.responseDigest,
  };
}

function decision(
  disposition: ProductionReconcileDecision["disposition"],
  reason: ProductionReconcileDecision["reason"],
  observation: RemoteObservation,
  facts: ProductionReconcileFact[] = [],
): ProductionReconcileDecision {
  return { version: 1, disposition, reason, facts, observation };
}

function remoteTuple(task: ProductionTask, observation: RemoteObservation): {
  backendInstanceId: string;
  remoteJobId: string;
} {
  if (task.backendInstanceId === null || task.remoteJobId === null || task.remoteJobId !== observation.remoteJobId) {
    fail("does not match the task remote tuple");
  }
  return { backendInstanceId: task.backendInstanceId, remoteJobId: task.remoteJobId };
}

function succeededFacts(task: ProductionTask, tuple: ReturnType<typeof remoteTuple>): ProductionReconcileFact[] {
  if (task.status === "ingesting") return [];
  if (task.status === "cancel-requested") {
    const source = task.cancellationRequest?.requestedFrom;
    if (source === "qc-pending") {
      return [{ type: "qc-requested", assets: task.assets, cost: task.cost }];
    }
    if (source === "ingesting") return [{ type: "ingestion-started" }];
    return [
      { type: "remote-started", ...tuple },
      { type: "ingestion-started" },
    ];
  }
  if (task.status === "submitting") {
    return [
      { type: "submission-uncertain", reason: "coordinator-recovered-prepared-submit" },
      { type: "submission-confirmed", ...tuple },
      { type: "ingestion-started" },
    ];
  }
  if (task.status === "submission-unknown") {
    return [{ type: "submission-confirmed", ...tuple }, { type: "ingestion-started" }];
  }
  if (task.status === "submitted" || task.status === "running") return [{ type: "ingestion-started" }];
  return [];
}

/**
 * Decide which monotonic facts a coordinator may persist for one observation.
 * `not-found` and transport failures never become failed/orphaned here; policy and repeated durable
 * evidence belong to the coordinator control state.
 */
export function decideProductionObservation(taskValue: ProductionTask, value: RemoteObservation): ProductionReconcileDecision {
  const task = parseProductionTask(taskValue);
  const observation = parseRemoteObservation(value);
  if (isTerminalProductionStatus(task.status)) return decision("noop", "terminal", observation);
  if (task.status === "planned" || task.status === "dispatch-pending") {
    return decision("manual-attention", "not-dispatched", observation);
  }
  const tuple = remoteTuple(task, observation);

  if (observation.state === "not-found") {
    const facts: ProductionReconcileFact[] = task.status === "submitting"
      ? [{ type: "submission-uncertain", reason: "coordinator-recovered-prepared-submit" }]
      : [];
    return decision(facts.length ? "events" : "manual-attention", "remote-not-found", observation, facts);
  }

  if (observation.state === "cancelled") {
    if (task.cancellationRequest !== null) {
      return decision("events", "apply-events", observation, [{
        type: "cancelled",
        reason: "remote-cancelled-confirmed",
        confirmation: {
          version: 1,
          kind: "remote-terminal-observation",
          backendInstanceId: tuple.backendInstanceId,
          remoteJobId: tuple.remoteJobId,
          state: "cancelled",
          observedAt: observation.observedAt,
          responseDigest: observation.responseDigest,
        },
      }]);
    }
    return decision("events", "apply-events", observation, [{
      type: "failed",
      reason: "remote-cancelled-without-local-request",
    }]);
  }

  if (observation.state === "failed") {
    const suffix = observation.errorSummary === null ? "" : `:${observation.errorSummary}`;
    const prefix: ProductionReconcileFact[] = task.status === "submitting"
      ? [{ type: "submission-uncertain", reason: "coordinator-recovered-prepared-submit" }]
      : [];
    return decision("events", "apply-events", observation, [...prefix, {
      type: "failed",
      reason: `remote-failed${suffix}`,
    }]);
  }

  if (observation.state === "succeeded") {
    if (task.status === "qc-pending") return decision("noop", "qc-awaiting-human", observation);
    const facts = succeededFacts(task, tuple);
    if (task.status === "cancel-requested" && task.cancellationRequest?.requestedFrom === "qc-pending") {
      return decision("events", "apply-events", observation, facts);
    }
    return decision("ingest", "ingest-output", observation, facts);
  }

  if (task.status === "cancel-requested") {
    return decision("noop", "cancel-awaiting-terminal", observation);
  }
  if (task.status === "qc-pending" || task.status === "ingesting") {
    return decision("noop", task.status === "qc-pending" ? "qc-awaiting-human" : "remote-regressed", observation);
  }

  if (observation.state === "pending") {
    if (task.status === "submitting") return decision("events", "apply-events", observation, [
      { type: "submission-uncertain", reason: "coordinator-recovered-prepared-submit" },
      { type: "submission-confirmed", ...tuple },
    ]);
    if (task.status === "submission-unknown") return decision("events", "apply-events", observation, [
      { type: "submission-confirmed", ...tuple },
    ]);
    return decision("noop", task.status === "submitted" ? "remote-pending" : "remote-regressed", observation);
  }

  // running
  if (task.status === "submitting") return decision("events", "apply-events", observation, [
    { type: "submission-uncertain", reason: "coordinator-recovered-prepared-submit" },
    { type: "remote-started", ...tuple },
  ]);
  if (task.status === "submission-unknown" || task.status === "submitted") {
    return decision("events", "apply-events", observation, [{ type: "remote-started", ...tuple }]);
  }
  return decision("noop", "remote-regressed", observation);
}
