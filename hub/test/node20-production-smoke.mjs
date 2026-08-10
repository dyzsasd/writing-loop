// Compiled-package smoke for the exact Node 20.11 runtime floor. Source .ts tests run on Node 24;
// this file deliberately imports only dist/*.js and performs a no-network coordinator round.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionStore } from "../dist/production-store.js";
import { runProductionProjectOnce } from "../dist/production-coordinator.js";
import { formatProductionUsdMicros } from "../dist/production-money.js";

// Also execute the exact example shipped in the npm tarball. It parses the strict runtime config,
// materializes H3 template→bound, assembles fake/no-network ports and takes worker --once.
await import("../examples/production/representative-h3/smoke.mjs");

const root = mkdtempSync(join(tmpdir(), "wl-node20-production-"));
const workspaceId = `ws_${"a".repeat(32)}`;
try {
  mkdirSync(join(root, ".writing-loop", "demo"), { recursive: true });
  new ProductionStore(root, workspaceId, "demo").create({
    version: 1,
    id: "take-node20",
    idempotencyKey: "idem-node20",
    subject: {
      version: 1,
      kind: "episode",
      episode: {
        version: 1,
        episodeId: "ep-001",
        revision: 1,
        source: {
          version: 1,
          uri: "s3://writing-loop-assets/demo/ep-001.md",
          sha256: "a".repeat(64),
          byteLength: 12,
          mediaType: "text/markdown",
        },
      },
    },
    createdAt: "2026-08-10T12:00:00.000Z",
  });
  const unreachable = () => { throw new Error("planned task must not resolve a remote dependency"); };
  const result = await runProductionProjectOnce({
    root,
    workspaceId,
    project: "demo",
    adapterRegistry: { resolve: unreachable },
    intentResolver: { resolve: async () => unreachable() },
    workflowResolver: { resolve: async () => unreachable() },
    gateContextResolver: { resolve: async () => unreachable() },
    ingestor: { ingestKey: () => unreachable(), ingest: async () => unreachable() },
    now: () => "2026-08-10T12:00:01.000Z",
  });
  if (result.tasksVisited !== 1 || result.skipped !== 1 || result.submissions !== 0
    || formatProductionUsdMicros(1) !== "<$0.01") {
    throw new Error("compiled production coordinator smoke failed");
  }
  console.log("NODE20_PRODUCTION_SMOKE_OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
