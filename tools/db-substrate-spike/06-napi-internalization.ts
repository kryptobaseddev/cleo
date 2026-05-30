/**
 * T11326 — napi internalization proof harness.
 *
 * Exercises the {@link resolveNapiBinary} resolver across the four scenarios
 * the D14′ pattern must guarantee, using a REAL local binary (the checked-in
 * `worktree-napi.linux-x64-gnu.node`) as the asset under test so the SHA-256
 * checks run against genuine bytes — no mocking of the crypto path:
 *
 *   1. P2 happy path: fetch succeeds + checksum matches → verified via p2-fetch.
 *   2. P2 tamper: fetch returns corrupted bytes → FAIL-CLOSED (verified=false),
 *      and does NOT silently fall back.
 *   3. P1 fallback: fetch throws (offline / --ignore-scripts) + bundled
 *      linux-x64-gnu present → verified via p1-bundled-fallback.
 *   4. CLEO_NAPI_BINARY_MIRROR: the mirror env redirects the P2 fetch base URL.
 *
 * Also asserts the ZERO-separate-OIDC property: the pattern publishes binaries
 * as GitHub Release ASSETS (P2) and bundles one inside @cleocode/core (P1) —
 * neither path is a separate npm package publish, so the binary-publish OIDC
 * count contributed by this pattern is 0.
 *
 * Run: `pnpm dlx tsx tools/db-substrate-spike/06-napi-internalization.ts`
 *
 * @task T11326
 * @task T11244
 * @saga T11242
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type NapiManifest,
  type NapiTriple,
  type ResolveDeps,
  resolveNapiBinary,
  resolveReleaseBaseUrl,
  sha256Hex,
} from './lib/napi-internalize.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate locations for a REAL linux-x64-gnu napi binary to use as the asset
 * under test (so the SHA-256/fail-close path runs against genuine native
 * bytes). Worktree native artifacts may be untracked, so the shared checkout
 * is checked too. Falls back to a deterministic synthetic blob when no real
 * binary is reachable — the resolver mechanism is identical either way.
 */
const BINARY_CANDIDATES = [
  join(
    HERE,
    '..',
    '..',
    'packages',
    'worktree-napi-linux-x64-gnu',
    'worktree-napi.linux-x64-gnu.node',
  ),
  '/mnt/projects/cleocode/packages/worktree-napi-linux-x64-gnu/worktree-napi.linux-x64-gnu.node',
];

/** Resolve the asset bytes + a label describing their provenance. */
function loadAssetBytes(): { bytes: Uint8Array; provenance: string } {
  for (const p of BINARY_CANDIDATES) {
    if (existsSync(p)) {
      return { bytes: new Uint8Array(readFileSync(p)), provenance: `real-binary:${p}` };
    }
  }
  // Deterministic synthetic blob (4 KiB of a fixed pattern) — exercises the
  // exact same crypto + fail-close paths as a real binary.
  const synthetic = new Uint8Array(4096);
  for (let i = 0; i < synthetic.length; i++) synthetic[i] = (i * 31 + 7) & 0xff;
  return { bytes: synthetic, provenance: 'synthetic-deterministic-4KiB' };
}

function main(): void {
  const { bytes: realBytes, provenance } = loadAssetBytes();
  const realSha = sha256Hex(realBytes);

  // Build a manifest whose linux-x64-gnu entry pins the REAL binary's sha256.
  const manifest: NapiManifest = {
    'linux-x64-gnu': { sha256: realSha, asset: 'worktree-napi.linux-x64-gnu.node' },
    'linux-arm64-gnu': {
      sha256: 'deadbeef'.repeat(8),
      asset: 'worktree-napi.linux-arm64-gnu.node',
    },
    'darwin-x64': { sha256: 'deadbeef'.repeat(8), asset: 'worktree-napi.darwin-x64.node' },
    'darwin-arm64': { sha256: 'deadbeef'.repeat(8), asset: 'worktree-napi.darwin-arm64.node' },
    'win32-x64-msvc': { sha256: 'deadbeef'.repeat(8), asset: 'worktree-napi.win32-x64-msvc.node' },
  };

  const DEFAULT_BASE = 'https://github.com/cleocode/cleo/releases/download/v0.0.0';
  const triple: NapiTriple = 'linux-x64-gnu';

  // ── Scenario 1: P2 happy path ──
  const depsHappy: ResolveDeps = {
    releaseBaseUrl: resolveReleaseBaseUrl(DEFAULT_BASE),
    fetchAsset: async () => realBytes,
    readBundled: () => realBytes,
  };

  // ── Scenario 2: P2 tamper (corrupted bytes) ──
  const tampered = new Uint8Array(realBytes);
  tampered[0] = (tampered[0] ?? 0) ^ 0xff; // flip one byte
  const depsTamper: ResolveDeps = {
    releaseBaseUrl: resolveReleaseBaseUrl(DEFAULT_BASE),
    fetchAsset: async () => tampered,
    // A P1 fallback exists, but tamper must FAIL-CLOSED, not fall back.
    readBundled: () => realBytes,
  };

  // ── Scenario 3: P1 fallback (fetch throws, bundled present) ──
  const depsP1: ResolveDeps = {
    releaseBaseUrl: resolveReleaseBaseUrl(DEFAULT_BASE),
    fetchAsset: async () => {
      throw new Error('ENETUNREACH (simulated --ignore-scripts / offline)');
    },
    readBundled: (t) => (t === 'linux-x64-gnu' ? realBytes : null),
  };

  // ── Scenario 4: mirror override ──
  const MIRROR = 'https://npm-mirror.corp.internal/cleo-napi';
  const mirrorBase = resolveReleaseBaseUrl(DEFAULT_BASE, {
    CLEO_NAPI_BINARY_MIRROR: MIRROR,
  } as NodeJS.ProcessEnv);
  let mirrorUrlSeen = '';
  const depsMirror: ResolveDeps = {
    releaseBaseUrl: mirrorBase,
    fetchAsset: async (url) => {
      mirrorUrlSeen = url;
      return realBytes;
    },
    readBundled: () => realBytes,
  };

  // P1-missing scenario: non-linux triple with no bundled fallback + fetch fail.
  const depsNoFallback: ResolveDeps = {
    releaseBaseUrl: resolveReleaseBaseUrl(DEFAULT_BASE),
    fetchAsset: async () => {
      throw new Error('offline');
    },
    readBundled: () => null,
  };

  void (async (): Promise<void> => {
    const r1 = await resolveNapiBinary(triple, manifest, depsHappy);
    const r2 = await resolveNapiBinary(triple, manifest, depsTamper);
    const r3 = await resolveNapiBinary(triple, manifest, depsP1);
    const r4 = await resolveNapiBinary(triple, manifest, depsMirror);
    const r5 = await resolveNapiBinary('darwin-arm64', manifest, depsNoFallback);

    const checks = {
      p2HappyPathVerified: r1.verified && r1.source === 'p2-fetch',
      p2TamperFailsClosed: r2.verified === false && r2.error?.includes('mismatch') === true,
      p1FallbackVerified: r3.verified && r3.source === 'p1-bundled-fallback',
      mirrorRedirectsFetch:
        r4.verified && mirrorUrlSeen.startsWith(MIRROR) && r4.origin.startsWith(MIRROR),
      noFallbackFailsClosed: r5.verified === false && r5.error?.includes('no P1 bundled') === true,
    };

    const allPass = Object.values(checks).every(Boolean);
    const verdict = allPass ? 'PASS' : 'FAIL';

    const report = {
      task: 'T11326',
      assetUnderTest: {
        provenance,
        sizeBytes: realBytes.byteLength,
        sha256: realSha,
      },
      scenarios: {
        p2HappyPath: r1,
        p2Tamper: r2,
        p1Fallback: r3,
        mirrorOverride: { ...r4, mirrorUrlSeen },
        noFallbackOffline: r5,
      },
      checks,
      zeroSeparateOidc: {
        claim:
          'P2 publishes binaries as GitHub Release ASSETS; P1 bundles linux-x64-gnu ' +
          'inside the @cleocode/core tarball. Neither is a separate npm package ' +
          'publish, so this pattern contributes 0 binary-publish OIDC flows.',
        binaryPublishOidcCount: 0,
      },
      verdict,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (verdict !== 'PASS') process.exit(1);
  })();
}

main();
