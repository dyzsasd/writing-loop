// Workspace-scoped production worker single-flight.
//
// Project leases prevent duplicate work for one project; this outer lease prevents two worker
// processes from each consuming their own in-memory backend permits for different projects in the
// same workspace. It deliberately reuses the inode-safe coordinator lock primitive.
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  acquireProductionCoordinatorOwnedLock,
  type ProductionCoordinatorLockHooks,
} from "./production-coordinator-lock.ts";
import { ProductionError } from "./production-domain.ts";
import { readWorkspaceIdentity } from "./workspace-registry.ts";

export const PRODUCTION_WORKER_LEASE_FILE = ".production-worker.v1.lock";
export const PRODUCTION_WORKER_ACQUISITION_GATE_FILE = ".production-worker.v1.acquire";

export type ProductionWorkerLease = {
  readonly file: string;
  readonly released: boolean;
  release(): void;
};

export function productionWorkerWorkspaceDirectory(root: string, workspaceId: string): string {
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync(resolve(root)); }
  catch { throw new ProductionError("production worker workspace root 不存在"); }
  const directory = join(canonicalRoot, ".writing-loop");
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(directory); }
  catch { throw new ProductionError("production worker workspace state directory 不存在"); }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ProductionError("production worker workspace state 必须是真实目录");
  }
  if (readWorkspaceIdentity(canonicalRoot).id !== workspaceId) {
    throw new ProductionError("production worker lease workspaceId 与 durable identity 不匹配");
  }
  return directory;
}

export function acquireProductionWorkerLease(
  root: string,
  workspaceId: string,
  hooks: ProductionCoordinatorLockHooks = {},
): ProductionWorkerLease {
  const directory = productionWorkerWorkspaceDirectory(root, workspaceId);
  const owned = acquireProductionCoordinatorOwnedLock(directory, workspaceId, "__workspace__", {
    file: PRODUCTION_WORKER_LEASE_FILE,
    gate: PRODUCTION_WORKER_ACQUISITION_GATE_FILE,
    label: "production workspace worker lease",
  }, hooks);
  let released = false;
  return {
    file: owned.file,
    get released() { return released; },
    release() {
      if (released) return;
      released = true;
      owned.release();
    },
  };
}
