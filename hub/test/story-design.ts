// Story companion regression: strict schema, staged deterministic gates, derived assets and safe local read.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStoryStudioReadModel, deriveStoryAssets, parseStoryDesignManifest, readStoryDesign, validateStoryDesign,
  type StoryDesignManifest,
} from "../src/story-design.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => { console.log((condition ? "PASS " : "FAIL ") + message); if (!condition) fails++; };
const clone = <T>(value: T): T => structuredClone(value);
const manifest: StoryDesignManifest = {
  version: 1, kind: "writing-loop/story-design", title: "测试故事", sourcePlanId: null,
  parameters: { totalEpisodes: 6, maxPrimaryScenes: 2, maxNamedCharacters: 4, maxBeatGap: 2 },
  adaptation: { mode: "reimagine", core: "一个人发现自己熟悉的历史正在偏航。",
    keep: [], cut: [], merge: [], risks: [] },
  characters: [
    { id: "C01", name: "主角", tier: "lead", role: "主动调查历史偏航", arc: "从相信答案到相信证据", sourceRefs: [], firstEpisode: 1, lastEpisode: 6 },
    { id: "C02", name: "史官", tier: "support", role: "不可靠叙述者", arc: "从维护正史到保存矛盾", sourceRefs: [], firstEpisode: 1, lastEpisode: 6 },
  ],
  scenes: [
    { id: "S01", name: "档案厅", primary: true, variantOf: null, reusePlan: "未来线与过去线共享同一空间的时代变体", productionNotes: "固定几何与档案墙" },
    { id: "S02", name: "河港", primary: true, variantOf: null, reusePlan: "六集重复使用并改变天气与人流", productionNotes: "码头、闸门、票据视觉锚" },
  ],
  beats: [
    { id: "B01", episode: 1, weight: "major", label: "回忆开门", setup: "未来听证会出现空椅", payoff: "确认叙述者有所隐瞒" },
    { id: "B02", episode: 2, weight: "major", label: "第一次偏差", setup: "主角押注旧史", payoff: "公开记录与记忆不符" },
    { id: "B03", episode: 4, weight: "major", label: "历史失效", setup: "等待史载死讯", payoff: "本应死去的人活着走出门" },
    { id: "B04", episode: 6, weight: "major", label: "制度选择", setup: "预测引发挤兑", payoff: "主角改用可校验契约" },
  ],
  episodes: Array.from({ length: 6 }, (_, index) => {
    const number = index + 1; const beat = `B0${number <= 2 ? number : number <= 4 ? 3 : 4}`;
    return { number, arc: number <= 3 ? "入局" : "偏航", synopsis: `第${number}集通过公开证据推进主角的制度选择。`,
      hookType: (["H1", "H2", "H1", "H2", "H1", "H2"] as const)[index], hook: `一份证据在第${number}集结尾改变所有人的判断。`,
      suspense: `观众追问第${number}集的记录为何与记忆冲突。`, agency: "active" as const,
      beatIds: [beat], sceneIds: [number % 2 ? "S01" : "S02"], characterIds: ["C01", "C02"], crowdPlan: null };
  }),
};

const policy = { totalEpisodes: 6, maxPrimaryScenes: 2, maxNamedCharacters: 4, sourcePlanId: null };
const parsed = parseStoryDesignManifest(JSON.parse(JSON.stringify(manifest)));
const full = validateStoryDesign(parsed, policy, "full");
ok(full.every((row) => row.state === "pass"), "完整 fixture 通过所有确定性门，判断门明确保留给 Showrunner");
const beats = validateStoryDesign(parsed, policy, "beats");
ok(beats.filter((row) => row.stage === "full").every((row) => row.state === "skipped"), "阶段门把未到 full 的检查标为 skipped 而非伪绿");
const assets = deriveStoryAssets(parsed);
ok(assets.counts.characters === 2 && assets.counts.primaryScenes === 2 && assets.counts.beats === 4, "人物与场景清单由故事 manifest 确定性派生");

const badParams = clone(manifest); badParams.parameters.totalEpisodes = 7;
ok(validateStoryDesign(badParams, policy).find((row) => row.id === "S01")?.state === "fail", "配置漂移触发 S01");
const badScene = clone(manifest); badScene.scenes.push({ id: "S03", name: "只用一次", primary: true, variantOf: null, reusePlan: null, productionNotes: "昂贵新景" }); badScene.episodes[0].sceneIds.push("S03");
ok(validateStoryDesign(badScene, policy).find((row) => row.id === "S05")?.state === "fail", "超预算且一次性场景无复用计划触发 S05");
const badGap = clone(manifest); badGap.beats = badGap.beats.filter((row) => row.id !== "B02" && row.id !== "B03"); badGap.episodes.forEach((row) => { row.beatIds = row.beatIds.filter((id) => badGap.beats.some((beat) => beat.id === id)); });
ok(validateStoryDesign(badGap, policy).find((row) => row.id === "B02")?.state === "fail", "主节拍死区触发 B02");
const badEpisode = clone(manifest); badEpisode.episodes[1].number = 3;
ok(validateStoryDesign(badEpisode, policy).find((row) => row.id === "F01")?.state === "fail", "分集断号触发 F01");
const badHook = clone(manifest); badHook.episodes[1].hookType = "H1";
ok(validateStoryDesign(badHook, policy).find((row) => row.id === "F03")?.state === "fail", "相邻同钩型触发 F03");
const dialogue = clone(manifest); dialogue.episodes[0].hook = "主角：我知道你会死。";
ok(validateStoryDesign(dialogue, policy).find((row) => row.id === "F05")?.state === "fail", "结构字段提前写对白触发 F05");
let unknownRejected = false;
try { parseStoryDesignManifest({ ...manifest, secret: true }); } catch { unknownRejected = true; }
ok(unknownRejected, "strict parser 拒绝未知顶层字段");

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-story-design-")));
try {
  mkdirSync(join(tmp, ".writing-loop"), { recursive: true }); mkdirSync(join(tmp, "repo", "story"), { recursive: true });
  writeFileSync(join(tmp, ".writing-loop", "config.json"), JSON.stringify({ version: 1, projects: { demo: {
    title: "测试故事", repoPath: "repo", enabled: true, totalEpisodes: 6, maxPrimaryScenes: 2, maxNamedCharacters: 4,
  } } }, null, 2));
  writeFileSync(join(tmp, "repo", "story", "outline.v1.json"), JSON.stringify(manifest, null, 2));
  const config = JSON.parse(JSON.stringify({ version: 1, projects: { demo: { title: "测试故事", repoPath: "repo", enabled: true, totalEpisodes: 6, maxPrimaryScenes: 2, maxNamedCharacters: 4 } } }));
  ok(readStoryDesign(tmp, "demo", config)?.manifest.episodes.length === 6, "安全 exact reader 读取项目 companion");
  const studio = buildStoryStudioReadModel(tmp, "demo", config);
  ok(!studio.summary.readyForEpisodes && studio.gates.some((row) => row.id === "A00" && row.state === "fail")
    && studio.story?.assets.counts.episodes === 6,
  "只有大纲、没有结构化剧情资产图时 Studio fail-closed，不把半套事实源伪装成可写分集");
  writeFileSync(join(tmp, "repo", "story", "assets.v1.json"), "{\"version\":1,\"broken\":true}\n");
  const corruptAssets = buildStoryStudioReadModel(tmp, "demo", config);
  ok(corruptAssets.story?.manifest.episodes.length === 6
    && corruptAssets.gates.some((row) => row.id === "A01" && row.state === "fail"),
  "资产图损坏时保留可读大纲并单独把 A01 标红，不让整个 Story Studio 消失");
} finally { rmSync(tmp, { recursive: true, force: true }); }

console.log(fails === 0 ? "\nSTORY_DESIGN_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
