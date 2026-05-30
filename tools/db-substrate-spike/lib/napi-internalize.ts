/**
 * Prototype of the napi-binary internalization loader (T11326 / D14′).
 *
 * Proves the mechanism by which CLEO ships native addons (worktree-napi,
 * cant-napi) with ZERO separate per-binary OIDC npm publishes:
 *
 *   - **Pattern P2 (primary)**: a `postinstall` step fetches the platform
 *     binary from a GitHub Release asset, then verifies its SHA-256 against a
 *     checked-in manifest. FAIL-CLOSED: a checksum mismatch (or fetch failure
 *     with no fallback) aborts install rather than running an unverified blob.
 *   - **Pattern P1 (fallback)**: the `linux-x64-gnu` binary is bundled inside
 *     the `@cleocode/core` tarball, so `npm install --ignore-scripts` (which
 *     skips P2) still has a working binary on the most common CI/runtime
 *     target.
 *   - **`CLEO_NAPI_BINARY_MIRROR`**: an env override redirecting the P2 fetch
 *     base URL to a corporate proxy / air-gapped mirror.
 *
 * This module is the resolver/verifier that BOTH `postinstall` and the runtime
 * loader call. It is dependency-free and side-effect-free per call so it can be
 * unit-tested deterministically (fetch + fs are injected).
 *
 * @task T11326
 * @task T11244
 * @saga T11242
 */
import { createHash } from 'node:crypto';

/** A platform key in napi-rs triple form (`<platform>-<arch>-<abi>`). */
export type NapiTriple =
  | 'linux-x64-gnu'
  | 'linux-arm64-gnu'
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'win32-x64-msvc';

/** One checked-in manifest entry: triple → expected sha256 + asset name. */
export interface NapiManifestEntry {
  /** Expected lowercase-hex SHA-256 of the binary asset. */
  sha256: string;
  /** GitHub Release asset filename for this triple. */
  asset: string;
}

/** The checked-in manifest: every supported triple's expected checksum. */
export type NapiManifest = Readonly<Record<NapiTriple, NapiManifestEntry>>;

/** Result of resolving + verifying a binary for one triple. */
export interface ResolveResult {
  triple: NapiTriple;
  /** Which strategy supplied the bytes. */
  source: 'p2-fetch' | 'p1-bundled-fallback';
  /** Whether the SHA-256 matched the manifest (fail-closed when false). */
  verified: boolean;
  /** The URL fetched (P2) or bundled path (P1). */
  origin: string;
  /** Error message when resolution failed-closed. */
  error?: string;
}

/** Injectable dependencies so the resolver is unit-testable offline. */
export interface ResolveDeps {
  /** Fetch the asset bytes for a URL, or throw on network failure. */
  fetchAsset(url: string): Promise<Uint8Array>;
  /** Read the bundled P1 fallback bytes, or `null` when not present. */
  readBundled(triple: NapiTriple): Uint8Array | null;
  /** The P2 release base URL (already mirror-resolved). */
  releaseBaseUrl: string;
}

/** Compute the lowercase-hex SHA-256 of a byte buffer. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Resolve the GitHub Release base URL, honoring `CLEO_NAPI_BINARY_MIRROR`.
 *
 * @param defaultBase - The default GitHub Release base URL.
 * @param env - The environment map (defaults to `process.env`).
 * @returns The effective base URL (mirror override wins).
 */
export function resolveReleaseBaseUrl(
  defaultBase: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const mirror = env['CLEO_NAPI_BINARY_MIRROR'];
  return mirror && mirror.length > 0 ? mirror.replace(/\/$/, '') : defaultBase;
}

/**
 * Resolve + verify the native binary for a triple using Pattern P2 (fetch +
 * checksum) with Pattern P1 (bundled fallback) on fetch failure. FAIL-CLOSED:
 * a checksum mismatch never returns `verified: true`.
 *
 * @param triple - The target platform triple.
 * @param manifest - The checked-in checksum manifest.
 * @param deps - Injected fetch/fs/base-url dependencies.
 * @returns The {@link ResolveResult}.
 */
export async function resolveNapiBinary(
  triple: NapiTriple,
  manifest: NapiManifest,
  deps: ResolveDeps,
): Promise<ResolveResult> {
  const entry = manifest[triple];
  if (!entry) {
    return {
      triple,
      source: 'p2-fetch',
      verified: false,
      origin: '',
      error: `no manifest entry for triple ${triple}`,
    };
  }
  const url = `${deps.releaseBaseUrl}/${entry.asset}`;

  // Pattern P2 — fetch from the (possibly mirrored) GitHub Release.
  try {
    const bytes = await deps.fetchAsset(url);
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256) {
      // FAIL-CLOSED on checksum mismatch — do NOT silently fall back, a
      // mismatch is a tamper/corruption signal, not a missing-asset signal.
      return {
        triple,
        source: 'p2-fetch',
        verified: false,
        origin: url,
        error: `sha256 mismatch: expected ${entry.sha256}, got ${actual}`,
      };
    }
    return { triple, source: 'p2-fetch', verified: true, origin: url };
  } catch (fetchErr) {
    // Pattern P1 — fetch failed (offline / --ignore-scripts environment).
    // Try the bundled fallback (only ships for linux-x64-gnu).
    const bundled = deps.readBundled(triple);
    if (bundled === null) {
      return {
        triple,
        source: 'p2-fetch',
        verified: false,
        origin: url,
        error:
          `P2 fetch failed (${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}) ` +
          `and no P1 bundled fallback exists for ${triple}`,
      };
    }
    const actual = sha256Hex(bundled);
    if (actual !== entry.sha256) {
      return {
        triple,
        source: 'p1-bundled-fallback',
        verified: false,
        origin: `bundled:${entry.asset}`,
        error: `bundled fallback sha256 mismatch: expected ${entry.sha256}, got ${actual}`,
      };
    }
    return {
      triple,
      source: 'p1-bundled-fallback',
      verified: true,
      origin: `bundled:${entry.asset}`,
    };
  }
}
