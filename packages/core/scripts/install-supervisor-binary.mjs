#!/usr/bin/env node
/**
 * Postinstall picker for the cleo-supervisor native binary
 * (T11340 — SG-RUNTIME-UNIFICATION R1, Distribution Pattern P2/P1).
 *
 * Resolution + verification flow:
 *
 *   1. Resolve the platform triple from `process.platform` + `process.arch` +
 *      libc (gnu/musl on Linux). Supported: linux-x64-gnu, linux-arm64-gnu,
 *      darwin-x64, darwin-arm64, win32-x64-msvc.
 *   2. Read the sha256 manifest CHECKED INTO this package (P2 — pinned at
 *      publish time, never fetched). The manifest pins the GitHub Release
 *      base URL + per-triple sha256 + filename.
 *   3. If the binary is already cached + sha256-valid, reuse it (idempotent).
 *   4. Otherwise download `<baseUrl>/<file>` (base URL overridable via
 *      `CLEO_NAPI_BINARY_MIRROR`), verify sha256 against the manifest
 *      (FAIL CLOSED on mismatch), write atomically (tmp-then-rename), chmod +x.
 *   5. P1 fallback: when the download is unavailable (offline, `--ignore-scripts`
 *      so this never ran, or a mirror outage) AND the bundled
 *      `binaries/fallback/cleo-supervisor` matches the host triple
 *      (linux-x64-gnu), use it.
 *
 * postinstall MUST NOT fail the install — a missing supervisor binary degrades
 * gracefully (the daemon feature is unavailable until the binary is resolved on
 * first use). This script therefore exits 0 even on download failure, logging a
 * diagnostic. The fail-closed sha256 check applies to the BYTES (a tampered
 * download is rejected); it does not abort `npm install`.
 *
 * @task T11340
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Package root: packages/core (scripts/ is a direct child). */
const PKG_ROOT = join(__dirname, '..');

/** Path to the sha256 manifest checked into the tarball (P2). */
const MANIFEST_PATH = join(PKG_ROOT, 'binaries', 'cleo-supervisor-manifest.json');

/** Bundled P1 fallback binary (linux-x64-gnu only). */
const FALLBACK_BIN = join(PKG_ROOT, 'binaries', 'fallback', 'cleo-supervisor');

/** The single triple the P1 fallback binary targets. */
const FALLBACK_TRIPLE = 'linux-x64-gnu';

/**
 * Resolve the platform triple for the current host.
 *
 * @returns {{ triple: string; ext: string } | null} Triple + binary extension,
 *   or null if the host platform/arch is unsupported.
 */
function resolveTriple() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'linux' && a === 'x64') return { triple: 'linux-x64-gnu', ext: '' };
  if (p === 'linux' && a === 'arm64') return { triple: 'linux-arm64-gnu', ext: '' };
  if (p === 'darwin' && a === 'x64') return { triple: 'darwin-x64', ext: '' };
  if (p === 'darwin' && a === 'arm64') return { triple: 'darwin-arm64', ext: '' };
  if (p === 'win32' && a === 'x64') return { triple: 'win32-x64-msvc', ext: '.exe' };
  return null;
}

/**
 * Detect whether the Linux host uses musl libc (Alpine et al.). The published
 * Linux binaries are gnu-only; a musl host has no matching prebuild and falls
 * through to the descriptive "unsupported" path.
 *
 * @returns {boolean} True when the host appears to be musl-based.
 */
function isMuslLinux() {
  if (osPlatform() !== 'linux') return false;
  try {
    // The simplest robust signal available without spawning: the ldd report
    // embedded in process.report (Node exposes glibc/musl there on Linux).
    const report =
      typeof process.report?.getReport === 'function' ? process.report.getReport() : null;
    const glibc = report?.header?.glibcVersionRuntime;
    // glibcVersionRuntime present => glibc; absent on musl.
    return !glibc;
  } catch {
    return false;
  }
}

/** Compute the sha256 hex digest of a buffer. */
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Cache directory for the resolved binary: `<cache>/cleo/napi-bin/<version>/`. */
function cacheDir(version) {
  // Mirror env-paths('cleo', {suffix:''}).cache without importing @cleocode/paths
  // (this script runs in postinstall where workspace deps may not be linked yet).
  const p = process.platform;
  if (p === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(local, 'cleo', 'Cache', 'napi-bin', version);
  }
  if (p === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'cleo', 'napi-bin', version);
  }
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.startsWith('/') ? xdg : join(homedir(), '.cache');
  return join(base, 'cleo', 'napi-bin', version);
}

/** Write `buf` to `dest` atomically (tmp-then-rename) and chmod +x. */
function writeBinaryAtomic(dest, buf) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, buf);
  chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
}

/** Use the bundled P1 fallback if it matches the host triple. */
function tryFallback(triple, dest) {
  if (triple !== FALLBACK_TRIPLE || !existsSync(FALLBACK_BIN)) return false;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.fallback.tmp`;
    copyFileSync(FALLBACK_BIN, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, dest);
    console.log(`[cleo-supervisor] using bundled P1 fallback for ${triple}`);
    return true;
  } catch (err) {
    console.warn(`[cleo-supervisor] fallback copy failed: ${err?.message ?? err}`);
    return false;
  }
}

async function main() {
  const resolved = resolveTriple();
  if (!resolved) {
    console.warn(
      `[cleo-supervisor] no prebuilt binary for ${process.platform}/${process.arch}` +
        (isMuslLinux() ? ' (musl libc — only gnu Linux prebuilds are published)' : '') +
        ' — daemon features will be unavailable.',
    );
    return; // graceful: do not fail install
  }
  const { triple, ext } = resolved;

  if (!existsSync(MANIFEST_PATH)) {
    console.warn(
      `[cleo-supervisor] manifest missing at ${MANIFEST_PATH} — skipping binary install` +
        ' (development checkout or --ignore-scripts publish).',
    );
    return;
  }

  /** @type {{version:string; baseUrl:string; binaries:Record<string,{file:string; sha256:string; size:number}>}} */
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const entry = manifest.binaries?.[triple];
  if (!entry) {
    console.warn(`[cleo-supervisor] manifest has no entry for ${triple} — skipping.`);
    return;
  }

  const dest = join(cacheDir(manifest.version), `cleo-supervisor${ext}`);

  // Idempotent: reuse a cached binary that already matches the pinned sha256.
  if (existsSync(dest)) {
    try {
      if (sha256(readFileSync(dest)) === entry.sha256) {
        console.log(`[cleo-supervisor] cached binary OK at ${dest}`);
        return;
      }
    } catch {
      // fall through to re-download
    }
  }

  // CLEO_NAPI_BINARY_MIRROR overrides the download base URL (corporate proxies).
  const mirror = process.env.CLEO_NAPI_BINARY_MIRROR?.replace(/\/+$/, '');
  const base = mirror ?? manifest.baseUrl;
  const url = `${base}/${entry.file}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const digest = sha256(buf);
    if (digest !== entry.sha256) {
      // FAIL CLOSED on the bytes — never install a tampered binary.
      throw new Error(
        `sha256 mismatch for ${triple}: expected ${entry.sha256}, got ${digest} — refusing to install`,
      );
    }
    writeBinaryAtomic(dest, buf);
    console.log(`[cleo-supervisor] installed ${triple} -> ${dest} (sha256 verified)`);
  } catch (err) {
    console.warn(`[cleo-supervisor] download failed: ${err?.message ?? err}`);
    if (tryFallback(triple, dest)) return;
    // Clean a partial cache entry, then degrade gracefully.
    try {
      rmSync(dest, { force: true });
    } catch {
      /* ignore */
    }
    console.warn(
      `[cleo-supervisor] binary unavailable for ${triple}; daemon features deferred until first use.`,
    );
  }
}

main().catch((err) => {
  // postinstall must never break `npm install`.
  console.warn(`[cleo-supervisor] postinstall picker error (non-fatal): ${err?.message ?? err}`);
  process.exit(0);
});
