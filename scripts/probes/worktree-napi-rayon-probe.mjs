#!/usr/bin/env node
/**
 * Probe: verifies the @cleocode/worktree-napi binding resolves and the rayon
 * hot-path (parallel CoW copy) is reachable via the loader.
 *
 * Runs three checks:
 *   1. require('@cleocode/worktree-napi') succeeds (no MODULE_NOT_FOUND)
 *   2. The exported `copyPathsParallel` function is callable
 *   3. A single rayon-backed copyPathsParallel invocation against a tiny
 *      tmp fixture returns the expected envelope shape
 *
 * Exit codes:
 *   0 — native binding loaded, rayon path active
 *   1 — module-not-found (the file:../../crates global-install regression)
 *   2 — module loaded but exports missing (loader returned a stub / wrong file)
 *   3 — function call threw (binary mismatch or crate ABI drift)
 *
 * Usage:
 *   node scripts/probes/worktree-napi-rayon-probe.mjs
 *   node scripts/probes/worktree-napi-rayon-probe.mjs --prefix /tmp/probe
 *
 * @task T10178
 * @saga T10176
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const prefixIdx = args.indexOf('--prefix');
const PREFIX = prefixIdx >= 0 ? args[prefixIdx + 1] : null;
const fromIdx = args.indexOf('--from');
const FROM = fromIdx >= 0 ? args[fromIdx + 1] : null;

/**
 * Build a `require` resolver anchored at the right location.
 *
 *   - When `--prefix <dir>` is passed (global-install simulation) the probe
 *     resolves @cleocode/worktree-napi as an absolute path inside that
 *     prefix's node_modules.
 *   - When `--from <dir>` is passed the probe creates a `require` anchored
 *     at that directory's package.json so node uses the consumer's
 *     node_modules tree (useful when running from the repo root in a
 *     pnpm workspace).
 *   - Otherwise we try a few well-known consumer locations
 *     (packages/worktree, then repo root) before giving up.
 */
function buildResolver() {
  if (PREFIX) return { kind: 'prefix', prefix: PREFIX };
  if (FROM) return { kind: 'from', anchor: resolve(FROM, 'package.json') };
  // Default: prefer the @cleocode/worktree consumer (knows about the napi
  // dep via its package.json) before falling back to the repo root.
  const repoRoot = resolve(__dirname, '..', '..');
  const worktreePkg = join(repoRoot, 'packages', 'worktree', 'package.json');
  if (existsSync(worktreePkg)) {
    return { kind: 'from', anchor: worktreePkg };
  }
  return { kind: 'from', anchor: join(repoRoot, 'package.json') };
}

const resolver = buildResolver();

function triple() {
  if (platform() === 'linux' && arch() === 'x64') return 'linux-x64-gnu';
  if (platform() === 'linux' && arch() === 'arm64') return 'linux-arm64-gnu';
  if (platform() === 'darwin' && arch() === 'x64') return 'darwin-x64';
  if (platform() === 'darwin' && arch() === 'arm64') return 'darwin-arm64';
  if (platform() === 'win32' && arch() === 'x64') return 'win32-x64-msvc';
  return `${platform()}-${arch()}`;
}

const TRIPLE = triple();
console.log(`[probe] platform/arch detected as ${TRIPLE}`);

// ─── Check 1: require resolves ────────────────────────────────────────────
let napi;
try {
  if (resolver.kind === 'prefix') {
    const napiPath = join(resolver.prefix, 'node_modules', '@cleocode', 'worktree-napi');
    const req = createRequire(import.meta.url);
    napi = req(napiPath);
  } else {
    const req = createRequire(resolver.anchor);
    napi = req('@cleocode/worktree-napi');
  }
} catch (err) {
  console.error(`[probe] FAIL — require failed: ${err.code ?? ''} ${err.message ?? err}`);
  process.exit(1);
}

console.log(`[probe] OK — @cleocode/worktree-napi resolved`);

// ─── Check 2: exports present ─────────────────────────────────────────────
const requiredExports = [
  'copyPathsParallel',
  'destroyWorktree',
  'readWorktreeInclude',
  'applyInclude',
  'listWorktrees',
];
const missing = requiredExports.filter((k) => typeof napi[k] !== 'function');
if (missing.length > 0) {
  console.error(`[probe] FAIL — missing exports: ${missing.join(', ')}`);
  console.error(`[probe]   loaded keys: ${Object.keys(napi).join(', ')}`);
  process.exit(2);
}
console.log(`[probe] OK — all ${requiredExports.length} required exports present`);

// ─── Check 3: rayon hot-path callable ─────────────────────────────────────
// We exercise the parallel-copy entry point (copyPathsParallel uses rayon's
// par_iter for the file copy fanout). A successful call confirms the native
// .node binary loaded and the FFI surface is intact — i.e. we're running
// the rayon path, not the (deleted) TS fallback.
const tmp = mkdtempSync(join(tmpdir(), 'worktree-napi-probe-'));
const src = join(tmp, 'src');
const dst = join(tmp, 'dst');
mkdirSync(src, { recursive: true });
mkdirSync(dst, { recursive: true });
const fixtureFiles = ['a.txt', 'b.txt', 'c.txt'];
for (const f of fixtureFiles) {
  writeFileSync(join(src, f), `hello ${f}\n`);
}

try {
  const result = napi.copyPathsParallel(src, dst, fixtureFiles, {
    force: false,
    rootGuard: dst,
    includeSymlinks: false,
  });
  if (typeof result !== 'object' || result === null) {
    console.error(`[probe] FAIL — copyPathsParallel returned non-object: ${result}`);
    process.exit(3);
  }
  if (typeof result.copiedCount !== 'number') {
    console.error(
      `[probe] FAIL — copyPathsParallel result missing copiedCount: ${JSON.stringify(result)}`,
    );
    process.exit(3);
  }
  console.log(
    `[probe] OK — rayon copyPathsParallel returned copiedCount=${result.copiedCount} totalBytes=${result.totalBytes}`,
  );
} catch (err) {
  console.error(`[probe] FAIL — copyPathsParallel threw: ${err?.message ?? err}`);
  process.exit(3);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`[probe] PASS — rayon hot-path active`);
process.exit(0);
