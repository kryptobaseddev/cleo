#!/usr/bin/env node
/**
 * CI gate: assert the built `@cleocode/core` dist stays within budget AND that
 * importing a single `@cleocode/core/<submodule>` subpath tree-shakes — i.e. it
 * does NOT drag the entire core bundle into a downstream consumer's build
 * (T11582 — SG-DB-SUBSTRATE-V2 R10-L3, follows the R10-L2 submodule re-exports
 * shipped in #924 / T11581).
 *
 * This is the build-time / PR-time companion to
 * {@link ./check-core-tarball-size.mjs}, which measures the *packed* tarball at
 * release-tag time (and needs the cross-compiled supervisor fallback binary).
 * This gate runs on every PR/build off the plain `dist/` tree — no Rust artifact
 * required — and therefore catches bundle-size and tree-shape regressions early.
 *
 * It fails the build (non-zero exit) when ANY of the following regress:
 *
 *   1. AC2 — the built `dist/` tree exceeds {@link MAX_CORE_DIST_BYTES}.
 *   2. AC1 — a published submodule's emitted file imports a bare `@cleocode/*`
 *      specifier that is NOT a declared runtime dependency of `@cleocode/core`
 *      (an unresolvable bare import would break `npm install` for consumers).
 *   3. AC3 — esbuild-bundling a throwaway consumer that imports ONE
 *      `@cleocode/core/<submodule>` produces a bundle larger than its
 *      per-submodule budget, OR not dramatically smaller than the full-core
 *      bundle (proving the submodule does not pull in all of core).
 *
 * On failure it prints the largest contributors / offending specifiers so the
 * regression is obvious (AC4).
 *
 * Usage:
 *   node packages/core/scripts/check-core-bundle-budget.mjs
 *
 * @task T11582
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Package root: packages/core (scripts/ is a direct child). */
const PKG_ROOT = join(__dirname, '..');

/** The built dist tree whose size + subpaths this gate measures. */
const DIST_DIR = join(PKG_ROOT, 'dist');

// ---------------------------------------------------------------------------
// Budgets (named — no magic numbers scattered through the assertions).
// ---------------------------------------------------------------------------

/**
 * Uncompressed `dist/` tree budget, in MB. The published tarball is gzipped and
 * strips inlined sourcemap content, so the packed size is far below this; this
 * generous ceiling catches a runaway-bundle regression (e.g. a heavy npm dep
 * accidentally inlined) without false-failing on normal growth. Current tree is
 * ~24 MB. The packed-tarball <= 25MB budget is enforced separately at tag time
 * by check-core-tarball-size.mjs.
 */
export const MAX_CORE_DIST_MB = 40;

/** The uncompressed dist budget expressed in bytes. */
export const MAX_CORE_DIST_BYTES = MAX_CORE_DIST_MB * 1024 * 1024;

/**
 * Per-submodule tree-shake bundle budgets, in KB. Bundling a throwaway consumer
 * that imports ONE `@cleocode/core/<subpath>` MUST stay under its budget. These
 * are calibrated ~2x over the measured size so normal growth does not false-fail
 * but a regression that drags the full core in (≈15 MB bundle) trips the gate.
 *
 * Measured at calibration (R10-L2 submodules, #924):
 *   ./paths ~16KB · ./skills-lib ~11KB · ./lafs ~88KB ·
 *   ./git-shim ~894KB · ./worktree ~927KB · ./caamp ~1600KB
 */
export const SUBMODULE_BUNDLE_BUDGET_KB = {
  './paths': 256,
  './lafs': 256,
  './skills-lib': 128,
  './caamp': 3072,
  './worktree': 2048,
  './git-shim': 2048,
};

/**
 * A single submodule bundle must be at most this fraction of the full-core
 * bundle — the structural tree-shake invariant. The largest submodule today
 * (./caamp ~1.6 MB) is ~10% of the full ~15 MB bundle; 0.5 leaves wide margin
 * while still catching "importing one submodule pulled in all of core".
 */
export const MAX_SUBMODULE_FRACTION_OF_FULL = 0.5;

/**
 * The R10-L2 submodule re-exports (#924 / T11581) this gate tree-shake-probes.
 * Each maps `@cleocode/core/<subpath>` -> an internalized workspace package via
 * a thin `export * from '@cleocode/<pkg>'` stub.
 */
export const PROBED_SUBMODULES = Object.keys(SUBMODULE_BUNDLE_BUDGET_KB);

/**
 * npm specifiers esbuild must NOT try to inline when probing (native addons,
 * heavy SDKs, CJS-shim packages). Mirrors the externals in build.mjs so the
 * probe resolves the same graph a real consumer's bundler would, without
 * crashing on un-bundleable modules. Workspace `@cleocode/*` packages stay
 * bundled so the probe measures the true cross-package pull-in.
 */
const PROBE_EXTERNALS = [
  'onnxruntime-node',
  'mssql',
  '@huggingface/transformers',
  'llmtxt',
  'llmtxt/*',
  'tree-sitter',
  'tree-sitter-*',
  'node-cron',
  'ai',
  'openai',
  'openai/*',
  '@anthropic-ai/sdk',
  '@anthropic-ai/*',
  '@google/generative-ai',
  '@google/generative-ai/*',
  '@aws-sdk/*',
  '@smithy/*',
  '@opentelemetry/api',
];

/** Human-readable byte size. */
function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Load `@cleocode/core`'s package.json (exports map + declared deps).
 *
 * @returns {{ exports: Record<string, unknown>; deps: Set<string> }}
 */
function loadCorePackage() {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  const deps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  return { exports: pkg.exports ?? {}, deps };
}

/**
 * Resolve a subpath export (`'.'`, `'./paths'`, …) to its emitted `import`
 * file inside `dist/`.
 *
 * @param {Record<string, unknown>} exportsMap
 * @param {string} subpath
 * @returns {string} absolute path to the emitted entry file
 */
function distEntryFor(exportsMap, subpath) {
  const entry = exportsMap[subpath];
  if (!entry) throw new Error(`@cleocode/core package.json has no '${subpath}' export`);
  const rel = typeof entry === 'string' ? entry : (entry.import ?? entry.default ?? entry.require);
  if (typeof rel !== 'string') {
    throw new Error(`'${subpath}' export has no resolvable import target`);
  }
  return resolve(PKG_ROOT, rel);
}

/** Recursively sum file sizes under a directory. */
function dirSizeBytes(dir) {
  let total = 0;
  /** @type {Array<{ path: string; size: number }>} */
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    const st = statSync(cur);
    if (st.isDirectory()) {
      for (const name of readdirSyncSafe(cur)) stack.push(join(cur, name));
    } else if (st.isFile()) {
      total += st.size;
      files.push({ path: cur, size: st.size });
    }
  }
  return { total, files };
}

/** readdirSync that returns [] on error (defensive against transient FS races). */
function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Bundle a throwaway consumer that imports `entryFile` and return the total
 * output byte size. The consumer is synthesised in-memory via a stdin entry so
 * nothing is written to the worktree.
 *
 * @param {string} entryFile absolute path to the emitted submodule file
 * @returns {Promise<number>} total bundled output bytes
 */
async function bundleConsumerBytes(entryFile) {
  const result = await esbuild.build({
    stdin: {
      contents: `import * as m from ${JSON.stringify(entryFile)};\nif (Object.keys(m).length < 0) process.exit(1);\n`,
      resolveDir: PKG_ROOT,
      sourcefile: 'treeshake-probe.mjs',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    logLevel: 'silent',
    treeShaking: true,
    external: PROBE_EXTERNALS,
  });
  return result.outputFiles.reduce((sum, f) => sum + f.contents.length, 0);
}

/**
 * Scan an emitted dist file for surviving bare `@cleocode/*` module specifiers
 * (AC1) — i.e. ones inside an actual `import … from '…'`, `export … from '…'`,
 * or `require('…')`, NOT inside path/sourcemap comments. Returns the set of
 * distinct `@cleocode/<pkg>` package roots, excluding a self-reference to
 * `@cleocode/core` (a package never lists itself as a dependency).
 *
 * @param {string} file absolute path to the emitted submodule file
 * @returns {Set<string>}
 */
function bareCleocodeImports(file) {
  const src = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const found = new Set();
  // Match the module specifier of import/export-from and require() forms only,
  // capturing the bare `@cleocode/<pkg>` package root (drops any /subpath).
  const specRe =
    /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)['"](@cleocode\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g;
  let m;
  while ((m = specRe.exec(src)) !== null) {
    if (m[1] === '@cleocode/core') continue; // never a dependency of itself
    found.add(m[1]);
  }
  return found;
}

async function main() {
  const { exports: exportsMap, deps } = loadCorePackage();
  const failures = [];

  if (!existsSync(DIST_DIR)) {
    console.error(`::error::dist/ not found at ${DIST_DIR} — build @cleocode/core first.`);
    process.exit(2);
  }

  // --- AC2: uncompressed dist tree budget -------------------------------------
  const { total: distBytes, files } = dirSizeBytes(DIST_DIR);
  if (distBytes > MAX_CORE_DIST_BYTES) {
    failures.push(
      `built dist/ is ${fmtBytes(distBytes)} — exceeds the ${MAX_CORE_DIST_MB} MB ` +
        `build-time budget by ${fmtBytes(distBytes - MAX_CORE_DIST_BYTES)}`,
    );
  }
  console.log(
    `@cleocode/core dist/: ${fmtBytes(distBytes)} / budget ${MAX_CORE_DIST_MB} MB (${files.length} files)`,
  );
  const topFiles = [...files].sort((a, b) => b.size - a.size).slice(0, 10);
  console.log('Largest dist files:');
  for (const f of topFiles) {
    console.log(`  ${fmtBytes(f.size).padStart(10)}  ${f.path.slice(DIST_DIR.length + 1)}`);
  }

  // --- AC1: no unresolvable bare @cleocode/* import survives -------------------
  console.log('\nInlining check — surviving @cleocode/* imports must be declared deps:');
  for (const subpath of ['.', ...PROBED_SUBMODULES]) {
    const file = distEntryFor(exportsMap, subpath);
    if (!existsSync(file)) {
      failures.push(`AC1: ${subpath} -> ${file} does not exist (build did not emit it)`);
      continue;
    }
    const bare = bareCleocodeImports(file);
    const undeclared = [...bare].filter((spec) => !deps.has(spec));
    if (undeclared.length > 0) {
      failures.push(
        `AC1: '${subpath}' emits undeclared bare import(s) ${undeclared.join(', ')} — ` +
          'every surviving @cleocode/* specifier must be a declared @cleocode/core dependency',
      );
    }
    console.log(
      `  ${subpath.padEnd(14)} imports: ${bare.size === 0 ? '(none — fully inlined)' : [...bare].join(', ')}`,
    );
  }

  // --- AC3: per-submodule tree-shake probe ------------------------------------
  console.log('\nTree-shake probe — single submodule bundle vs full core:');
  const fullBytes = await bundleConsumerBytes(distEntryFor(exportsMap, '.'));
  console.log(`  ${'(full @cleocode/core)'.padEnd(16)} ${fmtBytes(fullBytes).padStart(10)}`);
  for (const subpath of PROBED_SUBMODULES) {
    const entry = distEntryFor(exportsMap, subpath);
    const bytes = await bundleConsumerBytes(entry);
    const budgetBytes = SUBMODULE_BUNDLE_BUDGET_KB[subpath] * 1024;
    const frac = fullBytes > 0 ? bytes / fullBytes : 1;
    const ok = bytes <= budgetBytes && frac <= MAX_SUBMODULE_FRACTION_OF_FULL;
    console.log(
      `  ${subpath.padEnd(16)} ${fmtBytes(bytes).padStart(10)}  ` +
        `(${(frac * 100).toFixed(1)}% of full, budget ${SUBMODULE_BUNDLE_BUDGET_KB[subpath]} KB) ${ok ? 'OK' : 'FAIL'}`,
    );
    if (bytes > budgetBytes) {
      failures.push(
        `AC3: '${subpath}' bundles to ${fmtBytes(bytes)} — exceeds its ` +
          `${SUBMODULE_BUNDLE_BUDGET_KB[subpath]} KB per-submodule budget`,
      );
    }
    if (frac > MAX_SUBMODULE_FRACTION_OF_FULL) {
      failures.push(
        `AC3: '${subpath}' bundle is ${(frac * 100).toFixed(1)}% of the full-core bundle ` +
          `(> ${(MAX_SUBMODULE_FRACTION_OF_FULL * 100).toFixed(0)}%) — it is NOT tree-shaking; ` +
          'importing this submodule appears to pull in most of core',
      );
    }
  }

  if (failures.length > 0) {
    console.error('');
    console.error('::error::@cleocode/core bundle-budget gate FAILED (T11582):');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `\nOK — dist/ within ${MAX_CORE_DIST_MB} MB; every R10-L2 submodule tree-shakes ` +
      `(< ${(MAX_SUBMODULE_FRACTION_OF_FULL * 100).toFixed(0)}% of full core) and emits no undeclared bare imports.`,
  );
}

main().catch((err) => {
  console.error(`::error::bundle-budget gate crashed: ${err?.stack ?? err}`);
  process.exit(2);
});
