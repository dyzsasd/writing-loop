// Worker-side read port for the control-plane copy of an immutable input object (§6.4).
//
// The gateway's `cas://` resolver reads the GPU VM's own store, so a `cas://` input that only exists
// in the workspace CAS on the control-plane host has no path to it. This port is that host's side of
// the bridge: it turns one AssetRef back into the exact bytes the digest names, for the stager to
// upload and for the binding verifier to re-derive per-shot values from instead of trusting a stage
// receipt's projection of them.
//
// The identity is checked on the way out, not assumed: the URI must be `cas://<authority>/sha256/
// <digest>` for the authority this source was configured with, and the bytes read back must hash to
// that digest and have exactly the length the AssetRef pins.
import { PRODUCTION_CAS_AUTHORITY, type AssetRef } from "./production-domain.ts";
import { ProductionCasError, readProductionCasObjectAsync } from "./production-cas.ts";

/** Bounded read ceiling. A keyframe fits; nothing here streams, so the bound is also a memory bound. */
export const DEFAULT_PRODUCTION_LOCAL_ASSET_BYTES = 64 * 1024 * 1024;

export type ProductionLocalAssetSourceErrorCode =
  /** The URI is not a `cas://` object this port can answer for. */
  | "unsupported-uri"
  /** A `cas://` URI naming a CAS other than the one this source holds. */
  | "authority-mismatch"
  | "not-found"
  | "asset-too-large"
  /** The stored bytes are not the object the AssetRef names (length or digest). */
  | "asset-integrity"
  | "read-failed";

/** Persistence-safe error: it carries a stable code and no path, byte or credential. */
export class ProductionLocalAssetSourceError extends Error {
  readonly code: ProductionLocalAssetSourceErrorCode;

  constructor(code: ProductionLocalAssetSourceErrorCode) {
    super(`production local asset source ${code}`);
    this.name = "ProductionLocalAssetSourceError";
    this.code = code;
  }
}

export interface ProductionLocalAssetSource {
  /** The single CAS authority this source is the local copy of. */
  readonly casAuthority: string;
  /** Exact bytes for one AssetRef; throws `ProductionLocalAssetSourceError` rather than returning a miss. */
  read(asset: Readonly<AssetRef>, signal?: AbortSignal): Promise<Uint8Array>;
}

const SHA256 = /^[a-f0-9]{64}$/;

function fail(code: ProductionLocalAssetSourceErrorCode): never {
  throw new ProductionLocalAssetSourceError(code);
}

/**
 * `cas://<authority>/sha256/<digest>` with the digest agreeing with the AssetRef's own `sha256`.
 * Returns the authority, or null when the URI is not a well-formed CAS object reference.
 */
export function productionCasAssetAuthority(asset: Readonly<AssetRef>): string | null {
  if (typeof asset.uri !== "string" || !asset.uri.startsWith("cas://")) return null;
  let url: URL;
  try { url = new URL(asset.uri); }
  catch { return null; }
  const authority = url.hostname.toLowerCase();
  if (url.protocol !== "cas:" || url.username || url.password || url.port || url.search || url.hash
    || !PRODUCTION_CAS_AUTHORITY.test(authority) || typeof asset.sha256 !== "string" || !SHA256.test(asset.sha256)
    || url.pathname !== `/sha256/${asset.sha256}`) {
    return null;
  }
  return authority;
}

export type WorkspaceCasLocalAssetSourceOptions = {
  /** Workspace root; the objects live under `<root>/.writing-loop/<project>/production-cas.v1`. */
  root: string;
  project: string;
  casAuthority: string;
  maxObjectBytes?: number;
};

/**
 * The `production-cas.ts` store as a local asset source. `readProductionCasObject` already refuses a
 * symlink, a hardlink, a file that changed between lstat and open, and a body whose digest no longer
 * matches its name, so what remains here is the AssetRef-level agreement: authority, digest, length.
 */
export class WorkspaceCasLocalAssetSource implements ProductionLocalAssetSource {
  readonly #root: string;
  readonly #project: string;
  readonly #maxObjectBytes: number;
  readonly casAuthority: string;

  constructor(options: WorkspaceCasLocalAssetSourceOptions) {
    if (!options || typeof options !== "object" || typeof options.root !== "string" || !options.root
      || typeof options.project !== "string" || typeof options.casAuthority !== "string"
      || !PRODUCTION_CAS_AUTHORITY.test(options.casAuthority)) {
      throw new TypeError("production local asset source 配置无效");
    }
    const maximum = options.maxObjectBytes ?? DEFAULT_PRODUCTION_LOCAL_ASSET_BYTES;
    if (!Number.isSafeInteger(maximum) || maximum < 1_024 || maximum > 4 * 1024 * 1024 * 1024) {
      throw new TypeError("production local asset source maxObjectBytes 无效");
    }
    this.#root = options.root;
    this.#project = options.project;
    this.#maxObjectBytes = maximum;
    this.casAuthority = options.casAuthority;
  }

  async read(asset: Readonly<AssetRef>, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) fail("read-failed");
    const authority = productionCasAssetAuthority(asset);
    if (authority === null) fail("unsupported-uri");
    if (authority !== this.casAuthority) fail("authority-mismatch");
    if (!Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1) fail("asset-integrity");
    if (asset.byteLength > this.#maxObjectBytes) fail("asset-too-large");
    let bytes: Buffer | null;
    try {
      bytes = await readProductionCasObjectAsync(
        this.#root, this.#project, asset.sha256, this.#maxObjectBytes, signal,
      );
    } catch (error) {
      if (signal?.aborted) fail("read-failed");
      // The store's own code says which of the two this is: a workspace or project state directory
      // that is not there means this host simply has no such object, while a file that is there but
      // is not what its name claims is corruption and must not be reported as a miss.
      if (error instanceof ProductionCasError) {
        if (error.code === "store-absent") fail("not-found");
        if (error.code === "object-integrity") fail("asset-integrity");
        if (error.code === "object-too-large") fail("asset-too-large");
      }
      fail("read-failed");
    }
    if (bytes === null) fail("not-found");
    if (bytes.byteLength !== asset.byteLength) fail("asset-integrity");
    return bytes;
  }
}
