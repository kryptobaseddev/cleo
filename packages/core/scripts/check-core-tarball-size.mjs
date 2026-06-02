#!/usr/bin/env node
/**
 * CI gate: assert the packed `@cleocode/core` tarball stays within budget and
 * bundles ONLY the linux-x64-gnu fallback for each CLEO-managed native binary
 * (T11342 — SG-RUNTIME-UNIFICATION R1; extended T11580 — R10-L1).
 *
 * Rationale: Distribution Pattern P1 bundles exactly ONE binary per family
 * (linux-x64-gnu) into the tarball; the other targets are downloaded at
 * postinstall (P2). If a future change bundles additional platform binaries,
 * the tarball bloats and `npm install` slows for everyone. This gate fails the
 * build (non-zero exit) when:
 *
 *   1. The packed tarball exceeds {@link MAX_CORE_TARBALL_BYTES}, OR
 *   2. More than one `cleo-supervisor.*` platform binary is bundled, or a
 *      bundled one targets a triple other than `linux-x64-gnu`, OR
 *   3. More than one `worktree-napi.*.node` platform addon is bundled, or a
 *      bundled one targets a triple other than `linux-x64-gnu` (T11580).
 *
 * On failure it prints the largest contributors so the regression is obvious.
 *
 * Usage:
 *   node packages/core/scripts/check-core-tarball-size.mjs
 *
 * @task T11342
 * @task T11580
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Package root: packages/core (scripts/ is a direct child). */
const PKG_ROOT = join(__dirname, '..');

/**
 * The single named tarball-size threshold (no magic numbers scattered).
 * 25 MB packed, matching T11342 AC1 / the gen7 packaging budget.
 */
export const MAX_CORE_TARBALL_MB = 25;

/** The threshold expressed in bytes for the size comparison. */
export const MAX_CORE_TARBALL_BYTES = MAX_CORE_TARBALL_MB * 1024 * 1024;

/** The ONLY platform triple permitted bundled for each native-binary family. */
export const ALLOWED_BUNDLED_TRIPLE = 'linux-x64-gnu';

/**
 * Back-compat alias — the supervisor-specific name kept for any external
 * importer. Both families share the single allowed triple.
 *
 * @deprecated Use {@link ALLOWED_BUNDLED_TRIPLE}.
 */
export const ALLOWED_BUNDLED_SUPERVISOR_TRIPLE = ALLOWED_BUNDLED_TRIPLE;

/**
 * Run `npm pack --dry-run --json` and parse the single package report.
 *
 * @returns {{ size: number; unpackedSize: number; files: Array<{ path: string; size: number }> }}
 *   The packed size (bytes), unpacked size, and per-file entries.
 */
function packReport() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw);
  const report = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!report || typeof report.size !== 'number') {
    throw new Error('npm pack --json did not return a usable report');
  }
  return {
    size: report.size,
    unpackedSize: report.unpackedSize,
    files: Array.isArray(report.files) ? report.files : [],
  };
}

/** Human-readable byte size. */
function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Extract the platform triple from a bundled supervisor binary path, or null. */
function supervisorTripleFromPath(path) {
  const m = /(?:^|\/)cleo-supervisor\.([a-z0-9-]+?)(?:\.exe)?$/.exec(path);
  // Exclude the manifest + fallback dir noise: only match the triple-suffixed
  // binary names, not `cleo-supervisor-manifest.json`.
  if (!m) return null;
  if (path.endsWith('.json')) return null;
  return m[1];
}

/** Extract the platform triple from a bundled worktree-napi addon path, or null. */
function worktreeNapiTripleFromPath(path) {
  // Match `worktree-napi.<triple>.node`; never `worktree-napi-manifest.json`.
  const m = /(?:^|\/)worktree-napi\.([a-z0-9-]+?)\.node$/.exec(path);
  return m ? m[1] : null;
}

/**
 * Assert a native-binary family bundles exactly one fallback, for the allowed
 * triple. Pushes a message into `failures` per violation.
 *
 * @param {string} family - Human label, e.g. `supervisor` or `worktree-napi`.
 * @param {Array<{ path: string }>} files - Packed tarball file entries.
 * @param {(path: string) => string | null} tripleFromPath - Family extractor.
 * @param {string[]} failures - Mutable failure sink.
 */
function assertSingleFallback(family, files, tripleFromPath, failures) {
  const bundledTriples = files.map((f) => tripleFromPath(f.path)).filter((t) => t !== null);
  for (const triple of bundledTriples) {
    if (triple !== ALLOWED_BUNDLED_TRIPLE) {
      failures.push(
        `tarball bundles a non-fallback ${family} binary for '${triple}' — only ` +
          `'${ALLOWED_BUNDLED_TRIPLE}' may be bundled (other targets download via P2)`,
      );
    }
  }
  if (bundledTriples.length > 1) {
    failures.push(
      `tarball bundles ${bundledTriples.length} ${family} binaries (${bundledTriples.join(', ')}) — ` +
        `exactly one (${ALLOWED_BUNDLED_TRIPLE}) is allowed`,
    );
  }
}

function main() {
  const report = packReport();

  const failures = [];

  // 1. Size budget.
  if (report.size > MAX_CORE_TARBALL_BYTES) {
    failures.push(
      `packed @cleocode/core tarball is ${fmtBytes(report.size)} — exceeds the ` +
        `${MAX_CORE_TARBALL_MB} MB budget by ${fmtBytes(report.size - MAX_CORE_TARBALL_BYTES)}`,
    );
  }

  // 2. Bundled supervisor binaries — exactly one, linux-x64-gnu.
  assertSingleFallback('supervisor', report.files, supervisorTripleFromPath, failures);

  // 3. Bundled worktree-napi addons — exactly one, linux-x64-gnu (T11580).
  assertSingleFallback('worktree-napi', report.files, worktreeNapiTripleFromPath, failures);

  // Always print the headline numbers + largest contributors.
  console.log(
    `@cleocode/core packed: ${fmtBytes(report.size)} / budget ${MAX_CORE_TARBALL_MB} MB ` +
      `(unpacked ${fmtBytes(report.unpackedSize ?? 0)}, ${report.files.length} files)`,
  );
  const top = [...report.files].sort((a, b) => b.size - a.size).slice(0, 10);
  console.log('Largest contributors:');
  for (const f of top) {
    console.log(`  ${fmtBytes(f.size).padStart(10)}  ${f.path}`);
  }

  if (failures.length > 0) {
    console.error('');
    console.error('::error::@cleocode/core tarball gate FAILED (T11342 / T11580):');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`OK — within the ${MAX_CORE_TARBALL_MB} MB budget; fallback binary policy satisfied.`);
}

main();
