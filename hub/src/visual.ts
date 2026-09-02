// `writing-loop visual` — the parallel human keyframe-approval track (§4.7 审批点 1、§6.2).
//
// This surface never renders, never calls ComfyUI and never enqueues anything. It records one fact
// into `visual/production.v1.json`: a named reviewer approved or rejected a named candidate image at
// a canonical UTC instant. Only scenes in `keyframe-review` may be judged, and an already judged
// candidate is not re-openable here — approval is evidence, not a mutable field.
import { fileURLToPath } from "node:url";
import {
  readVisualProduction,
  reviewVisualCandidate,
  writeVisualProduction,
  VISUAL_PRODUCTION_RELATIVE_PATH,
  type VisualCandidateDecision,
} from "./visual-production.ts";
import {
  projectEntries,
  requireProjectEntry,
  requireWorkspace,
  resolveRepoPath,
  WsError,
} from "./workspace.ts";

function usage(): void {
  console.log(`writing-loop visual — 视觉制作清单的人工裁决面
用法:
  writing-loop visual approve-candidate --project KEY --candidate ID --by WHO [--reject] [--json]

只更新 ${VISUAL_PRODUCTION_RELATIVE_PATH} 中该候选图的 status/reviewedBy/reviewedAt。
只有 keyframe-review 阶段的场景可以裁决；已裁决的候选图不接受改判。
本命令不渲染、不连接 ComfyUI，也不会 enqueue 任何制片任务。`);
}

class VisualUsageError extends Error {}

type ApproveCandidateOptions = {
  project: string;
  candidate: string;
  by: string;
  decision: VisualCandidateDecision;
  json: boolean;
};

function parseApproveCandidateArgs(args: string[]): ApproveCandidateOptions {
  let project: string | null = null;
  let candidate: string | null = null;
  let by: string | null = null;
  let reject = false;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--project") {
      if (project !== null) throw new VisualUsageError("visual approve-candidate: --project 只能指定一次");
      project = args[++index] ?? null;
      if (!project) throw new VisualUsageError("visual approve-candidate: --project 需要项目 key");
    } else if (arg === "--candidate") {
      if (candidate !== null) throw new VisualUsageError("visual approve-candidate: --candidate 只能指定一次");
      candidate = args[++index] ?? null;
      if (!candidate) throw new VisualUsageError("visual approve-candidate: --candidate 需要候选图 ID");
    } else if (arg === "--by") {
      if (by !== null) throw new VisualUsageError("visual approve-candidate: --by 只能指定一次");
      by = args[++index] ?? null;
      if (!by) throw new VisualUsageError("visual approve-candidate: --by 需要审核人");
    } else if (arg === "--reject") {
      if (reject) throw new VisualUsageError("visual approve-candidate: --reject 只能指定一次");
      reject = true;
    } else if (arg === "--json") {
      if (json) throw new VisualUsageError("visual approve-candidate: --json 只能指定一次");
      json = true;
    } else {
      throw new VisualUsageError("visual approve-candidate: 未知参数");
    }
  }
  if (project === null || candidate === null || by === null) {
    throw new VisualUsageError("visual approve-candidate: 必须同时提供 --project、--candidate 与 --by");
  }
  return { project, candidate, by, decision: reject ? "rejected" : "approved", json };
}

export function visualMain(argv = process.argv.slice(2), cwd = process.cwd()): number {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h" || action === "help") { usage(); return 0; }
  if (!action) { usage(); return 2; }
  if (action !== "approve-candidate") {
    console.error("writing-loop visual: 未知操作");
    usage();
    return 2;
  }
  try {
    const options = parseApproveCandidateArgs(rest);
    const workspace = requireWorkspace(cwd);
    const entry = projectEntries(workspace.config).find(([key]) => key === options.project);
    if (!entry) throw new WsError(`没有项目 '${options.project}'`);
    const repo = resolveRepoPath(workspace.root, requireProjectEntry(entry[0], entry[1]));
    const visual = readVisualProduction(repo);
    if (visual === null) throw new WsError(`项目 '${options.project}' 尚无 ${VISUAL_PRODUCTION_RELATIVE_PATH}`);
    const reviewed = reviewVisualCandidate(visual.manifest, {
      candidateId: options.candidate,
      decision: options.decision,
      reviewedBy: options.by,
      reviewedAt: new Date().toISOString(),
    });
    const path = writeVisualProduction(repo, reviewed.manifest);
    if (options.json) {
      console.log(JSON.stringify({
        version: 1,
        path,
        sceneId: reviewed.sceneId,
        candidate: reviewed.candidate,
      }, null, 2));
    } else {
      console.log(`${reviewed.sceneId}/${reviewed.candidate.id} ${reviewed.candidate.status}`
        + ` · 由 ${reviewed.candidate.reviewedBy} 于 ${reviewed.candidate.reviewedAt} 裁决`);
      console.log(`已更新 ${path}（记得提交到剧本 repo）`);
    }
    return 0;
  } catch (error) {
    console.error(`writing-loop visual: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof VisualUsageError) { usage(); return 2; }
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(visualMain());
}
