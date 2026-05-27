#!/usr/bin/env node
/**
 * Probe: verifies the @cleocode/worktree package resolves and its bundled
 * worktree-napi rayon hot-path is reachable through the public SDK.
 *
 * Runs three checks:
 *   1. import('@cleocode/worktree') succeeds (no MODULE_NOT_FOUND)
 *   2. The exported `copyPathsWithReflock` function is callable
 *   3. A single rayon-backed copyPathsWithReflock invocation against a tiny
 *      tmp fixture returns the expected envelope shape
 *
 * Exit codes:
 *   0 — @cleocode/worktree loaded, bundled rayon path active
 *   1 — module-not-found / import failure
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
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
 *     resolves @cleocode/worktree as an absolute path inside that prefix's
 *     node_modules.
 *   - When `--from <dir>` is passed the probe walks upward from that directory
 *     until it finds node_modules/@cleocode/worktree/dist/index.js.
 *   - Otherwise we try a few well-known consumer locations
 *     (packages/worktree, then repo root) before giving up.
 */
function buildResolver() {
  if (PREFIX) {
    return {
      entrypoint: join(PREFIX, 'node_modules', '@cleocode', 'worktree', 'dist', 'index.js'),
    };
  }
  if (FROM) return { entrypoint: findWorktreeEntrypoint(resolve(FROM)) };
  // Default: prefer the @cleocode/worktree package before falling back to the repo root.
  const repoRoot = resolve(__dirname, '..', '..');
  const worktreeEntrypoint = join(repoRoot, 'packages', 'worktree', 'dist', 'index.js');
  if (existsSync(worktreeEntrypoint)) {
    return { entrypoint: worktreeEntrypoint };
  }
  return { entrypoint: findWorktreeEntrypoint(repoRoot) };
}

function findWorktreeEntrypoint(startDir) {
  let current = startDir;
  while (true) {
    const candidate = join(current, 'node_modules', '@cleocode', 'worktree', 'dist', 'index.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
  return join(startDir, 'node_modules', '@cleocode', 'worktree', 'dist', 'index.js');
}

const resolver = buildResolver();

function triple() {
  if (platform() === 'linux' && arch() === 'x64') return 'linux-x64-gnu';
  if (platform() === 'linux' && arch() === 'arm64') return 'linux-arm64-gnu';
  if (platform() === 'darwin' && arch() === 'arm64') return 'darwin-arm64';
  if (platform() === 'win32' && arch() === 'x64') return 'win32-x64-msvc';
  return `${platform()}-${arch()}`;
}

const TRIPLE = triple();
console.log(`[probe] platform/arch detected as ${TRIPLE}`);

// ─── Check 1: public SDK import resolves ──────────────────────────────────
let worktree;
try {
  worktree = await import(pathToFileURL(resolver.entrypoint).href);
} catch (err) {
  console.error(`[probe] FAIL — import failed: ${err.code ?? ''} ${err.message ?? err}`);
  process.exit(1);
}

console.log(`[probe] OK — @cleocode/worktree resolved`);

// ─── Check 2: exports present ─────────────────────────────────────────────
const requiredExports = [
  'copyPathsWithReflock',
  'createWorktree',
  'listWorktrees',
  'pruneWorktrees',
];
const missing = requiredExports.filter((k) => typeof worktree[k] !== 'function');
if (missing.length > 0) {
  console.error(`[probe] FAIL — missing exports: ${missing.join(', ')}`);
  console.error(`[probe]   loaded keys: ${Object.keys(worktree).join(', ')}`);
  process.exit(2);
}
console.log(`[probe] OK — all ${requiredExports.length} required exports present`);

// ─── Check 3: rayon hot-path callable ─────────────────────────────────────
// We exercise the public parallel-copy entry point. It routes to rayon's par_iter
// for the file copy fanout, so a successful call confirms the bundled native
// .node binary loaded and the FFI surface is intact.
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
  const result = await worktree.copyPathsWithReflock(fixtureFiles, src, dst, {
    force: false,
    rootGuard: dst,
    includeSymlinks: false,
  });
  if (typeof result !== 'object' || result === null) {
    console.error(`[probe] FAIL — copyPathsWithReflock returned non-object: ${result}`);
    process.exit(3);
  }
  if (!Array.isArray(result.copied) || !Array.isArray(result.failed)) {
    console.error(
      `[probe] FAIL — copyPathsWithReflock result missing copied/failed arrays: ${JSON.stringify(result)}`,
    );
    process.exit(3);
  }
  if (result.copied.length !== fixtureFiles.length || result.failed.length !== 0) {
    console.error(`[probe] FAIL — copy result mismatch: ${JSON.stringify(result)}`);
    process.exit(3);
  }
  console.log(`[probe] OK — rayon copyPathsWithReflock copied ${result.copied.length} files`);
} catch (err) {
  console.error(`[probe] FAIL — copyPathsWithReflock threw: ${err?.message ?? err}`);
  process.exit(3);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`[probe] PASS — rayon hot-path active`);
process.exit(0);
