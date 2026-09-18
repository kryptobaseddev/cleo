#!/usr/bin/env node
/**
 * check-cleo-tarball-size.mjs — a size budget for the package users install.
 *
 * ## Why this exists
 *
 * `@cleocode/cleo` reached 80.6 MB unpacked across 1059 files — 94% Studio web
 * bundle wrapped around ~4.6 MB of CLI — and nothing in the repo could see it.
 * The only size gate is `packages/core/scripts/check-core-tarball-size.mjs`,
 * which covers `@cleocode/core`, not the package that gates `npm i -g`.
 *
 * Its neighbour `scripts/assert-cleo-tarball.mjs` is a PRESENCE gate: every
 * assertion is an `existsSync`. Re-adding the 48.5 MB that PR #1473 removed
 * would make each of those assertions *more* true. The two run back to back and
 * answer different questions: that one asks "is anything missing?", this one
 * asks "is there too much, or suspiciously little?".
 *
 * ## This is an INSTALL-TIME budget, and only that
 *
 * It is NOT a remedy for npm publish latency, and must never be described as
 * one. That hypothesis is falsified (gh#1478): six consecutive releases at a
 * byte-identical 80.6 MB / 1059 files took anywhere from 4m55s to 55m11s to
 * become installable, v2026.9.7 cut the package 60% and took 3.2x LONGER than
 * the release before it, and in that same run `@cleocode/core` — larger, with
 * seven times the file count — converged in 3m47s while `cleo` took 175m.
 *
 * What a smaller package buys is real and unrelated: every `npm i -g` moves
 * fewer bytes and creates fewer inodes.
 *
 * ## Floors, not just a ceiling
 *
 * A ceiling-only gate is green on an EMPTY package. That is not hypothetical —
 * it is the exact defect `assert-cleo-tarball.mjs` was written for (T12011):
 * `studio-dist/` was never created, npm silently omitted the `files[]` entry,
 * and the release shipped a Studio-less CLI reporting success. `studio-dist`
 * alone is ~27 MB, so a tree missing it reads ~5 MB — far UNDER any ceiling.
 *
 * @task T12244
 * @epic T12119
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Package root: packages/cleo (scripts/ is a direct child). */
const PKG_ROOT = join(__dirname, '..');

/**
 * Upper bound on unpacked size.
 *
 * Baseline after the gh#1472 exclusions and the `dist/**\/*.js.map` cut:
 * ~30.4 MB across 727 files. 36 gives ~18% headroom — tight enough that one
 * new multi-megabyte chunk forces a conversation, loose enough that ordinary
 * growth does not. Re-entry of the gh#1472 exclusions alone is +47.9 MB.
 */
export const MAX_CLEO_UNPACKED_MB = 36;

/**
 * Lower bound on unpacked size. See "Floors, not just a ceiling" above.
 * A tree whose Studio bundle failed to stage reads ~5 MB.
 */
export const MIN_CLEO_UNPACKED_MB = 20;

/** Upper bound on file count. Baseline 727; Studio's sourcemaps alone are +330. */
export const MAX_CLEO_FILES = 800;

/** Lower bound on file count. A half-staged Studio build drops 330-370 files. */
export const MIN_CLEO_FILES = 600;

/**
 * Upper bound on PACKED size — what an install actually downloads.
 *
 * Anchored to a measured number rather than a guess: the pre-gh#1472 package
 * was 22.2 MB packed. 20 sits below that, so a full regression trips here even
 * if it somehow slipped the unpacked check. The script prints the real packed
 * figure on every run; tighten from that once a few releases have reported it.
 */
export const MAX_CLEO_PACKED_MB = 20;

/**
 * The only entry `build.mjs` declares for this package (see its
 * `cleoBuildOptions.entryPoints`). Used to tell the SHIPPED tree from a dev
 * tree — see `assertShippedBuildShape`.
 */
export const DECLARED_ENTRIES = ['dist/cli/index.js'];

/**
 * Run `npm pack --dry-run --json` and parse the single package report.
 *
 * @returns {{ size: number; unpackedSize: number; files: Array<{ path: string; size: number }> }}
 */
function packReport() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
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

const fmtMb = (n) => `${(n / (1024 * 1024)).toFixed(2)} MB`;

/**
 * Refuse to measure a dev tree.
 *
 * `packages/cleo/dist/` in a working checkout is TSC output — measured here:
 * 320 `.js`, 320 `.d.ts`, 640 `.map`, 1280 files — while CI publishes the
 * esbuild bundle, which is 2 files. `npm pack --dry-run` on a dev tree reports
 * ~2005 files against the 728 that ship.
 *
 * So a budget run locally would measure a tree nobody installs, and could pass
 * or fail for reasons that have nothing to do with the release. This is a
 * POSITIVE identity check on the build shape, not a heuristic about counts.
 *
 * @param {Array<{ path: string }>} files
 * @returns {string[]} Reasons this is not the shipped tree (empty when it is).
 */
export function assertShippedBuildShape(files) {
  const reasons = [];
  const dist = files.filter((f) => f.path.startsWith('dist/'));

  const decls = dist.filter((f) => f.path.endsWith('.d.ts') || f.path.endsWith('.d.ts.map'));
  if (decls.length > 0) {
    reasons.push(`${decls.length} declaration file(s) under dist/ — the esbuild bundle emits none`);
  }

  const stray = dist.filter((f) => f.path.endsWith('.js') && !DECLARED_ENTRIES.includes(f.path));
  if (stray.length > 0) {
    reasons.push(
      `${stray.length} .js file(s) under dist/ outside the declared entry set ` +
        `(${DECLARED_ENTRIES.join(', ')}), e.g. ${stray[0].path}`,
    );
  }
  return reasons;
}

// ---------------------------------------------------------------------------

const report = packReport();
const fileCount = report.files.length;

console.log(
  `@cleocode/cleo packed: ${fmtMb(report.size)} / budget ${MAX_CLEO_PACKED_MB} MB ` +
    `(unpacked ${fmtMb(report.unpackedSize)}, ${fileCount} files)`,
);

const largest = [...report.files].sort((a, b) => b.size - a.size).slice(0, 8);
for (const f of largest) {
  console.log(`  ${fmtMb(f.size).padStart(10)}  ${f.path}`);
}

let failed = false;
const fail = (msg, fix) => {
  console.error(`::error::${msg}`);
  if (fix) console.error(`  ${fix}`);
  failed = true;
};

// 0. Is this even the tree that ships? Checked FIRST — every threshold below
//    is meaningless against a dev tree, and a confident wrong number is worse
//    than no number.
const shapeProblems = assertShippedBuildShape(report.files);
if (shapeProblems.length > 0) {
  fail(
    `E_DEV_TREE: packages/cleo/dist is not the shipped esbuild bundle — ${shapeProblems.join('; ')}`,
    'Run `node build.mjs` from the repo root first. A tsc dist/ measures ~2005 files ' +
      'against the 728 that actually publish, so any verdict from it is about a tree nobody installs.',
  );
}

// 1. Staging: Studio must actually be in the package. This is the floor that
//    catches the T12011 shape — an absent bundle that every presence-style
//    assertion above it still reports as fine.
if (!report.files.some((f) => f.path.startsWith('studio-dist/client/_app/'))) {
  fail(
    'studio-dist/client/_app/ contributed no files to the package.',
    'Build Studio and run packages/cleo/scripts/copy-studio-dist.mjs before this gate.',
  );
}

// 2. Sourcemaps must not ship. Asserted rather than declared: the `files[]`
//    negation that excludes them is one line, and a filter that silently stops
//    matching is exactly the failure shape gh#1472 was.
const maps = report.files.filter((f) => f.path.endsWith('.map'));
if (maps.length > 0) {
  fail(
    `${maps.length} sourcemap(s) reached the package, e.g. ${maps[0].path}`,
    'Nothing reads them: `--enable-source-maps` is set nowhere in this repo. ' +
      'Check the `!dist/**/*.js.map` negation in packages/cleo/package.json `files[]`.',
  );
}

// 3. The budgets.
const unpackedMb = report.unpackedSize / (1024 * 1024);
const packedMb = report.size / (1024 * 1024);

if (unpackedMb > MAX_CLEO_UNPACKED_MB) {
  fail(
    `unpacked ${fmtMb(report.unpackedSize)} exceeds the ${MAX_CLEO_UNPACKED_MB} MB budget.`,
    'See the largest contributors above. This is an INSTALL-TIME budget — it is not, ' +
      'and must not be justified as, a remedy for npm publish latency (gh#1478).',
  );
}
if (unpackedMb < MIN_CLEO_UNPACKED_MB) {
  fail(
    `unpacked ${fmtMb(report.unpackedSize)} is BELOW the ${MIN_CLEO_UNPACKED_MB} MB floor — ` +
      'something that should ship is missing.',
    'A ceiling-only gate passes an empty package. This floor exists because that already happened (T12011).',
  );
}
if (fileCount > MAX_CLEO_FILES) {
  fail(`${fileCount} files exceeds the ${MAX_CLEO_FILES}-file budget.`);
}
if (fileCount < MIN_CLEO_FILES) {
  fail(
    `${fileCount} files is BELOW the ${MIN_CLEO_FILES}-file floor — a partial Studio build?`,
  );
}
if (packedMb > MAX_CLEO_PACKED_MB) {
  fail(`packed ${fmtMb(report.size)} exceeds the ${MAX_CLEO_PACKED_MB} MB download budget.`);
}

if (failed) process.exit(1);
console.log(
  `OK — within budget (${MIN_CLEO_UNPACKED_MB}-${MAX_CLEO_UNPACKED_MB} MB, ` +
    `${MIN_CLEO_FILES}-${MAX_CLEO_FILES} files), no sourcemaps, Studio staged.`,
);
