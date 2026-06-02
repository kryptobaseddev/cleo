#!/usr/bin/env node
/**
 * Shared postinstall picker for CLEO-managed native binaries
 * (T11580 — R10-L1 · SG-PACKAGE-ARCH; generalizes the T11340 supervisor picker).
 *
 * Two binaries flow through this single picker:
 *
 *   - `cleo-supervisor` — the standalone process supervisor executable
 *     (`crates/cleo-supervisor`). A single exec per triple.
 *   - `worktree-napi`    — the napi-rs Node-API addon (`crates/worktree-napi`)
 *     consumed by `@cleocode/worktree`. The host-triple `.node` is cached so the
 *     worktree loader resolves a core-managed path instead of bundling all four
 *     `.node` files in the `@cleocode/worktree` tarball.
 *
 * Both follow Distribution Pattern P2 (primary) + P1 (fallback):
 *
 *   1. Resolve the platform triple from `process.platform` + `process.arch` +
 *      libc (gnu/musl on Linux).
 *   2. Read the sha256 manifest CHECKED INTO this package (P2 — pinned at
 *      publish time, never fetched). The manifest pins the GitHub Release base
 *      URL + per-triple sha256 + filename.
 *   3. If the binary is already cached + sha256-valid, reuse it (idempotent).
 *   4. Otherwise download `<baseUrl>/<file>` (base URL overridable via
 *      `CLEO_NAPI_BINARY_MIRROR`), verify sha256 against the manifest
 *      (FAIL CLOSED on mismatch), write atomically (tmp-then-rename), chmod +x
 *      for executables.
 *   5. P1 fallback: when the download is unavailable (offline, `--ignore-scripts`
 *      so this never ran, or a mirror outage) AND the bundled
 *      `binaries/fallback/<fallbackFile>` matches the host triple
 *      (linux-x64-gnu), use it.
 *
 * postinstall MUST NOT fail the install — a missing binary degrades gracefully
 * (the dependent feature is resolved on first use). Callers therefore exit 0
 * even on download failure, logging a diagnostic. The fail-closed sha256 check
 * applies to the BYTES (a tampered download is rejected); it does not abort
 * `npm install`.
 *
 * @task T11580
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

/** The single triple every P1 fallback binary targets. */
export const FALLBACK_TRIPLE = 'linux-x64-gnu';

/**
 * Resolve the platform triple for the current host.
 *
 * @returns {{ triple: string; ext: string } | null} Triple + executable
 *   extension (`.exe` on Windows, `''` elsewhere), or null if the host
 *   platform/arch is unsupported. `ext` only applies to standalone
 *   executables; napi `.node` addons ignore it.
 */
export function resolveTriple() {
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
export function isMuslLinux() {
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
export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Cache directory for resolved native binaries:
 * `<cache>/cleo/napi-bin/<version>/`.
 *
 * Mirrors `env-paths('cleo', {suffix:''}).cache` without importing
 * `@cleocode/paths` (this runs in postinstall where workspace deps may not be
 * linked yet).
 *
 * @param {string} version - The manifest version segment.
 * @returns {string} Absolute cache directory path.
 */
export function cacheDir(version) {
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

/**
 * Write `buf` to `dest` atomically (tmp-then-rename). Executables are chmod'd
 * +x; napi `.node` addons are loaded by `require()` and need no exec bit.
 *
 * @param {string} dest - Destination path.
 * @param {Buffer} buf - Bytes to write.
 * @param {boolean} executable - Whether to chmod 0o755.
 */
function writeBinaryAtomic(dest, buf, executable) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, buf);
  if (executable) chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
}

/**
 * Copy the bundled P1 fallback into the cache if it matches the host triple.
 *
 * @param {object} spec - The binary spec (see {@link pickBinary}).
 * @param {string} triple - The resolved host triple.
 * @param {string} dest - Cache destination path.
 * @returns {boolean} True when the fallback was used.
 */
function tryFallback(spec, triple, dest) {
  if (triple !== FALLBACK_TRIPLE || !existsSync(spec.fallbackPath)) return false;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.fallback.tmp`;
    copyFileSync(spec.fallbackPath, tmp);
    if (spec.executable) chmodSync(tmp, 0o755);
    renameSync(tmp, dest);
    console.log(`[${spec.label}] using bundled P1 fallback for ${triple}`);
    return true;
  } catch (err) {
    console.warn(`[${spec.label}] fallback copy failed: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * @typedef {object} BinarySpec
 * @property {string} label - Diagnostic label, e.g. `cleo-supervisor`.
 * @property {string} manifestPath - Absolute path to the checked-in sha256
 *   manifest (P2).
 * @property {string} fallbackPath - Absolute path to the bundled P1 fallback
 *   binary (linux-x64-gnu).
 * @property {boolean} executable - Whether the resolved binary is a standalone
 *   executable (`true` → chmod +x) or a napi `.node` addon (`false`).
 * @property {(triple: string, ext: string) => string} cachedName - The basename
 *   the binary is cached under in `<cache>/napi-bin/<version>/`. Supervisor uses
 *   `cleo-supervisor<ext>`; worktree-napi uses `worktree-napi.<triple>.node`.
 */

/**
 * Resolve a single CLEO-managed native binary into the shared cache following
 * Distribution Pattern P2 (download + sha256) with a P1 (bundled fallback) safety
 * net. Never throws to the caller for install-failure conditions — degrades
 * gracefully and logs.
 *
 * @param {BinarySpec} spec - The per-binary distribution spec.
 * @returns {Promise<void>}
 */
export async function pickBinary(spec) {
  const resolved = resolveTriple();
  if (!resolved) {
    console.warn(
      `[${spec.label}] no prebuilt binary for ${process.platform}/${process.arch}` +
        (isMuslLinux() ? ' (musl libc — only gnu Linux prebuilds are published)' : '') +
        ' — feature unavailable until resolved on first use.',
    );
    return; // graceful: do not fail install
  }
  const { triple, ext } = resolved;

  if (!existsSync(spec.manifestPath)) {
    console.warn(
      `[${spec.label}] manifest missing at ${spec.manifestPath} — skipping binary install` +
        ' (development checkout or --ignore-scripts publish).',
    );
    return;
  }

  /** @type {{version:string; baseUrl:string; binaries:Record<string,{file:string; sha256:string; size:number}>}} */
  const manifest = JSON.parse(readFileSync(spec.manifestPath, 'utf8'));
  const entry = manifest.binaries?.[triple];
  if (!entry) {
    console.warn(`[${spec.label}] manifest has no entry for ${triple} — skipping.`);
    return;
  }

  const dest = join(cacheDir(manifest.version), spec.cachedName(triple, ext));

  // Idempotent: reuse a cached binary that already matches the pinned sha256.
  if (existsSync(dest)) {
    try {
      if (sha256(readFileSync(dest)) === entry.sha256) {
        console.log(`[${spec.label}] cached binary OK at ${dest}`);
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
    writeBinaryAtomic(dest, buf, spec.executable);
    console.log(`[${spec.label}] installed ${triple} -> ${dest} (sha256 verified)`);
  } catch (err) {
    console.warn(`[${spec.label}] download failed: ${err?.message ?? err}`);
    if (tryFallback(spec, triple, dest)) return;
    // Clean a partial cache entry, then degrade gracefully.
    try {
      rmSync(dest, { force: true });
    } catch {
      /* ignore */
    }
    console.warn(
      `[${spec.label}] binary unavailable for ${triple}; feature deferred until first use.`,
    );
  }
}
