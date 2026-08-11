// 编剧工作台的纯服务端视图。无外部前端依赖；所有动态文本先 esc，页面只渲染只读 DTO。
import type { ActivityEvent, ActivityPage } from "./activity.ts";
import type { IndexedActivityPage } from "./activity-index.ts";
import type { OnboardingPlan } from "./onboarding.ts";
import type { ProductionCoordinatorReadModel } from "./production-coordinator-read-model.ts";
import { formatProductionUsdMicros } from "./production-money.ts";
import type { ProductionReadModel } from "./production-read-model.ts";
import type { ProjectResource, ReportSummary } from "./project-detail.ts";
import type { ProjectSnapshot, WorkspaceSnapshot } from "./project-read-model.ts";
import type { StoryStudioReadModel } from "./story-design.ts";
import type { SystemProposalList } from "./system-inbox.ts";
import type { Ticket } from "./status.ts";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (char) => ESC[char]);
const enc = (value: string): string => encodeURIComponent(value);
const at = (base: string, path: string): string => `${base}${path}`;

const STATE_LABEL: Record<string, string> = {
  Backlog: "灵感池",
  Todo: "待落笔",
  "In Progress": "创作中",
  "In Review": "审读中",
  Done: "已定稿",
  Canceled: "已搁置",
  Duplicate: "已归并",
  "?": "待修复",
};

const AGENT_LABEL: Record<string, string> = {
  showrunner: "总编剧",
  "story-designer": "故事设计",
  "episode-writer": "分集编剧",
  reviewer: "审读",
  evaluator: "里程碑评估",
  sweep: "制片巡检",
  "script-doctor": "剧本医生",
  "market-watch": "市场观察",
  reflect: "复盘",
};

const FORMAT_LABEL: Record<string, string> = {
  "live-action": "真人短剧",
  "ai-anime": "AI 漫剧",
  "reelshort-en": "海外短剧",
};

const ACTIVITY_LABEL: Record<string, string> = {
  "project.created": "立项",
  "project.paused": "暂停",
  "project.resumed": "恢复",
  "fire.completed": "Agent 完成",
  "fire.failed": "Agent 失败",
  "fire.timed-out": "Agent 超时",
  "fire.noop": "巡检无改动",
  "fire.blocked": "Agent 未启动",
  "ticket.discovered": "任务现状",
  "ticket.commented": "任务交接",
  "ticket.state-changed": "任务流转",
  "episode.discovered": "分集版本",
  "document.discovered": "剧情文档",
  "report.discovered": "创作报告",
  "report.reviewed": "操作者点评",
  "evaluation.discovered": "里程碑评估",
};

const PRODUCTION_STATUS_LABEL: Record<string, string> = {
  planned: "待排产",
  "dispatch-pending": "等待派发",
  submitting: "提交中",
  submitted: "已提交",
  running: "生成中",
  ingesting: "素材入库中",
  "qc-pending": "等待 QC",
  approved: "已通过",
  rejected: "已退回",
  "submission-unknown": "提交结果未知",
  failed: "生成失败",
  "cancel-requested": "取消确认中",
  cancelled: "已取消",
  orphaned: "远端孤儿任务",
};

const PRODUCTION_COST_REASON: Record<string, string> = {
  "not-recorded": "未记录",
  "provider-not-reported": "服务方未回报",
  "in-flight": "任务尚未完成",
  unavailable: "账单暂不可用",
  "legacy-record": "旧记录无成本",
};

export type ProjectPageExtras = {
  activity?: ActivityPage | IndexedActivityPage;
  reports?: ReportSummary[];
  evaluations?: ReportSummary[];
  production?: ProductionReadModel;
  productionControl?: ProductionCoordinatorReadModel;
  story?: StoryStudioReadModel;
};

const relTime = (iso: string | null, nowMs = Date.now()): string => {
  if (!iso) return "尚无活动";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "时间未知";
  const minutes = Math.max(0, Math.floor((nowMs - time) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} 天前` : new Date(time).toLocaleDateString("zh-CN");
};

const pct = (value: number | null): string => value === null ? "—" : `${value}%`;
const format = (project: ProjectSnapshot): string => FORMAT_LABEL[project.format ?? ""] ?? project.format ?? "待定义形态";

export const STYLE = `
:root{
  color-scheme:light dark;
  --paper:#efeadd;--paper-hi:#fbf8ef;--paper-low:#e5ddcc;--ink:#211f1b;--ink-2:#504b42;
  --muted:#7a7163;--line:#cfc5b2;--line-strong:#a99c86;--accent:#b33a2f;--accent-deep:#81251f;
  --jade:#327267;--gold:#a7731a;--blue:#355f80;--shadow:0 18px 50px rgba(54,43,25,.12);
  --display:Baskerville,"Iowan Old Style","Songti SC","STSong",serif;
  --body:"Avenir Next","PingFang SC","Microsoft YaHei",sans-serif;
  --mono:"SFMono-Regular","Cascadia Mono",monospace;
}
*{box-sizing:border-box}
html{min-height:100%;background:var(--paper)}
body{margin:0;min-height:100vh;color:var(--ink);font:15px/1.65 var(--body);letter-spacing:.01em;
  background:
    radial-gradient(circle at 82% 4%,color-mix(in srgb,var(--gold) 12%,transparent),transparent 28rem),
    repeating-linear-gradient(0deg,transparent 0 31px,color-mix(in srgb,var(--ink) 3%,transparent) 31px 32px),
    var(--paper)}
body:before{content:"";position:fixed;z-index:4;left:34px;top:0;bottom:0;width:1px;background:color-mix(in srgb,var(--accent) 52%,transparent);pointer-events:none}
a{color:inherit}button,input{font:inherit}
.shell{width:min(1460px,calc(100% - 72px));margin:0 auto;padding:24px 0 64px}
.topbar{display:flex;align-items:center;gap:22px;min-height:60px;border-bottom:1px solid var(--line);position:relative}
.brand{text-decoration:none;display:flex;align-items:baseline;gap:10px}.brand b{font:700 17px/1 var(--display);letter-spacing:.18em}.brand small{font:10px/1 var(--mono);color:var(--accent);letter-spacing:.12em;text-transform:uppercase}
.crumb{color:var(--muted);font-size:12px;text-decoration:none}.crumb:hover{color:var(--accent)}
.live{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.live:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--jade);box-shadow:0 0 0 5px color-mix(in srgb,var(--jade) 13%,transparent);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{50%{opacity:.45;transform:scale(.85)}}
.eyebrow{display:flex;align-items:center;gap:12px;color:var(--accent);font:700 11px/1.2 var(--mono);letter-spacing:.12em;text-transform:uppercase}.eyebrow:before{content:"";width:28px;height:1px;background:currentColor}
.hero{padding:62px 0 38px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:50px;align-items:end}
.hero h1{font:600 clamp(44px,6vw,92px)/.96 var(--display);letter-spacing:-.045em;margin:12px 0 16px;max-width:900px;text-wrap:balance}
.hero p{max-width:720px;color:var(--ink-2);font-size:16px;margin:0}.hero-stamp{width:128px;height:128px;border:1px solid var(--accent);border-radius:50%;display:grid;place-content:center;text-align:center;color:var(--accent);transform:rotate(7deg);font:700 12px/1.4 var(--mono);letter-spacing:.08em;box-shadow:inset 0 0 0 7px var(--paper),inset 0 0 0 8px var(--accent)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);background:color-mix(in srgb,var(--paper-hi) 72%,transparent);box-shadow:var(--shadow);margin-bottom:42px}
.stat{padding:21px 24px;border-right:1px solid var(--line)}.stat:last-child{border:0}.stat strong{display:block;font:600 32px/1 var(--display);font-variant-numeric:tabular-nums}.stat span{display:block;margin-top:7px;color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.section-head{display:flex;align-items:end;gap:18px;margin:36px 0 18px}.section-head h2{font:600 29px/1.1 var(--display);margin:0}.section-head p{color:var(--muted);margin:0 0 2px;font-size:13px}.section-head .count{margin-left:auto;color:var(--muted);font:12px var(--mono)}
.library{display:grid;grid-template-columns:repeat(12,1fr);gap:18px}
.workspace-card{grid-column:span 6;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:22px;min-height:230px;padding:28px;background:var(--paper-hi);border:1px solid var(--line);box-shadow:0 10px 32px rgba(45,34,20,.08);text-decoration:none;transition:.24s ease}.workspace-card:hover{transform:translateY(-3px);border-color:var(--accent)}.workspace-card h3{font:600 31px/1.08 var(--display);margin:8px 0}.workspace-card p{color:var(--muted);margin:0}.workspace-card .workspace-folio{align-self:end;text-align:right}.workspace-card .workspace-folio b{display:block;font:600 48px/1 var(--display);color:var(--accent)}.workspace-card.degraded{grid-column:span 4;filter:saturate(.45)}
.project-card{grid-column:span 4;position:relative;min-height:310px;padding:29px 28px 25px;background:var(--paper-hi);border:1px solid var(--line);box-shadow:0 10px 32px rgba(45,34,20,.08);text-decoration:none;overflow:hidden;transition:.24s ease}
.project-card:before{content:"";position:absolute;top:-1px;left:24px;width:84px;height:8px;background:var(--accent)}
.project-card:after{content:attr(data-index);position:absolute;right:20px;bottom:-22px;color:color-mix(in srgb,var(--ink) 5%,transparent);font:700 98px/1 var(--display);pointer-events:none}
.project-card:hover{transform:translateY(-4px) rotate(-.25deg);border-color:var(--line-strong);box-shadow:var(--shadow)}
.project-card.paused{filter:saturate(.45);opacity:.72}.project-card .meta{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:32px}.chip{border:1px solid var(--line);border-radius:99px;padding:2px 9px;color:var(--muted);font-size:10px;letter-spacing:.05em}.chip.live{margin-left:0;color:var(--jade);border-color:color-mix(in srgb,var(--jade) 45%,var(--line))}.chip.live:before{width:5px;height:5px;box-shadow:none;animation:none}.chip.warn{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.project-card h3{font:600 29px/1.12 var(--display);margin:0 0 11px;letter-spacing:-.02em}.logline{color:var(--ink-2);min-height:54px;margin:0 0 28px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.progress{height:4px;background:var(--paper-low);overflow:hidden}.progress i{display:block;height:100%;background:var(--accent)}
.progress-row{display:flex;align-items:baseline;gap:8px;margin-top:10px;color:var(--muted);font-size:12px}.progress-row b{font:600 22px var(--display);color:var(--ink)}.progress-row .right{margin-left:auto}
.attention-strip{margin-top:26px;display:flex;gap:10px;align-items:center;color:var(--accent);font-size:12px}.attention-strip:before{content:"!";width:20px;height:20px;border:1px solid currentColor;border-radius:50%;display:grid;place-items:center;font:700 11px var(--mono)}
.project-hero{padding:50px 0 34px;display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:45px;align-items:end}.project-hero h1{font:600 clamp(44px,6vw,78px)/.98 var(--display);letter-spacing:-.04em;margin:10px 0 14px}.project-hero .logline{font:18px/1.6 var(--display);max-width:760px;min-height:0;-webkit-line-clamp:3}.folio{text-align:right;border-left:1px solid var(--line);padding-left:34px}.folio strong{font:600 82px/.85 var(--display);color:var(--accent);font-variant-numeric:tabular-nums}.folio span{display:block;color:var(--muted);margin-top:9px;font:11px var(--mono);letter-spacing:.1em}.folio .mini-progress{height:3px;background:var(--line);margin-top:18px}.folio .mini-progress i{display:block;height:100%;background:var(--accent)}
.workspace-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(320px,.75fr);gap:20px;align-items:start;min-width:0}.workspace-grid>*{min-width:0}.stack{display:grid;gap:20px;min-width:0}
.panel{min-width:0;background:color-mix(in srgb,var(--paper-hi) 84%,transparent);border:1px solid var(--line);padding:24px;box-shadow:0 8px 26px rgba(45,34,20,.06)}.panel h2{font:600 24px/1.2 var(--display);margin:0}.panel-head{display:flex;align-items:center;gap:12px;margin-bottom:20px}.panel-head p{margin:0;color:var(--muted);font-size:12px}.panel-head .aside{margin-left:auto;color:var(--muted);font:11px var(--mono)}
.spine{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.spine-item{min-height:104px;padding:16px;border:1px solid var(--line);position:relative;background:var(--paper-hi)}.spine-item b{display:block;font:600 17px var(--display)}.spine-item span{color:var(--muted);font-size:11px}.spine-item:after{content:"";position:absolute;left:15px;right:15px;bottom:12px;height:3px;background:var(--line)}.spine-item.ok:after{background:var(--jade)}.spine-item.warn:after{background:var(--gold)}
.lanes{display:grid;width:100%;max-width:100%;grid-template-columns:repeat(4,minmax(210px,1fr));gap:10px;overflow-x:auto}.lane{background:var(--paper-low);padding:13px;min-height:180px}.lane h3{display:flex;align-items:center;gap:8px;margin:0 0 12px;font:700 11px var(--mono);letter-spacing:.08em;color:var(--muted);text-transform:uppercase}.lane h3 i{width:7px;height:7px;border-radius:50%;background:var(--state,var(--muted))}.lane h3 span{margin-left:auto;font-weight:400}.task{display:block;background:var(--paper-hi);border:1px solid var(--line);padding:13px;margin-bottom:8px;text-decoration:none}.task:hover{border-color:var(--accent)}.task-id{display:flex;gap:8px;color:var(--muted);font:10px var(--mono)}.task-id .ep{margin-left:auto;color:var(--accent)}.task b{display:block;margin-top:6px;font:600 14px/1.35 var(--display)}.task-labels{display:flex;gap:4px;flex-wrap:wrap;margin-top:9px}.task-labels em{font-style:normal;color:var(--muted);font-size:9px;border-bottom:1px solid var(--line)}.lane-empty{color:var(--muted);font:12px var(--display);padding:12px 4px}
.room-live{display:flex;align-items:center;gap:12px;padding:15px;border:1px solid color-mix(in srgb,var(--jade) 35%,var(--line));background:color-mix(in srgb,var(--jade) 7%,var(--paper-hi));margin-bottom:14px}.room-live .orb{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:var(--jade);color:white;font:700 11px var(--mono)}.room-live b{display:block}.room-live span{color:var(--muted);font-size:11px}.room-off{color:var(--muted);padding:12px 0;border-bottom:1px solid var(--line)}
.agent-list{display:grid;gap:1px;background:var(--line)}.agent{display:grid;grid-template-columns:1fr auto;gap:12px;padding:11px 13px;background:var(--paper-hi)}.agent b{font:600 13px var(--display)}.agent small{display:block;color:var(--muted);font:10px var(--mono)}.agent .rate{font:11px var(--mono);color:var(--muted);align-self:center}
.episode-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.episode{display:block;min-height:124px;padding:15px;border:1px solid var(--line);background:var(--paper-hi);position:relative;overflow:hidden;text-decoration:none}.episode:hover{border-color:var(--accent)}.episode .num{font:600 28px/1 var(--display);color:var(--accent)}.episode b{display:block;margin-top:10px;font:600 13px/1.35 var(--display)}.episode small{color:var(--muted);font:10px var(--mono)}
.doc-list{display:grid;gap:0}.doc-row{display:grid;grid-template-columns:22px 1fr auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);text-decoration:none}.doc-row:last-child{border:0}.doc-row[href]:hover b{color:var(--accent)}.doc-mark{width:13px;height:13px;border:1px solid var(--line-strong);transform:rotate(45deg)}.doc-row.ok .doc-mark{background:var(--jade);border-color:var(--jade)}.doc-row b{font:600 13px var(--display)}.doc-row small{display:block;color:var(--muted);font:10px var(--mono)}.doc-row>span:last-child{font:10px var(--mono);color:var(--muted)}
.notice-list{display:grid;gap:8px}.notice-item{padding:13px 14px;border-left:3px solid var(--accent);background:color-mix(in srgb,var(--accent) 7%,var(--paper-hi))}.notice-item b{display:block;font:600 14px var(--display)}.notice-item span{color:var(--muted);font:10px var(--mono)}
.system-desk{margin-top:42px;padding:28px;border:1px solid var(--line);background:linear-gradient(120deg,color-mix(in srgb,var(--blue) 8%,var(--paper-hi)),var(--paper-hi));display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:center}.system-desk h2{font:600 27px/1.15 var(--display);margin:6px 0}.system-desk p{margin:0;color:var(--ink-2);max-width:760px}.system-count{text-align:right}.system-count b{display:block;color:var(--blue);font:600 48px/1 var(--display)}.system-count span{font:10px var(--mono);color:var(--muted);letter-spacing:.08em}.system-proposals{display:grid;gap:12px}.system-proposal{padding:20px;border:1px solid var(--line);background:var(--paper-hi);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px}.system-proposal.open{border-left:4px solid var(--gold)}.system-proposal.applied{border-left:4px solid var(--jade)}.system-proposal.dismissed{border-left:4px solid var(--muted)}.system-proposal h3{font:600 20px/1.25 var(--display);margin:5px 0 8px}.system-proposal p{margin:0 0 10px;color:var(--ink-2)}.system-proposal small{color:var(--muted);font:10px var(--mono)}.system-proposal-state{text-align:right}.system-proposal-state b{display:block;font:700 10px var(--mono);letter-spacing:.08em}.system-proposal-state time{display:block;color:var(--muted);font:9px var(--mono);margin-top:4px}
.empty{padding:26px;border:1px dashed var(--line-strong);color:var(--muted);text-align:center;font-family:var(--display)}
.toolbar{display:flex;align-items:center;gap:10px;margin:20px 0}.btn{border:1px solid var(--line-strong);background:var(--paper-hi);color:var(--ink);padding:7px 13px;cursor:pointer;text-decoration:none;font-size:12px}.btn:hover{border-color:var(--accent);color:var(--accent)}.btn.danger{color:var(--accent)}
.timeline{display:grid}.event{display:grid;grid-template-columns:94px 12px minmax(0,1fr);gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}.event:last-child{border:0}.event time{font:10px var(--mono);color:var(--muted);padding-top:3px}.event .pin{width:9px;height:9px;border:2px solid var(--paper-hi);border-radius:50%;background:var(--blue);box-shadow:0 0 0 1px var(--line-strong);margin-top:5px}.event.failed .pin{background:var(--accent)}.event.succeeded .pin{background:var(--jade)}.event.blocked .pin{background:var(--gold)}.event b{font:600 13px var(--display)}.event p{margin:2px 0;color:var(--ink-2);font-size:12px}.event small{display:block;color:var(--muted);font:10px var(--mono)}.event a{text-decoration:none}.event a:hover b{color:var(--accent)}
.usage-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);margin-bottom:12px}.usage-strip div{background:var(--paper-hi);padding:10px}.usage-strip b{display:block;font:600 19px var(--display)}.usage-strip span{font:9px var(--mono);color:var(--muted)}
.production-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);margin-bottom:14px}.production-summary div{background:var(--paper-hi);padding:11px}.production-summary b{display:block;font:600 19px var(--display)}.production-summary span{font:9px var(--mono);color:var(--muted)}
.production-list{display:grid;gap:9px}.production-task{padding:14px;border:1px solid var(--line);background:var(--paper-hi)}.production-task.attention{border-left:3px solid var(--accent)}.production-task.done{border-left:3px solid var(--jade)}.production-task-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:start}.production-task-head b{font:600 14px var(--display);overflow-wrap:anywhere}.production-task-head small{display:block;color:var(--muted);font:9px var(--mono);margin-top:2px;overflow-wrap:anywhere}.production-state{text-align:right}.production-state strong{display:block;font:700 10px var(--mono);color:var(--ink-2)}.production-state span{display:block;color:var(--muted);font:9px var(--mono);margin-top:2px}.production-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:10px}.production-fact{padding:7px 8px;background:var(--paper-low);min-width:0}.production-fact b{display:block;font:600 11px var(--display);overflow-wrap:anywhere}.production-fact span{display:block;color:var(--muted);font:8px var(--mono);text-transform:uppercase}.production-message{margin:9px 0 0;color:var(--ink-2);font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.production-approval{margin-top:9px;padding:8px 10px;border-left:2px solid var(--jade);background:color-mix(in srgb,var(--jade) 6%,var(--paper-hi));font-size:10px;overflow-wrap:anywhere}.production-approval.rejected{border-color:var(--accent)}
.report-list{display:grid;gap:7px}.report-link{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--line);text-decoration:none}.report-link:hover{border-color:var(--accent)}.report-link b{font:600 12px var(--display)}.report-link small{margin-left:auto;color:var(--muted);font:9px var(--mono)}
.form-card{max-width:1040px;margin:38px auto 0}.form-intro{padding:38px 0 24px}.form-intro h1{font:600 clamp(38px,6vw,70px)/1 var(--display);margin:8px 0 12px}.form-intro p{max-width:760px;color:var(--ink-2)}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.field{display:grid;gap:6px}.field.wide{grid-column:1/-1}.field label{font:700 10px var(--mono);letter-spacing:.08em;color:var(--muted);text-transform:uppercase}.field input,.field select,.field textarea{width:100%;border:1px solid var(--line-strong);background:var(--paper-hi);color:var(--ink);padding:10px 11px;border-radius:0}.field textarea{min-height:92px;resize:vertical}.field textarea.long{min-height:220px;line-height:1.75}.field small{color:var(--muted);font-size:10px}.form-section{grid-column:1/-1;border-top:1px solid var(--line);padding-top:18px;margin-top:8px}.form-section h2{font:600 22px var(--display);margin:0 0 4px}.form-section.source-intake{padding:20px;background:color-mix(in srgb,var(--jade) 6%,var(--paper-hi));border:1px solid color-mix(in srgb,var(--jade) 42%,var(--line));margin-top:12px}.check{display:flex;align-items:flex-start;gap:9px}.check input{width:auto;margin-top:5px}.confirm-box{padding:22px;border:1px solid var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--paper-hi))}.plan-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.plan-item{padding:14px;border:1px solid var(--line);background:var(--paper-hi)}.plan-item b{display:block;font:600 13px var(--display)}.plan-item small{color:var(--muted);font:10px var(--mono);overflow-wrap:anywhere}.warning-list{color:var(--accent)}
.onboarding-contract{display:grid;grid-template-columns:1fr 1fr;gap:0;margin:0 0 22px;padding:0;overflow:hidden}.onboarding-contract article{padding:20px 22px}.onboarding-contract article+article{border-left:1px solid var(--line)}.onboarding-contract h2{font:600 20px var(--display);margin:0 0 8px}.onboarding-contract p{margin:0;color:var(--ink-2)}
.detail-hero{padding:44px 0 24px}.detail-hero h1{font:600 clamp(34px,5vw,62px)/1.05 var(--display);margin:9px 0}.detail-meta{display:flex;gap:8px;flex-wrap:wrap}.markdown{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:13px/1.75 var(--body);color:var(--ink-2)}.detail-sections{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.detail-section{padding:18px;border:1px solid var(--line);background:var(--paper-hi)}.detail-section h3{font:600 17px var(--display);margin:0 0 10px}.comments{display:grid;gap:9px}.comment{padding:13px;border-left:2px solid var(--blue);background:var(--paper-hi)}.comment b{font:600 12px var(--display)}.comment time{margin-left:8px;color:var(--muted);font:9px var(--mono)}.comment p{white-space:pre-wrap;margin:7px 0 0;color:var(--ink-2);font-size:12px}
.path{color:var(--muted);font:10px/1.5 var(--mono);overflow-wrap:anywhere}.footer{margin-top:46px;padding-top:18px;border-top:1px solid var(--line);display:flex;gap:14px;color:var(--muted);font-size:10px}.footer .path{margin-left:auto;text-align:right}
.project-nav{position:sticky;top:0;z-index:3;display:flex;gap:4px;overflow:auto;padding:10px;margin:0 0 22px;border:1px solid var(--line);background:color-mix(in srgb,var(--paper-hi) 94%,transparent);backdrop-filter:blur(14px);box-shadow:0 8px 24px rgba(45,34,20,.06)}
.project-nav a{white-space:nowrap;padding:8px 12px;border-radius:2px;color:var(--muted);font:700 11px var(--mono);letter-spacing:.03em;text-decoration:none}.project-nav a:hover,.project-nav a.active{color:var(--paper-hi);background:var(--ink)}
.creative-cockpit{display:grid;grid-template-columns:1.2fr repeat(3,minmax(0,.6fr));gap:1px;border:1px solid var(--line);background:var(--line);margin-bottom:20px}.creative-cockpit>div{padding:20px;background:var(--paper-hi)}.creative-cockpit b{display:block;font:600 29px var(--display)}.creative-cockpit span{display:block;color:var(--muted);font-size:11px}.creative-cockpit .next{background:var(--ink);color:var(--paper-hi)}.creative-cockpit .next span{color:color-mix(in srgb,var(--paper-hi) 68%,transparent)}
.atlas-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.38fr);gap:18px}.source-progress{height:9px;background:var(--paper-low);overflow:hidden;margin:15px 0}.source-progress i{display:block;height:100%;background:linear-gradient(90deg,var(--jade),var(--gold))}.chunk-map{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:7px}.chunk{min-height:70px;padding:9px;border:1px solid var(--line);background:var(--paper-hi)}.chunk b{font:10px var(--mono)}.chunk span{display:block;margin-top:6px;color:var(--muted);font-size:9px;line-height:1.35}.chunk.selected{border-color:var(--gold)}.chunk.done{background:color-mix(in srgb,var(--jade) 10%,var(--paper-hi));border-color:var(--jade)}
.episode-atlas{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}.episode-beat{min-height:180px;padding:16px;border:1px solid var(--line);background:var(--paper-hi);position:relative}.episode-beat:before{content:attr(data-episode);position:absolute;right:10px;top:4px;color:color-mix(in srgb,var(--ink) 8%,transparent);font:700 52px var(--display)}.episode-beat h3{position:relative;margin:0 0 22px;font:600 17px var(--display)}.episode-beat p{position:relative;color:var(--ink-2);font-size:12px}.episode-beat small{position:relative;color:var(--accent);font:10px var(--mono)}
.decision-grid,.cast-grid,.art-grid,.gate-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.dossier{padding:18px;border:1px solid var(--line);background:var(--paper-hi)}.dossier h3{font:600 20px var(--display);margin:0 0 8px}.dossier p{color:var(--ink-2);margin:7px 0}.dossier small{color:var(--muted);font:10px var(--mono)}.dossier .tier{float:right;color:var(--accent);font:700 9px var(--mono);letter-spacing:.08em}.dossier.inferred{border-style:dashed}.dossier.primary{border-top:5px solid var(--accent)}
.timeline-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.timeline-rail{border-left:2px solid var(--ink);padding-left:16px}.timeline-rail h2{margin:0 0 14px;font:600 20px var(--display)}.timeline-event{position:relative;margin:0 0 12px;padding:14px;border:1px solid var(--line);background:var(--paper-hi)}.timeline-event:before{content:"";position:absolute;left:-22px;top:19px;width:9px;height:9px;border-radius:50%;background:var(--accent);border:2px solid var(--paper)}.timeline-event h3{margin:2px 0 6px;font:600 17px var(--display)}.timeline-event p{margin:6px 0;color:var(--ink-2);font-size:12px}.timeline-event small{font:10px var(--mono);color:var(--muted)}.asset-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:9px}.asset-tags span{padding:3px 6px;background:var(--paper);border:1px solid var(--line);font:9px var(--mono)}
.gate{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;padding:15px;border:1px solid var(--line);background:var(--paper-hi)}.gate-state{width:70px;text-align:center;padding:5px 7px;align-self:start;font:700 9px var(--mono);letter-spacing:.08em;border:1px solid var(--line)}.gate.pass .gate-state{color:var(--jade);border-color:var(--jade)}.gate.fail .gate-state{color:var(--accent);border-color:var(--accent)}.gate.skipped .gate-state{color:var(--gold);border-color:var(--gold)}.gate h3{font:600 15px var(--display);margin:0}.gate p{color:var(--muted);margin:4px 0 0;font-size:11px}
.section-hero{padding:42px 0 26px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:25px;align-items:end}.section-hero h1{font:600 clamp(38px,5vw,66px)/1 var(--display);margin:8px 0}.section-hero p{max-width:720px;color:var(--ink-2)}.section-kpi{text-align:right}.section-kpi b{display:block;font:600 54px var(--display);color:var(--accent)}.section-kpi span{color:var(--muted);font:10px var(--mono)}
.reveal{animation:reveal .55s cubic-bezier(.2,.75,.2,1) both}.reveal:nth-child(2){animation-delay:.06s}.reveal:nth-child(3){animation-delay:.12s}.reveal:nth-child(4){animation-delay:.18s}@keyframes reveal{from{opacity:0;transform:translateY(10px)}}
@media(max-width:1050px){.project-card,.workspace-card{grid-column:span 6}.workspace-grid,.atlas-grid{grid-template-columns:1fr}.project-hero{grid-template-columns:1fr 200px}.spine{grid-template-columns:repeat(2,1fr)}.creative-cockpit{grid-template-columns:repeat(2,1fr)}}
@media(max-width:720px){body:before{left:12px}.shell{width:calc(100% - 32px);padding-top:10px}.topbar{gap:10px}.brand small,.crumb{display:none}.hero{grid-template-columns:1fr;padding-top:40px}.hero-stamp{display:none}.stats{grid-template-columns:repeat(2,1fr)}.stat:nth-child(2){border-right:0}.stat:nth-child(-n+2){border-bottom:1px solid var(--line)}.section-head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:8px 12px}.section-head h2,.section-head p{grid-column:1}.section-head .count{display:none}.section-head .btn{grid-column:2;grid-row:1/3;margin:0}.project-card,.workspace-card{grid-column:1/-1}.workspace-card{grid-template-columns:1fr}.workspace-card .workspace-folio{text-align:left}.project-hero,.section-hero{grid-template-columns:1fr}.section-kpi{text-align:left}.folio{text-align:left;border-left:0;border-top:1px solid var(--line);padding:22px 0 0}.folio strong{font-size:60px}.lanes{grid-template-columns:repeat(4,245px)}.episode-strip{grid-template-columns:repeat(2,1fr)}.spine,.creative-cockpit,.decision-grid,.cast-grid,.art-grid,.gate-grid,.onboarding-contract{grid-template-columns:1fr}.onboarding-contract article+article{border-left:0;border-top:1px solid var(--line)}.form-grid,.detail-sections,.plan-grid{grid-template-columns:1fr}.field.wide,.form-section{grid-column:auto}.event{grid-template-columns:70px 10px minmax(0,1fr)}.usage-strip{grid-template-columns:1fr}.production-summary{grid-template-columns:repeat(2,1fr)}.production-facts{grid-template-columns:1fr}.footer{display:block}.footer .path{text-align:left;margin-top:8px}}
@media(max-width:720px){.timeline-grid{grid-template-columns:1fr}}
@media(prefers-color-scheme:dark){:root{--paper:#171714;--paper-hi:#22211d;--paper-low:#11110f;--ink:#eee8da;--ink-2:#c5bcac;--muted:#968e80;--line:#3d3931;--line-strong:#61594c;--accent:#e45b4e;--accent-deep:#ff8175;--jade:#62a99a;--gold:#d8a44e;--blue:#6d9cc0;--shadow:0 18px 50px rgba(0,0,0,.28)}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
`;

export const LIVE_SCRIPT = `(()=>{let seen="",pending=false;const typing=()=>{const e=document.activeElement;return e&&/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)};const endpoint=document.body.dataset.stream||"/api/stream";const es=new EventSource(endpoint);es.onmessage=e=>{if(!seen){seen=e.data;return}if(e.data===seen)return;seen=e.data;if(typing()){pending=true;return}location.reload()};document.addEventListener("focusout",()=>{if(pending&&!typing())location.reload()});const kind=document.querySelector("#kind");const syncKind=()=>{if(!kind)return;const adaptation=kind.value==="adaptation";document.querySelectorAll("[data-adaptation-only]").forEach(el=>{el.hidden=!adaptation;el.querySelectorAll("[data-required-for-kind]").forEach(input=>input.required=adaptation)});document.querySelectorAll("[data-original-only]").forEach(el=>{el.hidden=adaptation;el.querySelectorAll("[data-required-for-kind]").forEach(input=>input.required=!adaptation)})};if(kind){kind.addEventListener("change",syncKind);syncKind()}const money=document.querySelector("#monetization");const syncMoney=()=>{if(!money)return;const paid=money.value==="paid-app";[["card1","9,10,11"],["card2","26,28,30"],["card3","60"]].forEach(([id,value])=>{const input=document.querySelector("#"+id);if(!input)return;if(paid&&!input.value)input.value=value;if(!paid)input.value=""})};if(money){money.addEventListener("change",syncMoney);syncMoney()}})();`;
const liveScript = `<script>${LIVE_SCRIPT}</script>`;

export type FleetWorkspaceView = {
  id: string;
  label: string;
  root: string;
  status: "ready" | "missing" | "invalid";
  snapshot: WorkspaceSnapshot | null;
  error: string | null;
};

export function fleetPage(workspaces: FleetWorkspaceView[], generatedAt = new Date().toISOString()): string {
  const ready = workspaces.filter((workspace) => workspace.snapshot !== null);
  const totals = ready.reduce((sum, workspace) => {
    sum.projects += workspace.snapshot!.projectCount;
    sum.episodes += workspace.snapshot!.totals.episodes;
    sum.decisions += workspace.snapshot!.totals.needsAttention;
    sum.agents += workspace.snapshot!.totals.runningAgents;
    return sum;
  }, { projects: 0, episodes: 0, decisions: 0, agents: 0 });
  const cards = workspaces.length ? workspaces.map((workspace) => {
    const snapshot = workspace.snapshot;
    if (!snapshot) return `<article class="workspace-card degraded reveal"><div><div class="eyebrow">${esc(workspace.status)}</div><h3>${esc(workspace.label)}</h3><p>${esc(workspace.error ?? "工作区当前不可读；registry 指针仍被保留。")}</p><div class="path">${esc(workspace.root)}</div></div><div class="workspace-folio"><b>—</b><span class="chip warn">需要检查</span></div></article>`;
    return `<a class="workspace-card reveal" href="/w/${enc(workspace.id)}/"><div><div class="eyebrow">Workspace · ${esc(workspace.id.slice(-8))}</div><h3>${esc(workspace.label)}</h3><p>${snapshot.enabledProjectCount} 部正在创作 · ${snapshot.totals.openTasks} 项开放任务${snapshot.totals.needsAttention ? ` · ${snapshot.totals.needsAttention} 项等待决定` : ""}</p><div class="path">${esc(workspace.root)}</div></div><div class="workspace-folio"><b>${snapshot.projectCount}</b><span>部在库作品</span></div></a>`;
  }).join("") : `<div class="empty" style="grid-column:1/-1">还没有登记工作区。请在目标目录运行 <code>writing-loop init</code>，或使用 <code>writing-loop workspace add DIR</code>。</div>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>创作总台 · writing-loop</title><style>${STYLE}</style></head><body data-stream="/api/stream"><main class="shell">
  <header class="topbar"><a class="brand" href="/"><b>WRITING / LOOP</b><small>Production library</small></a><span class="live">多工作区实时投影</span></header>
  <section class="hero"><div><div class="eyebrow">Local story constellation</div><h1>所有故事，各有自己的房间。</h1><p>总台只保存工作区指针；剧本正文、看板与历史仍留在各自目录。选择一间编剧室，再进入它的作品书架。</p></div><div class="hero-stamp">LOCAL<br>STORY<br>MAP</div></section>
  <section class="stats reveal"><div class="stat"><strong>${ready.length}</strong><span>可用工作区</span></div><div class="stat"><strong>${totals.projects}</strong><span>在库作品</span></div><div class="stat"><strong>${totals.episodes}</strong><span>已完成分集</span></div><div class="stat"><strong>${totals.decisions}</strong><span>等待你的决定</span></div></section>
  <div class="section-head"><h2>创作工作区</h2><p>${workspaces.length - ready.length ? `${workspaces.length - ready.length} 个指针需要检查` : `${totals.agents} 名 Agent 正在工作`}</p><span class="count">registry 是可重建的本机索引</span></div><section class="library">${cards}</section>
  <footer class="footer"><span>writing-loop fleet studio</span><span>更新于 ${esc(new Date(generatedAt).toLocaleString("zh-CN"))}</span><span class="path">workspace 数据不会复制到 registry</span></footer>
  </main>${liveScript}</body></html>`;
}

function shell(title: string, body: string, snapshot: WorkspaceSnapshot, project?: ProjectSnapshot, base = ""): string {
  const home = at(base, "/");
  const projectCrumb = project ? `<a class="crumb" href="${esc(home)}">作品书架</a><span class="crumb">/</span><span class="crumb">${esc(project.key)}</span>` : base ? `<a class="crumb" href="/">全部工作区</a>` : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)} · writing-loop</title><style>${STYLE}</style></head><body data-stream="${esc(at(base, "/api/stream"))}"><main class="shell">
  <header class="topbar"><a class="brand" href="${esc(home)}"><b>WRITING / LOOP</b><small>Writers' room</small></a>${projectCrumb}<span class="live">本地实时投影</span></header>
  ${body}
  <footer class="footer"><span>writing-loop studio · schema ${snapshot.schemaVersion}</span><span>更新于 ${esc(new Date(snapshot.generatedAt).toLocaleString("zh-CN"))}</span><span class="path">${esc(snapshot.workspaceRoot)}</span></footer>
  </main>${liveScript}</body></html>`;
}

function projectCard(project: ProjectSnapshot, index: number, base: string): string {
  const scheduler = project.scheduler.state;
  const live = scheduler === "running" || scheduler === "stopping";
  return `<a class="project-card reveal${project.enabled ? "" : " paused"}" data-index="${String(index + 1).padStart(2, "0")}" href="${esc(at(base, `/p/${enc(project.key)}`))}">
    <div class="meta"><span class="chip">${esc(format(project))}</span>${project.genre ? `<span class="chip">${esc(project.genre)}</span>` : ""}${live ? `<span class="chip live">创作室运行中</span>` : ""}${!project.enabled ? `<span class="chip warn">已暂停</span>` : ""}</div>
    <h3>${esc(project.title)}</h3><p class="logline">${esc(project.logline ?? project.audience ?? "故事尚未写下一句话梗概。")}</p>
    <div class="progress"><i style="width:${project.progress.percent ?? 0}%"></i></div>
    <div class="progress-row"><b>EP ${String(project.progress.frontier).padStart(2, "0")}</b><span>/ ${project.progress.totalEpisodes ?? "?"}</span><span class="right">${pct(project.progress.percent)} · ${project.board.open} 项开放任务</span></div>
    ${project.board.needsAttention.length ? `<div class="attention-strip">${project.board.needsAttention.length} 项需要你的决定</div>` : ""}
  </a>`;
}

export function workspacePage(snapshot: WorkspaceSnapshot, base = "", inbox?: SystemProposalList): string {
  const cards = snapshot.projects.length ? snapshot.projects.map((project, index) => projectCard(project, index, base)).join("") : `<div class="empty" style="grid-column:1/-1">还没有剧本项目。点击“新建立项”完成采访并先预览计划。</div>`;
  const openSystem = inbox?.counts.open ?? 0;
  const body = `<section class="hero"><div><div class="eyebrow">Creative workspace</div><h1>故事从这里继续。</h1><p>每一部剧都保留自己的正文与历史；这里汇总创作前沿、审读门、人工停靠和正在工作的编剧团队。</p></div><div class="hero-stamp">LOCAL<br>WRITERS'<br>ROOM</div></section>
  <section class="stats reveal"><div class="stat"><strong>${snapshot.projectCount}</strong><span>在库作品</span></div><div class="stat"><strong>${snapshot.totals.episodes}</strong><span>已完成分集</span></div><div class="stat"><strong>${snapshot.totals.openTasks}</strong><span>开放创作任务</span></div><div class="stat"><strong>${snapshot.totals.needsAttention}</strong><span>等待你的决定</span></div></section>
  <div class="section-head"><h2>作品书架</h2><p>${snapshot.enabledProjectCount} 部正在创作</p><span class="count">按最近活动排序</span><a class="btn" href="${esc(at(base, "/projects/new"))}">＋ 新建立项</a></div><section class="library">${cards}</section>
  <a class="system-desk" href="${esc(at(base, "/system"))}"><div><div class="eyebrow">Writing Loop maintenance</div><h2>系统改进收件箱</h2><p>框架、Scheduler、Skills 与 Studio 的改进建议集中在这里；它们不会进入任何剧集的创作看板，也不会被编剧 agent 当作剧情任务执行。</p></div><div class="system-count"><b>${openSystem}</b><span>OPEN SYSTEM ITEMS</span></div></a>`;
  return shell("作品书架", body, snapshot, undefined, base);
}

const SYSTEM_STATUS_LABEL = { open: "待维护者处理", applied: "已应用", dismissed: "已驳回" } as const;

export function systemInboxPage(snapshot: WorkspaceSnapshot, inbox: SystemProposalList, base = ""): string {
  const rows = inbox.proposals.map((proposal) => `<article class="system-proposal ${esc(proposal.status)}"><div><small>${esc(proposal.id)} · 来源 ${esc(proposal.source.project)}/${esc(proposal.source.agent)}</small><h3>${esc(proposal.title)}</h3><p>${esc(proposal.summary)}</p><div class="task-labels">${proposal.evidence.slice(0, 4).map((item) => `<em>${esc(item)}</em>`).join("")}</div>${proposal.resolution ? `<p><b>处理结果：</b>${esc(proposal.resolution.note)}${proposal.resolution.commit ? ` · commit ${esc(proposal.resolution.commit)}` : ""}</p>` : `<p><b>建议改动：</b>${esc(proposal.proposedChange)}</p>`}</div><div class="system-proposal-state"><b>${esc(SYSTEM_STATUS_LABEL[proposal.status])}</b><time datetime="${esc(proposal.createdAt)}">${esc(relTime(proposal.createdAt))}</time></div></article>`).join("");
  const body = `<section class="hero"><div><div class="eyebrow">System maintenance inbox</div><h1>系统问题，不混进故事。</h1><p>这里接收 Writing Loop 自身的框架、调度、Skill 与 Studio 改进建议。它是 workspace 级维护面，不属于任何剧集的创作流水线。</p></div><div class="hero-stamp">SYSTEM<br>NOT<br>STORY</div></section>
  <section class="stats"><div class="stat"><strong>${inbox.counts.open}</strong><span>待处理</span></div><div class="stat"><strong>${inbox.counts.applied}</strong><span>已应用</span></div><div class="stat"><strong>${inbox.counts.dismissed}</strong><span>已驳回</span></div><div class="stat"><strong>${inbox.proposals.length}</strong><span>全部建议</span></div></section>
  <div class="toolbar"><a class="btn" href="${esc(at(base, "/"))}">← 返回作品书架</a></div>${inbox.warnings.map((warning) => `<div class="notice-item"><b>读取提示</b><span>${esc(warning)}</span></div>`).join("")}<section class="system-proposals">${rows || `<div class="empty">系统改进收件箱为空。创作看板只保留故事工作。</div>`}</section>`;
  return shell("系统改进收件箱", body, snapshot, undefined, base);
}

const task = (base: string, key: string, ticket: Ticket): string => `<a class="task" href="${esc(at(base, `/p/${enc(key)}/ticket/${enc(ticket.id)}`))}"><div class="task-id"><span>${esc(ticket.id)}</span>${ticket.episode ? `<span class="ep">EP ${ticket.episode}</span>` : ""}</div><b>${esc(ticket.title)}</b>${ticket.labels.length ? `<div class="task-labels">${ticket.labels.slice(0, 4).map((label) => `<em>${esc(label)}</em>`).join("")}</div>` : ""}</a>`;

function lane(project: ProjectSnapshot, state: string, color: string, base: string): string {
  const tickets = project.board.tickets.filter((ticket) => ticket.state === state);
  return `<section class="lane"><h3><i style="--state:${color}"></i>${esc(STATE_LABEL[state] ?? state)}<span>${tickets.length}</span></h3>${tickets.length ? tickets.map((ticket) => task(base, project.key, ticket)).join("") : `<div class="lane-empty">这一栏现在是空的。</div>`}</section>`;
}

function docsPanel(project: ProjectSnapshot, base: string): string {
  return `<section class="panel"><div class="panel-head"><h2>剧情资产</h2><span class="aside">${project.documents.filter((doc) => doc.exists).length}/${project.documents.length}</span></div><div class="doc-list">${project.documents.map((doc) => doc.exists
    ? `<a class="doc-row ok" href="${esc(at(base, `/p/${enc(project.key)}/document/${enc(doc.key)}`))}"><i class="doc-mark"></i><div><b>${esc(doc.label)}</b><small>${esc(doc.path)}</small></div><span>${Math.max(1, Math.round(doc.bytes / 1024))} KB</span></a>`
    : `<div class="doc-row"><i class="doc-mark"></i><div><b>${esc(doc.label)}</b><small>${esc(doc.path)}</small></div><span>未建立</span></div>`).join("")}</div></section>`;
}

function roomPanel(project: ProjectSnapshot): string {
  const active = project.scheduler.inFlight;
  const agents = Object.entries(project.telemetry.byAgent).sort(([a], [b]) => a.localeCompare(b));
  const live = active.length
    ? active.map((fire) => `<div class="room-live"><span class="orb">LIVE</span><div><b>${esc(AGENT_LABEL[fire.agent] ?? fire.agent)}正在工作</b><span>${esc(fire.model)} / ${esc(fire.effort)} · ${relTime(fire.startedAt)}</span></div></div>`).join("")
    : `<div class="room-off">${project.scheduler.state === "stale" ? "检测到陈旧调度状态，请运行 doctor。" : project.scheduler.state === "stopping" ? "创作室正在收尾。" : "当前没有 agent 正在落笔。"}</div>`;
  return `<section class="panel"><div class="panel-head"><h2>编剧室</h2><span class="aside">${esc(project.scheduler.cli ?? "offline")}</span></div>${live}<div class="agent-list">${agents.length ? agents.map(([agent, row]) => `<div class="agent"><div><b>${esc(AGENT_LABEL[agent] ?? agent)}</b><small>${row.fires} fires · ${row.noop} no-op</small></div><span class="rate">${row.fires ? Math.round(row.ok / row.fires * 100) : 0}%</span></div>`).join("") : `<div class="agent"><div><b>尚无运行记录</b><small>writing-loop run 启动后会在这里出现</small></div></div>`}</div></section>`;
}

function episodesPanel(project: ProjectSnapshot, base: string): string {
  const episodes = project.latestEpisodes.length ? project.latestEpisodes.map((episode) => `<a class="episode" href="${esc(at(base, `/p/${enc(project.key)}/episode/${episode.number}`))}"><span class="num">${String(episode.number).padStart(2, "0")}</span><b>${esc(episode.title)}</b><small>${esc(episode.arc ?? "未标单元")}${episode.hookType ? ` · ${esc(episode.hookType)}` : ""}${episode.words ? ` · ${episode.words} 字` : ""}</small></a>`).join("") : `<div class="empty" style="grid-column:1/-1">正文尚未开始。大纲门通过后，分集会沿时间线出现。</div>`;
  return `<section class="panel"><div class="panel-head"><h2>最近分集</h2><p>从最新一集向前</p></div><div class="episode-strip">${episodes}</div></section>`;
}

const detailHref = (base: string, key: string, event: ActivityEvent): string | null => event.detailRef
  ? at(base, `/p/${enc(key)}/${enc(event.detailRef.kind)}/${enc(event.detailRef.id)}`) : null;

function activityPanel(project: ProjectSnapshot, activity: ActivityPage | IndexedActivityPage | undefined, base: string): string {
  if (!activity) return "";
  const cost = activity.usage.cost.state === "known"
    ? formatProductionUsdMicros(activity.usage.cost.value.amountMicros) : "未记录";
  const rows = activity.items.length ? activity.items.map((event) => {
    const href = detailHref(base, project.key, event);
    const content = `<b>${esc(ACTIVITY_LABEL[event.kind] ?? event.kind)} · ${esc(event.subject.label)}</b><p>${esc(event.summary)}</p><small>${esc(event.actor.id ?? "system")}${event.time.anomaly ? ` · ${esc(event.time.anomaly)}` : ""}${event.completeness === "snapshot-only" ? " · 当前版本" : ""}</small>`;
    return `<div class="event ${esc(event.status)}"><time datetime="${esc(event.time.effectiveAt)}">${esc(relTime(event.time.effectiveAt))}</time><i class="pin"></i>${href ? `<a href="${href}">${content}</a>` : `<div>${content}</div>`}</div>`;
  }).join("") : `<div class="empty">尚无可投影的创作活动。</div>`;
  return `<section class="panel"><div class="panel-head"><h2>创作时间线</h2><p>评论流转与 fire 为权威；旧文件只表示当前版本</p><span class="aside">${activity.items.length} events</span></div><div class="usage-strip"><div><b>${activity.usage.observedFires}</b><span>有界窗口 FIRE</span></div><div><b>${Math.round(activity.usage.durationSeconds / 60)}m</b><span>可证实运行时长</span></div><div><b>${esc(cost)}</b><span>模型成本</span></div></div>${activity.warnings.length ? `<div class="chip warn">${activity.warnings.length} 项有界投影提示</div>` : ""}<div class="timeline">${rows}</div>${activity.nextBeforeCursor ? `<div class="toolbar"><a class="btn" href="${esc(at(base, `/api/projects/${enc(project.key)}/activity?before=${enc(activity.nextBeforeCursor)}`))}">查看更早活动 JSON</a></div>` : ""}</section>`;
}

type ProductionTaskView = ProductionReadModel["tasks"][number];

const productionUsd = (amountMicros: unknown): string =>
  typeof amountMicros === "number" && Number.isSafeInteger(amountMicros) && amountMicros >= 0
    ? formatProductionUsdMicros(amountMicros) : "未知";

function productionSummaryCost(production: ProductionReadModel): string {
  const cost = production.summary.cost;
  const actual = cost.actual;
  const actualLabel = actual.state === "known"
    ? `实际 ${productionUsd(actual.amountMicros)}`
    : actual.knownAmountMicros > 0
      ? `实际 ${productionUsd(actual.knownAmountMicros)} 已知 · ${actual.unknownTasks} 项未知`
      : actual.reason === "not-recorded" ? "实际未知 · 未记录" : `实际未知 · ${actual.unknownTasks} 项未回报`;
  return cost.estimatedTasks > 0
    ? `${actualLabel} · 估算 ${productionUsd(cost.estimatedAmountMicros)}（${cost.estimatedTasks} 项）`
    : actualLabel;
}

function productionTaskCost(task: ProductionTaskView): string {
  if (task.cost.state === "known" && task.cost.basis === "estimated") {
    return `估算 ${productionUsd(task.cost.amountMicros)} · 实际未知`;
  }
  if (task.cost.state === "known") return `实际 ${productionUsd(task.cost.amountMicros)}`;
  return `未知 · ${PRODUCTION_COST_REASON[task.cost.reason] ?? task.cost.reason}`;
}

const productionNeedsAttention = (status: string): boolean =>
  ["qc-pending", "rejected", "submission-unknown", "failed", "cancel-requested", "orphaned"].includes(status);

function productionTask(task: ProductionTaskView): string {
  const needsAttention = productionNeedsAttention(task.status);
  const terminal = ["approved", "rejected", "failed", "cancelled", "orphaned"].includes(task.status);
  const subject = task.kind === "shot"
    ? `EP ${task.episodeId} · 镜头 ${task.shotId ?? "未标"}`
    : `整集 ${task.episodeId}`;
  const remote = task.remoteJobId
    ? `${task.backendInstanceId ?? "backend 未标"} · job ${task.remoteJobId}`
    : task.backendInstanceId ? `${task.backendInstanceId} · 尚无远端 job` : "尚未绑定远端任务";
  const approval = task.approval
    ? `<div class="production-approval${task.approval.decision === "rejected" ? " rejected" : ""}"><b>${task.approval.decision === "approved" ? "QC 已通过" : "QC 已退回"}</b> · ${esc(task.approval.decidedBy)}${task.approval.note ? ` · ${esc(task.approval.note)}` : ""}</div>`
    : task.status === "qc-pending" ? `<div class="production-approval rejected"><b>等待人工 QC</b> · 生成完成不等于审核通过</div>` : "";
  const cancellation = task.cancellationRequest
    ? `<div class="production-approval rejected"><b>${task.status === "cancel-requested" ? "取消待确认" : task.status === "cancelled" ? "已确认取消" : "取消未终止制作"}</b> · 来源 ${esc(task.cancellationRequest.requestedFrom)} · ${esc(task.cancellationRequest.reason)}</div>`
    : "";
  return `<article class="production-task${needsAttention ? " attention" : terminal ? " done" : ""}"><div class="production-task-head"><div><b>TAKE · ${esc(task.id)}</b><small>${esc(subject)} · source r${esc(task.subjectRevision)} · task r${esc(task.revision)}</small></div><div class="production-state"><strong>${esc(PRODUCTION_STATUS_LABEL[task.status] ?? task.status)}</strong><span>${esc(relTime(task.updatedAt))}</span>${needsAttention ? `<span class="chip warn">NEEDS ATTENTION</span>` : ""}</div></div><div class="production-facts"><div class="production-fact"><b>${esc(remote)}</b><span>远端回执</span></div><div class="production-fact"><b>${esc(task.assetCount)} 份</b><span>已登记素材</span></div><div class="production-fact"><b>${esc(productionTaskCost(task))}</b><span>成本口径</span></div></div>${task.statusMessage ? `<p class="production-message">${esc(task.statusMessage)}</p>` : ""}${cancellation}${approval}</article>`;
}

function productionPanel(
  production: ProductionReadModel | undefined,
  control: ProductionCoordinatorReadModel | undefined,
): string {
  if (!production) return "";
  const visibleTasks = production.tasks.slice(0, 24);
  const tasks = production.tasks.length
    ? `<div class="production-list">${visibleTasks.map(productionTask).join("")}</div>${production.tasks.length > visibleTasks.length ? `<div class="toolbar"><span class="chip warn">仅显示最近 ${visibleTasks.length} / ${production.tasks.length} 个 take；完整账本请查看 JSON</span></div>` : ""}`
    : `<div class="empty">尚无制片任务。这里仅呈现本地权威状态，不会从页面探测远端服务。</div>`;
  const exposure = control && control.summary.budget.exposedAmountMicros > 0
    ? `<span class="chip warn">潜在计费敞口 ${esc(productionUsd(control.summary.budget.exposedAmountMicros))}</span>`
    : `<span class="chip">当前无未结计费敞口</span>`;
  const controlSummary = control && control.revision > 0
    ? `<div class="toolbar"><span class="chip">CONTROL r${esc(control.revision)}</span><span class="chip${control.summary.pendingEvents ? " warn" : ""}">${esc(control.summary.pendingEvents)} 待落账 · ${esc(control.summary.tasksWithRetryHistory)} 有重试历史 · ${esc(control.summary.lastObservedNotFound)} 末次观察缺失</span>${exposure}</div>`
    : `<div class="toolbar"><span class="chip">协调器尚未运行；页面不会自行连接远端</span></div>`;
  return `<section class="panel"><div class="panel-head"><h2>制片流水线</h2><p>镜头、take、远端回执与 QC 分开记账</p><span class="aside">state r${esc(production.revision)} · ${esc(relTime(production.updatedAt))}</span></div><div class="production-summary"><div><b>${esc(production.summary.total)}</b><span>全部 TAKE</span></div><div><b>${esc(production.summary.active)}</b><span>制片进行中</span></div><div><b>${esc(production.summary.needsAttention)}</b><span>需要处理 / QC</span></div><div><b>${esc(productionSummaryCost(production))}</b><span>实际 / 估算成本</span></div></div>${controlSummary}${tasks}</section>`;
}

function reportsPanel(project: ProjectSnapshot, reports: ReportSummary[] = [], evaluations: ReportSummary[] = [], base = ""): string {
  const rows = [
    ...reports.slice(0, 6).map((row) => ({ ...row, kind: "report" as const })),
    ...evaluations.slice(0, 4).map((row) => ({ ...row, kind: "evaluation" as const })),
  ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return `<section class="panel"><div class="panel-head"><h2>报告与评估</h2><span class="aside">${reports.length + evaluations.length}</span></div>${rows.length ? `<div class="report-list">${rows.map((row) => `<a class="report-link" href="${esc(at(base, `/p/${enc(project.key)}/${row.kind}/${enc(row.id)}`))}"><b>${row.review ? "操作者点评 · " : row.kind === "evaluation" ? "里程碑 · " : ""}${esc(row.label)}</b><small>${esc(relTime(row.updatedAt))}</small></a>`).join("")}</div>` : `<div class="empty">尚无报告或里程碑评估。</div>`}</section>`;
}

export type StoryStudioSection = "source" | "story" | "timeline" | "assets" | "characters" | "art" | "quality";

function projectNav(project: ProjectSnapshot, active: "overview" | StoryStudioSection, base: string): string {
  const items: Array<["overview" | StoryStudioSection, string, string]> = [
    ["overview", "概览", `/p/${enc(project.key)}`],
    ["source", "原著分析", `/p/${enc(project.key)}/source`],
    ["story", "故事结构", `/p/${enc(project.key)}/story`],
    ["timeline", "时间线", `/p/${enc(project.key)}/timeline`],
    ["assets", "剧情资产", `/p/${enc(project.key)}/assets`],
    ["characters", "人物设定", `/p/${enc(project.key)}/characters`],
    ["art", "美术资产", `/p/${enc(project.key)}/art`],
    ["quality", "分集与质量", `/p/${enc(project.key)}/quality`],
  ];
  return `<nav class="project-nav" aria-label="项目工作台">${items.map(([key, label, href]) => `<a${key === active ? ` class="active" aria-current="page"` : ""} href="${esc(at(base, href))}">${label}</a>`).join("")}</nav>`;
}

function storyCockpit(model: StoryStudioReadModel | undefined): string {
  if (!model) return "";
  const source = model.source;
  const sourceLabel = !source ? "原创" : source.phase === "review-ready" ? "已验收" : source.phase === "analyzing" ? `${source.completed}/${source.selected}` : "待选范围";
  const next = model.summary.failed > 0 ? `${model.summary.failed} 个质量门待修复`
    : model.summary.readyForEpisodes ? "结构已可进入分集生产" : model.summary.stage === "source" ? "先完成原著分析票" : "继续完善结构伴随文件";
  return `<section class="creative-cockpit"><div class="next"><b>${esc(next)}</b><span>NEXT VERIFIED ACTION</span></div><div><b>${esc(sourceLabel)}</b><span>原著分析</span></div><div><b>${esc(model.story?.catalog?.manifest.assets.length ?? 0)}</b><span>结构化剧情资产</span></div><div><b>${model.summary.passed}/${model.gates.length}</b><span>质量门通过</span></div></section>`;
}

export function projectPage(snapshot: WorkspaceSnapshot, project: ProjectSnapshot, notice?: string, extras: ProjectPageExtras = {}, base = ""): string {
  // add-script 会先生成完整模板，因此“文件存在”不等于创作成熟度。这里只展示可证实的
  // 创作信号：一句话故事、已过门的大纲/实际 arc、正文，以及定稿或评估记录。
  const doneWithLabel = (label: string): boolean => project.board.tickets.some((ticket) =>
    ticket.state === "Done" && ticket.labels.includes(label));
  const northStarReady = project.logline !== null;
  const outlineTicketDone = doneWithLabel("outline");
  const outlineReady = project.progress.arcs > 0 || outlineTicketDone;
  const storyReady = project.progress.frontier > 0;
  const reviewedEpisode = project.board.tickets.some((ticket) =>
    ticket.state === "Done" && (ticket.episode !== null || ticket.labels.includes("episode")));
  const reviewReady = reviewedEpisode || project.progress.evaluations > 0;
  const total = project.progress.totalEpisodes;
  const progressWidth = project.progress.percent ?? 0;
  const notices = project.board.needsAttention.length
    ? `<div class="notice-list">${project.board.needsAttention.map((ticket) => `<div class="notice-item"><b>${esc(ticket.title)}</b><span>${esc(ticket.id)} · ${esc(STATE_LABEL[ticket.state] ?? ticket.state)} · ${ticket.labels.filter((label) => label.startsWith("needs-")).map(esc).join(" / ")}</span></div>`).join("")}</div>`
    : `<div class="empty">没有等待操作者的停靠事项。</div>`;
  const body = `${notice ? `<div class="toolbar"><span class="chip live">${esc(notice)}</span></div>` : ""}
  <section class="project-hero"><div><div class="eyebrow">${esc(format(project))}${project.genre ? ` · ${esc(project.genre)}` : ""}</div><h1>${esc(project.title)}</h1><p class="logline">${esc(project.logline ?? "一句话故事仍待总编剧定稿。")}</p><div class="path">${esc(project.repoPath)}</div></div><div class="folio"><strong>${String(project.progress.frontier).padStart(2, "0")}</strong><span>CURRENT EPISODE / ${total ?? "OPEN"}</span><div class="mini-progress"><i style="width:${progressWidth}%"></i></div><span>${pct(project.progress.percent)} COMPLETE</span></div></section>
  ${projectNav(project, "overview", base)}${storyCockpit(extras.story)}
  <div class="toolbar"><form method="post" action="${esc(at(base, `/p/${enc(project.key)}/toggle`))}"><input type="hidden" name="enabled" value="${project.enabled ? "false" : "true"}"><button class="btn${project.enabled ? " danger" : ""}" type="submit">${project.enabled ? "暂停这部剧" : "恢复创作"}</button></form><a class="btn" href="${esc(at(base, `/api/snapshot?project=${enc(project.key)}`))}">查看 JSON</a><span class="chip">${project.enabled ? "正在创作" : "已暂停"}</span>${project.warnings.length ? `<span class="chip warn">${project.warnings.length} 项有界读取提示</span>` : ""}</div>
  <section class="panel" style="margin-bottom:20px"><div class="panel-head"><h2>故事脊柱</h2><p>不是工程阶段，而是创作成熟度</p></div><div class="spine"><div class="spine-item ${northStarReady ? "ok" : "warn"}"><b>核心方向</b><span>${northStarReady ? "一句话故事已定" : "核心方向仍待定"}</span></div><div class="spine-item ${outlineReady ? "ok" : "warn"}"><b>结构与卡点</b><span>${project.progress.arcs > 0 ? `${project.progress.arcs} 个叙事单元已建立` : outlineTicketDone ? "总大纲已过定稿门" : "总大纲尚未过门"}</span></div><div class="spine-item ${storyReady ? "ok" : "warn"}"><b>分集正文</b><span>${storyReady ? `推进到第 ${project.progress.frontier} 集` : "等待第一集落笔"}</span></div><div class="spine-item ${reviewReady ? "ok" : "warn"}"><b>审读与评估</b><span>${project.progress.evaluations > 0 ? `${project.progress.evaluations} 份里程碑评估` : reviewedEpisode ? "已有分集定稿记录" : "尚未形成验收记录"}</span></div></div></section>
  <div class="workspace-grid"><div class="stack"><section class="panel"><div class="panel-head"><h2>创作任务</h2><p>从灵感到定稿</p><span class="aside">${project.board.open} open</span></div><div class="lanes">${lane(project, "Backlog", "var(--muted)", base)}${lane(project, "Todo", "var(--gold)", base)}${lane(project, "In Progress", "var(--blue)", base)}${lane(project, "In Review", "var(--accent)", base)}</div></section>${episodesPanel(project, base)}${productionPanel(extras.production, extras.productionControl)}${activityPanel(project, extras.activity, base)}</div><aside class="stack"><section class="panel"><div class="panel-head"><h2>等待你的决定</h2><span class="aside">${project.board.needsAttention.length}</span></div>${notices}</section>${roomPanel(project)}${docsPanel(project, base)}${reportsPanel(project, extras.reports, extras.evaluations, base)}</aside></div>`;
  return shell(project.title, body, snapshot, project, base);
}

function sectionHeader(eyebrow: string, title: string, description: string, value: string, label: string): string {
  return `<section class="section-hero"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p>${esc(description)}</p></div><div class="section-kpi"><b>${esc(value)}</b><span>${esc(label)}</span></div></section>`;
}

function sourceSection(model: StoryStudioReadModel): string {
  const source = model.source;
  if (!source) return `${sectionHeader("Source dossier", "原著分析", "原创项目没有原著 intake；故事设计从 North Star 直接进入。", "—", "NO SOURCE INTAKE")}<section class="panel"><div class="empty">这不是缺失：原创项目的 source gate 为不适用。</div></section>`;
  const selectedPct = source.selected ? Math.round(source.completed / source.selected * 100) : 0;
  const chunks = source.chunks.map((row) => `<div class="chunk${row.completed ? " done" : row.selected ? " selected" : ""}"><b>${esc(row.id)}</b><span>${esc(row.headings.slice(0, 2).join(" · ") || "无标题分块")}</span></div>`).join("");
  return `${sectionHeader("Source dossier", "原著分析", "这里只展示受控分块、选择窗口和 checkpoint，不展示或复制原著正文。", `${source.completed}/${source.selected || source.chunkCount}`, "COMPLETED / SELECTED")}
  <div class="atlas-grid"><section class="panel"><div class="panel-head"><h2>${esc(source.title)}</h2><p>${source.chunkCount} 个不可变分块</p><span class="aside">${esc(source.phase)}</span></div><div class="source-progress"><i style="width:${selectedPct}%"></i></div><div class="toolbar"><span class="chip">SHA ${esc(source.sha256.slice(0, 16))}…</span><span class="chip">${esc(source.allowedHarnesses.join(" / "))}</span><span class="chip">${Math.round(source.byteLength / 1024 / 1024 * 10) / 10} MiB</span></div><div class="chunk-map">${chunks}</div></section><aside class="stack"><section class="panel"><h2>证据边界</h2><p>原著正文保留在 workspace 的 0600 运行态；Git 只接收摘要、来源指纹与人工核验结果。</p><div class="path">${esc(source.planId)}</div></section><section class="panel"><h2>状态语义</h2><p><span class="chip">白色</span> 未选范围</p><p><span class="chip warn">金色</span> 本季已选、待分析</p><p><span class="chip live">绿色</span> 已 checkpoint</p></section></aside></div>`;
}

function storySection(model: StoryStudioReadModel): string {
  const story = model.story;
  if (!story) return `${sectionHeader("Story architecture", "故事结构", "等待 Story Designer 把人读大纲投影成严格的 story/outline.v1.json。", "0", "EPISODES MAPPED")}<section class="panel"><div class="empty">质量门 S00 尚未通过；看板仍是当前任务真相源。</div></section>`;
  const decisions = (["keep", "cut", "merge", "risks"] as const).flatMap((kind) => story.manifest.adaptation[kind].map((row) => ({ kind, ...row })));
  const decisionLabels = { keep: "保留", cut: "删除", merge: "合并", risks: "风险" } as const;
  return `${sectionHeader("Story architecture", "故事结构", story.manifest.adaptation.core, String(story.assets.counts.episodes), "EPISODES MAPPED")}
  <section class="panel"><div class="panel-head"><h2>改编处置表</h2><p>${esc(story.manifest.adaptation.mode)}</p></div><div class="decision-grid">${decisions.length ? decisions.map((row) => `<article class="dossier"><span class="tier">${decisionLabels[row.kind]}</span><h3>${esc(row.item)}</h3><p>${esc(row.reason)}</p><small>${esc(row.sourceRefs.join(" · ") || "无来源")}</small></article>`).join("") : `<div class="empty">尚未登记改编处置。</div>`}</div></section>
  <section class="panel"><div class="panel-head"><h2>分集节拍图</h2><p>钩型、主动性与季级 beat 共用一个 manifest</p></div><div class="episode-atlas">${story.manifest.episodes.map((row) => `<article class="episode-beat" data-episode="${String(row.number).padStart(2, "0")}"><h3>${esc(row.arc)}</h3><small>${esc(row.hookType)} · ${esc(row.agency)} · ${esc(row.beatIds.join(" / "))}</small><p>${esc(row.synopsis)}</p><p><b>尾钩</b> ${esc(row.hook)}</p></article>`).join("") || `<div class="empty">等待逐集结构。</div>`}</div></section>`;
}

function charactersSection(model: StoryStudioReadModel): string {
  const story = model.story;
  const characters = story?.manifest.characters ?? [];
  const catalog = new Map((story?.catalog?.manifest.assets ?? []).map((row) => [row.id, row] as const));
  return `${sectionHeader("Character workbench", "人物设定", "按角色工作，而不是在卡片墙里找信息；source refs 与推断内容始终可见。", String(characters.length), "NAMED CHARACTERS")}
  <section class="panel"><div class="cast-grid">${characters.map((row) => { const asset = catalog.get(row.id); return `<article class="dossier${row.sourceRefs.length ? "" : " inferred"}"><span class="tier">${esc(row.tier)}</span><h3>${esc(row.name)}</h3><small>${esc(row.id)} · EP ${row.firstEpisode}–${row.lastEpisode} · ${asset?.facts.length ?? 0} FACTS</small><p><b>戏剧功能：</b>${esc(row.role)}</p><p><b>人物弧：</b>${esc(row.arc ?? "功能角色，不虚构强行成长弧")}</p><p><b>当前事实：</b>${esc(asset?.facts.filter((fact) => fact.state === "current").map((fact) => `${fact.key}=${fact.value}`).join("；") || "等待 assets.v1.json")}</p><small>${asset?.sourceRefs.length ? `来源 ${esc(asset.sourceRefs.join(" · "))}` : "推断/原创：无结构化 source ref"}</small></article>`; }).join("") || `<div class="empty">等待人物分级与角色功能表。</div>`}</div></section>`;
}

function timelineSection(model: StoryStudioReadModel): string {
  const events = model.story?.catalog?.manifest.timeline ?? [];
  const byStory = [...events].sort((a, b) => a.chronologyIndex - b.chronologyIndex);
  const byReveal = [...events].sort((a, b) => a.reveal.episode - b.reveal.episode || a.reveal.order - b.reveal.order);
  const cards = (rows: typeof events, order: "story" | "reveal"): string => rows.map((row) => `<article class="timeline-event"><small>${order === "story" ? `#${row.chronologyIndex} · ${esc(row.storyTimeLabel)}` : `EP ${String(row.reveal.episode).padStart(2, "0")} / ${row.reveal.order} · ${esc(row.reveal.mode)}`}</small><h3>${esc(row.label)}</h3><p>${esc(row.summary)}</p><div class="asset-tags">${row.assetIds.map((id) => `<span>${esc(id)}</span>`).join("")}</div></article>`).join("") || `<div class="empty">等待 Story Designer 建立结构化事件。</div>`;
  return `${sectionHeader("Chronology × reveal order", "双轨时间线", "左侧是真实发生顺序，右侧是观众看到的顺序；回忆、闪回、预示与画外事件不会再埋在散文里。", String(events.length), "TIMELINE EVENTS")}
  <section class="panel timeline-grid"><div class="timeline-rail"><h2>故事世界时序</h2>${cards(byStory, "story")}</div><div class="timeline-rail"><h2>观众揭示顺序</h2>${cards(byReveal, "reveal")}</div></section>`;
}

function assetGraphSection(model: StoryStudioReadModel): string {
  const assets = model.story?.catalog?.manifest.assets ?? [];
  const cards = assets.map((row) => `<article class="dossier"><span class="tier">${esc(row.type)} · ${esc(row.status)}</span><h3>${esc(row.label)}</h3><small>${esc(row.id)} · ${esc(row.importance)}${row.episodes ? ` · EP ${row.episodes.first}–${row.episodes.last}` : " · GLOBAL"}</small><p>${esc(row.summary)}</p><p><b>Facts</b> ${row.facts.length} · <b>Relations</b> ${row.relations.length}</p><div class="asset-tags">${row.context.agents.map((agent) => `<span>${esc(agent)}</span>`).join("")}</div><small>${esc(row.sourceRefs.join(" · ") || "无 provenance")}</small></article>`).join("");
  return `${sectionHeader("Typed story graph", "剧情资产图", "人物、世界规则、地点、组织、道具、场景、伏笔与连续性共享稳定 ID、事实、关系、生命周期和上下文策略。", String(assets.length), "STRUCTURED ASSETS")}
  <section class="panel"><div class="decision-grid">${cards || `<div class="empty">等待 Story Designer 创建 story/assets.v1.json。</div>`}</div></section>`;
}

function artSection(model: StoryStudioReadModel): string {
  const scenes = model.story?.assets.scenes ?? [];
  return `${sectionHeader("Visual asset ledger", "美术资产", "这里是由故事结构派生的场景需求，不是模型自由生成的第二份资产清单；H3 仍在后续制片层。", String(scenes.length), "DERIVED SCENES")}
  <section class="panel"><div class="art-grid">${scenes.map((row) => `<article class="dossier${row.primary ? " primary" : ""}"><span class="tier">${row.primary ? "PRIMARY" : "SUPPORT"}</span><h3>${esc(row.name)}</h3><small>${esc(row.id)}${row.variantOf ? ` · variant of ${esc(row.variantOf)}` : ""}</small><p><b>复用策略：</b>${esc(row.reusePlan ?? "尚未建立；若只用一次会被 S05 拦截")}</p><div class="toolbar"><span class="chip">待视觉锚</span><span class="chip">待灯光状态</span><span class="chip">未进入 H3</span></div></article>`).join("") || `<div class="empty">故事结构尚未派生场景资产。</div>`}</div></section>`;
}

function qualitySection(model: StoryStudioReadModel): string {
  return `${sectionHeader("Deterministic + editorial gates", "分集与质量", "机器门负责可复现事实，Showrunner 保留创作品质否决；skipped 与 not-applicable 永不显示为绿色。", `${model.summary.passed}/${model.gates.length}`, "GATES PASSED")}
  ${model.warnings.length ? `<div class="toolbar">${model.warnings.map((row) => `<span class="chip warn">${esc(row)}</span>`).join("")}</div>` : ""}<section class="panel"><div class="gate-grid">${model.gates.map((row) => `<article class="gate ${esc(row.state)}"><span class="gate-state">${esc(row.state.toUpperCase())}</span><div><h3>${esc(row.id)} · ${esc(row.label)}</h3><p>${esc(row.detail)}</p><small>${esc(row.stage)} · ${esc(row.kind)}</small></div></article>`).join("")}</div></section>`;
}

export function projectStoryPage(snapshot: WorkspaceSnapshot, project: ProjectSnapshot, section: StoryStudioSection,
  model: StoryStudioReadModel, base = ""): string {
  const content = section === "source" ? sourceSection(model) : section === "story" ? storySection(model)
    : section === "timeline" ? timelineSection(model) : section === "assets" ? assetGraphSection(model)
      : section === "characters" ? charactersSection(model)
      : section === "art" ? artSection(model) : qualitySection(model);
  return shell(`${project.title} · ${section}`, `${projectNav(project, section, base)}${content}`, snapshot, project, base);
}

const option = (value: string, label: string, selected = false): string => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;

export function newProjectPage(snapshot: WorkspaceSnapshot, base = ""): string {
  const body = `<div class="form-card"><section class="form-intro"><div class="eyebrow">Project onboarding</div><h1>你给方向，编剧室自己开工。</h1><p>这里只收集操作者掌握的事实与创作意图。原创项目直接进入大纲；改编项目同时登记本地原著、把改编总建议写入 North Star，并自动创建原著分析工单。拆书范围、逐块任务和三张清单都由 writing-loop 自主规划。</p></section>
  <section class="panel onboarding-contract"><article><div class="eyebrow">YOU PROVIDE</div><h2>原著 + 总体改编方向</h2><p>剧名、受众、集数、本地原著路径、权利边界，以及你希望保留、改写或避免的原则。</p></article><article><div class="eyebrow">WRITING-LOOP DECIDES</div><h2>任务计划 + 创作产物</h2><p>选取哪一季内容、如何拆书、人物与场景资产、分集节拍、质量门和 tickets，全部由编剧室自主生成并接受 Showrunner 审核。</p></article></section>
  <form class="panel form-grid" method="post" action="${esc(at(base, "/projects/plan"))}">
    <div class="form-section"><h2>身份与落点</h2><small>Studio 自动立项只允许 workspace 内、尚不存在的新 repo。</small></div>
    <div class="field"><label for="key">项目 key</label><input id="key" name="key" required maxlength="32" pattern="[a-z0-9][a-z0-9._-]{0,31}" placeholder="paper-moon"><small>全 workspace 唯一，1–32 位小写 ASCII。</small></div>
    <div class="field"><label for="title">剧名</label><input id="title" name="title" required maxlength="120" placeholder="纸月亮"></div>
    <div class="field wide"><label for="repoPath">正文 repo 相对路径</label><input id="repoPath" name="repoPath" required maxlength="1000" placeholder="paper-moon"><small>父目录必须已存在；不能是 .writing-loop、不能穿越 workspace、不能采用已有目录。</small></div>
    <div class="field"><label for="kind">立项式</label><select id="kind" name="kind">${option("original", "原创", true)}${option("adaptation", "小说改编")}</select></div>
    <div class="field"><label for="ticketPrefix">工单前缀</label><input id="ticketPrefix" name="ticketPrefix" value="WL" required maxlength="8" pattern="[A-Z][A-Z0-9]{0,7}"></div>

    <div class="form-section"><h2>故事与受众</h2><small>不能用“待定”蒙混；这些内容会进入 north-star。</small></div>
    <div class="field wide"><label for="logline">一句话故事</label><textarea id="logline" name="logline" required maxlength="180" placeholder="≤60 字为佳，含人设反差与核心钩子"></textarea></div>
    <div class="field wide"><label for="audience">目标受众</label><input id="audience" name="audience" required maxlength="240" placeholder="女性 25-40 岁，一二线城市付费用户"><small>必须明确包含性别与年龄段。</small></div>
    <div class="field wide"><label for="complianceNotes">合规预筛</label><textarea id="complianceNotes" name="complianceNotes" required maxlength="2000" placeholder="涉政、违法后果、婚恋伦理、平台边界逐项说明"></textarea></div>
    <div class="field wide"><label for="nonGoals">其他 Non-goals</label><textarea id="nonGoals" name="nonGoals" maxlength="4000" placeholder="每行一项"></textarea></div>

    <div class="form-section"><h2>产品规格</h2></div>
    <div class="field"><label for="genre">题材 profile</label><select id="genre" name="genre">${option("brain-hole", "脑洞")}${option("revenge-slap", "复仇打脸", true)}${option("profession-unit", "职业单元")}${option("sweet-pet", "甜宠（未校准）")}${option("angst", "虐恋（未校准）")}</select></div>
    <div class="field"><label for="format">成片形态</label><select id="format" name="format">${option("live-action", "真人短剧", true)}${option("ai-anime", "AI 漫剧")}${option("reelshort-en", "海外英文")}</select></div>
    <div class="field"><label for="monetization">商业模式</label><select id="monetization" name="monetization">${option("paid-app", "付费卡点", true)}${option("free-hongguo", "免费留存")}${option("reelshort-sub", "海外订阅")}</select></div>
    <div class="field"><label for="totalEpisodes">总集数</label><input id="totalEpisodes" name="totalEpisodes" type="number" min="1" max="300" value="80" required></div>
    <div class="field"><label for="card1">一卡备选</label><input id="card1" name="card1" value="9,10,11"><small>付费项目必须全部位于 8–12 集。</small></div>
    <div class="field"><label for="card2">二卡备选</label><input id="card2" name="card2" value="26,28,30"></div>
    <div class="field"><label for="card3">三卡备选</label><input id="card3" name="card3" value="60"></div>
    <div class="field"><label>单集字数带</label><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><input name="wordMin" type="number" min="1" max="10000" value="900" required><input name="wordMax" type="number" min="1" max="10000" value="1300" required></div></div>
    <div class="field"><label for="maxPrimaryScenes">主场景上限</label><input id="maxPrimaryScenes" name="maxPrimaryScenes" type="number" min="1" max="100" value="5" required></div>
    <div class="field"><label for="maxNamedCharacters">具名角色上限</label><input id="maxNamedCharacters" name="maxNamedCharacters" type="number" min="1" max="200" value="20" required></div>
    <div class="field"><label for="intakeMode">进件模式</label><select id="intakeMode" name="intakeMode">${option("autonomous", "自治推进", true)}${option("passive", "仅用户驱动")}</select></div>
    <div class="field"><label for="mode">项目写入模式</label><select id="mode" name="mode">${option("live", "live", true)}${option("dry-run", "dry-run")}</select></div>

    <div class="form-section" data-original-only><h2>原创定位</h2><small>这两项会进入 North Star，供 Story Designer 自主建立结构任务。</small></div>
    <div class="field" data-original-only><label for="comparables">对标剧与证据</label><textarea id="comparables" name="comparables" maxlength="500" data-required-for-kind></textarea></div>
    <div class="field" data-original-only><label for="differentiation">差异化</label><textarea id="differentiation" name="differentiation" maxlength="500" data-required-for-kind></textarea></div>

    <div class="form-section source-intake" data-adaptation-only hidden><h2>原著与改编方向</h2><small>提供输入，不替 writing-loop 做拆解。原著留在 workspace 本地并按工单逐块读取，正文不会进入 Git。</small></div>
    <div class="field" data-adaptation-only hidden><label for="sourceTitle">原著名称</label><input id="sourceTitle" name="sourceTitle" maxlength="200" placeholder="官居一品" data-required-for-kind></div>
    <div class="field" data-adaptation-only hidden><label for="sourceHarness">分析 Harness</label><select id="sourceHarness" name="sourceHarness" data-required-for-kind>${option("claude", "Claude（默认）", true)}${option("codex", "Codex")}${option("opencode", "OpenCode")}</select><small>只有所选车道可接收原著分块。</small></div>
    <div class="field wide" data-adaptation-only hidden><label for="sourcePath">原著文件（workspace 内本机路径）</label><input id="sourcePath" name="sourcePath" maxlength="2048" placeholder="/Users/you/dramas/原著.txt" data-required-for-kind><small>必须是 workspace 内、剧本 Git repo 外的普通 UTF-8 文件；最多 64 MiB。</small></div>
    <div class="field wide" data-adaptation-only hidden><label for="adaptationBrief">项目开发总建议</label><textarea class="long" id="adaptationBrief" name="adaptationBrief" maxlength="24000" placeholder="你希望保留的核心钩子、要改变的方向、第一季范围、叙事框架、人物和版权边界……" data-required-for-kind></textarea><small>原样写入 North Star 与 source intake；writing-loop 据此自主规划分析任务。</small></div>
    <div class="field wide" data-adaptation-only hidden><label for="rightsScope">版权与内部开发范围</label><input id="rightsScope" name="rightsScope" maxlength="1000" placeholder="例如：已获影视改编权；或仅限内部开发、发行前补齐权利链" data-required-for-kind></div>
    <label class="field check wide" data-adaptation-only hidden><input name="allowRawSourceProcessing" type="checkbox" value="true" data-required-for-kind><span>我明确允许所选 Harness 在 source-analysis 工单内按块读取该原著。writing-loop 不会把原著正文写入 Git，也不会让未授权 Harness 启动分析。</span></label>
    <div class="field wide"><button class="btn" type="submit">生成零写入立项计划 →</button></div>
  </form></div>`;
  return shell("新建立项", body, snapshot, undefined, base);
}

export function onboardingPlanPage(snapshot: WorkspaceSnapshot, plan: OnboardingPlan, encodedInput: string, base = ""): string {
  const warnings = plan.warnings.length
    ? `<ul class="warning-list">${plan.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>`
    : `<p>没有额外警告；仍请核对所有操作者决定。</p>`;
  const sourcePreview = plan.sourceIntake
    ? `<div class="plan-item"><b>${esc(plan.sourceIntake.source.title)}</b><small>${esc(plan.sourceIntake.source.fileName)} · ${plan.sourceIntake.source.byteLength} bytes · SHA ${esc(plan.sourceIntake.source.sha256.slice(0, 12))}…</small></div><div class="plan-item"><b>自动原著分析</b><small>${plan.sourceIntake.chunking.chunkCount} chunks · ${plan.sourceIntake.processingConsent.allowedHarnesses.map(esc).join(" / ")} · outline 先停 Backlog</small></div>`
    : "";
  const body = `<div class="form-card"><section class="form-intro"><div class="eyebrow">Preview · no writes</div><h1>确认一次，自治流程接手。</h1><p>计划指纹绑定 config、模板、原著字节指纹与全部操作者输入。确认后会创建项目；改编项目还会自动登记原著、创建 source-analysis 工单并停靠大纲票。</p></section>
  <section class="panel stack"><div class="plan-grid"><div class="plan-item"><b>${esc(plan.input.title)}</b><small>${esc(plan.input.key)} · ${esc(plan.input.kind)}</small></div><div class="plan-item"><b>${esc(plan.input.format)} / ${esc(plan.input.monetization)}</b><small>${plan.input.totalEpisodes} 集 · ${esc(plan.input.genre)}</small></div><div class="plan-item"><b>正文仓</b><small>${esc(plan.repoPath)}</small></div><div class="plan-item"><b>运行态</b><small>${esc(plan.projectDataPath)}</small></div><div class="plan-item"><b>首张大纲票</b><small>${esc(plan.outlineTicket.id)} · ${esc(plan.outlineTicket.title)}</small></div><div class="plan-item"><b>${plan.files.length} 个计划文件</b><small>Git scaffold + board + lessons + receipt</small></div></div>
  ${sourcePreview ? `<div class="plan-grid">${sourcePreview}</div>` : ""}
  <div><h2>警告与人工确认</h2>${warnings}</div>
  <div class="confirm-box"><b>Plan ID</b><div class="path">${esc(plan.planId)}</div><p>提交会以原子方式预留最终 repo 与运行态目录，在 durable journal 保护下完成 Git 首提交和项目数据；config.json 仍是最后的可见性提交点。目标路径已存在时绝不接管或覆盖。</p>
    <form method="post" action="${esc(at(base, "/projects/create"))}"><input type="hidden" name="payload" value="${esc(encodedInput)}"><input type="hidden" name="planId" value="${esc(plan.planId)}"><div class="toolbar"><button class="btn danger" type="submit">${plan.sourceIntake ? "确认立项并加入原著分析队列" : "确认并完整立项"}</button><a class="btn" href="${esc(at(base, "/projects/new"))}">返回修改</a></div></form>
  </div></section></div>`;
  return shell(`确认立项 · ${plan.input.title}`, body, snapshot, undefined, base);
}

const detailSection = (title: string, content: string | null): string => content
  ? `<section class="detail-section"><h3>${esc(title)}</h3><pre class="markdown">${esc(content)}</pre></section>` : "";

export function resourcePage(snapshot: WorkspaceSnapshot, project: ProjectSnapshot, resource: ProjectResource, base = ""): string {
  const ticket = resource.ticket;
  const bodyContent = ticket ? `<div class="detail-sections">${detailSection("Context", ticket.sections.context)}${detailSection("Context-pack", ticket.sections.contextPack)}${detailSection("Acceptance criteria", ticket.sections.acceptanceCriteria)}${detailSection("How to verify", ticket.sections.howToVerify)}</div>
    <section class="panel"><div class="panel-head"><h2>交接与流转评论</h2><span class="aside">${ticket.comments.length}</span></div><div class="comments">${ticket.comments.length ? ticket.comments.map((comment) => `<article class="comment"><b>${esc(comment.actor)}</b><time>${esc(comment.at ?? "时间无效")}</time><p>${esc(comment.body)}</p></article>`).join("") : `<div class="empty">尚无评论。</div>`}</div></section>
    <details class="panel"><summary>查看源 Markdown</summary><pre class="markdown">${esc(resource.content)}</pre></details>`
    : `<section class="panel"><pre class="markdown">${esc(resource.content)}</pre></section>`;
  const body = `<section class="detail-hero"><div class="eyebrow">${esc(resource.kind)} · ${esc(resource.relativePath)}</div><h1>${esc(resource.title)}</h1><div class="detail-meta">${ticket ? `<span class="chip">${esc(ticket.summary.state)}</span><span class="chip">${esc(ticket.summary.id)}</span>${ticket.summary.episode ? `<span class="chip">EP ${ticket.summary.episode}</span>` : ""}` : ""}<span class="chip">${Math.max(1, Math.round(resource.bytes / 1024))} KB</span><span class="chip">${esc(relTime(resource.updatedAt))}</span>${resource.truncated ? `<span class="chip warn">内容超过 1 MiB，仅显示前部</span>` : ""}</div><div class="toolbar"><a class="btn" href="${esc(at(base, `/p/${enc(project.key)}`))}">← 返回项目</a><a class="btn" href="${esc(at(base, `/api/projects/${enc(project.key)}/resources/${enc(resource.kind)}/${enc(resource.id)}`))}">查看 JSON</a></div></section><div class="stack">${bodyContent}</div>`;
  return shell(resource.title, body, snapshot, project, base);
}

export function operationErrorPage(snapshot: WorkspaceSnapshot, message: string, base = ""): string {
  const body = `<section class="detail-hero"><div class="eyebrow">Operation stopped · no silent fallback</div><h1>这次操作没有完成。</h1><p class="logline">${esc(message)}</p><div class="toolbar"><a class="btn" href="${esc(at(base, "/projects/new"))}">返回立项表</a><a class="btn" href="${esc(at(base, "/"))}">返回作品书架</a></div></section><section class="panel"><h2>接下来怎么做</h2><p>请使用浏览器“返回”保留刚才填写的内容，核对提示中的字段后重新生成计划。系统不会用猜测值继续，也不会接管已经存在的目录。</p></section>`;
  return shell("操作未完成", body, snapshot, undefined, base);
}

export function notFoundPage(snapshot: WorkspaceSnapshot, message = "没有找到这部剧。", base = ""): string {
  return shell("未找到", `<section class="hero"><div><div class="eyebrow">404</div><h1>${esc(message)}</h1><p><a class="btn" href="${esc(at(base, "/"))}">返回作品书架</a></p></div></section>`, snapshot, undefined, base);
}
