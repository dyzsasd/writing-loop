// `production evidence register`：把一份权利 / 审核 / 许可证据文件登记进 workspace CAS，并输出
// 可以直接贴进批次文档（`plan-shots --input`）的对象片段。
//
// 三种 evidence 在 intent gate 里都要求一个「稳定 AssetRef」（§4.7）。在此之前，操作者只能手工算
// sha256、手工数字节、手工拼 `cas://<authority>/sha256/<digest>`，任一处抄错都要等到 gate 拒绝
// dispatch 时才暴露。本命令把这三件事合成一次：CAS 内容寻址发布（重复登记幂等）、按内容嗅探
// mediaType（不信任文件扩展名）、按 kind 拼出片段。
//
// mediaType 由内容判定而不是文件名：AssetRef 的 mediaType 会随 intent 固化进不可变证据，写错一次
// 就永远错在那里。允许的三种类型是本版证据实际会用到的形态；表外的内容一律拒绝登记，而不是
// 退化成 `application/octet-stream`。
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { PRODUCTION_CAS_AUTHORITY, ProductionError, type AssetRef } from "./production-domain.ts";
import { PRODUCTION_MODERATION_STATUSES } from "./production-intent.ts";
import { writeProductionCasObject } from "./production-cas.ts";

export const PRODUCTION_EVIDENCE_KINDS = ["rights", "moderation", "license"] as const;
export type ProductionEvidenceKind = typeof PRODUCTION_EVIDENCE_KINDS[number];

/** 允许登记的证据形态。表外内容拒绝登记——AssetRef 的 mediaType 是不可变事实，不猜。 */
export const PRODUCTION_EVIDENCE_MEDIA_TYPES = ["application/json", "application/pdf", "text/plain"] as const;

/**
 * 单份证据的安全上限。它比 CAS 的文档上限（1 MiB）宽：许可证正文与审核记录是文本，但扫描件
 * 与带附件的 PDF 会更大。证据对象只被 AssetRef 引用，本机不会把它当文档整个解析。
 */
export const MAX_PRODUCTION_EVIDENCE_BYTES = 4 * 1024 * 1024;

const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

function fail(detail: string): never {
  throw new ProductionError(`production evidence ${detail}`);
}

const errno = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;

/**
 * 有界精确读取：单链接普通文件、lstat/open 之间未被替换、读满声明长度。与 workspace CAS 的读取
 * 纪律一致，但读的是任意字节（PDF 含 NUL），因此不复用只收 UTF-8 的 `readRegularTextExact`。
 */
export function readProductionEvidenceFile(file: string, maxBytes = MAX_PRODUCTION_EVIDENCE_BYTES): Buffer {
  let before: ReturnType<typeof lstatSync>;
  try { before = lstatSync(file); }
  catch (error) {
    if (errno(error) === "ENOENT") fail(`文件不存在：${file}`);
    fail(`无法检查 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail(`${file} 必须是单链接普通文件（拒绝 symlink/hardlink/FIFO/device）`);
  }
  if (before.size === 0) fail(`${file} 是空文件；空文件不是证据`);
  if (before.size > maxBytes) fail(`${file} 超过 ${maxBytes} bytes 安全上限（实得 ${before.size}）`);
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== before.size) {
      fail(`${file} 在 lstat/open 间被替换`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail(`${file} 读取期间被截断`);
      offset += count;
    }
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * 按内容判定 mediaType，判不出即 null（调用方拒绝登记）：
 *   - `%PDF-` 魔数 ⇒ application/pdf；
 *   - 可往返的 UTF-8，且去空白后以 `{` / `[` 开头并能 JSON 解析 ⇒ application/json；
 *   - 其余可往返的 UTF-8，且除制表 / 换行 / 回车外无控制字符 ⇒ text/plain。
 *
 * JSON 判据要求以 `{` / `[` 开头：一份只写了 `20260902` 的纯文本也是合法 JSON 标量，但它是文本证据，
 * 不是 JSON 文档。以 `{` / `[` 开头却解析失败的不是「判不出」，而是回落到文本判据：带 BOM 的 JSON、
 * 以 `[Exhibit A]` 开头的许可证正文都长这样，它们是货真价实的文本证据。
 */
export function sniffProductionEvidenceMediaType(bytes: Buffer): string | null {
  if (bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return "application/pdf";
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { JSON.parse(text); return "application/json"; }
    catch { /* 不是 JSON 文档就按文本判据继续 */ }
  }
  return TEXT_CONTROL.test(text) ? null : "text/plain";
}

export type ProductionEvidenceRegistration = {
  version: 1;
  kind: ProductionEvidenceKind;
  sha256: string;
  byteLength: number;
  mediaType: string;
  /** 本次是否新建 CAS 对象；重复登记同一份文件为 false（内容寻址，字节相同即同一对象）。 */
  casObjectCreated: boolean;
  path: string;
  asset: AssetRef;
  /** 可直接贴进批次文档 `rights` / `moderation` / `license` 段的对象片段。 */
  fragment: Record<string, unknown>;
};

export type RegisterProductionEvidenceOptions = {
  root: string;
  project: string;
  kind: ProductionEvidenceKind;
  file: string;
  /** workspace CAS 的 authority（runtime config 的 `localAssetSource.casAuthority`）。 */
  casAuthority: string;
  /**
   * `--kind moderation` 必填、其余 kind 必须省略：审核结论与审核时刻是这份文件之外的人工事实，
   * 命令代填等于凭空写出一次「已通过」。`status` 取 intent 侧 `parseModeration` 的接受集，
   * `reviewedAt` 是规范 UTC ISO。
   */
  moderation?: { status: string; reviewedAt: string };
};

export function registerProductionEvidence(
  options: RegisterProductionEvidenceOptions,
): ProductionEvidenceRegistration {
  if (!(PRODUCTION_EVIDENCE_KINDS as readonly string[]).includes(options.kind)) {
    fail(`--kind 必须是 ${PRODUCTION_EVIDENCE_KINDS.join(" | ")}`);
  }
  if (!PRODUCTION_CAS_AUTHORITY.test(options.casAuthority)) fail("casAuthority 必须是小写 CAS authority（如 wl-sg）");
  const moderation = options.moderation;
  if (options.kind === "moderation") {
    if (moderation === undefined) fail("--kind moderation 必须同时给出 --status 与 --reviewed-at");
    if (!(PRODUCTION_MODERATION_STATUSES as readonly string[]).includes(moderation.status)) {
      fail(`--status 必须是 ${PRODUCTION_MODERATION_STATUSES.join(" | ")}`);
    }
    if (typeof moderation.reviewedAt !== "string" || moderation.reviewedAt.length > 64
      || !Number.isFinite(Date.parse(moderation.reviewedAt))
      || new Date(Date.parse(moderation.reviewedAt)).toISOString() !== moderation.reviewedAt) {
      fail("--reviewed-at 必须是规范 UTC ISO-8601 时间");
    }
  } else if (moderation !== undefined) {
    fail(`--status 与 --reviewed-at 只属于 --kind moderation（本次是 ${options.kind}）`);
  }
  const bytes = readProductionEvidenceFile(options.file);
  const mediaType = sniffProductionEvidenceMediaType(bytes);
  if (mediaType === null) {
    fail(`${options.file} 的内容不属于允许的证据形态`
      + `（${PRODUCTION_EVIDENCE_MEDIA_TYPES.join("、")}）；扩展名不参与判定`);
  }
  const written = writeProductionCasObject(options.root, options.project, bytes);
  const asset: AssetRef = {
    version: 1,
    uri: `cas://${options.casAuthority}/sha256/${written.sha256}`,
    sha256: written.sha256,
    byteLength: bytes.length,
    mediaType,
  };
  // 片段只填「这份文件能取证的部分」：rights 的地域与有效期、license 的签发方与义务都是人工事实，
  // 由操作者在批次文档里补齐，命令不代填也不猜。moderation 的结论与时刻同样是人工事实，因此由
  // `--status` / `--reviewed-at` 原样带入，而不是默认写成 passed + 登记时刻。
  const fragment: Record<string, unknown> = options.kind === "rights"
    ? { evidence: asset }
    : options.kind === "moderation"
      ? { status: moderation!.status, reviewedAt: moderation!.reviewedAt, evidence: asset }
      : { licenseSha256: written.sha256, evidence: asset };
  return {
    version: 1,
    kind: options.kind,
    sha256: written.sha256,
    byteLength: bytes.length,
    mediaType,
    casObjectCreated: written.created,
    path: written.path,
    asset,
    fragment,
  };
}
