#!/usr/bin/env node
/**
 * copy-studio-dist.mjs — postbuild step for @cleocode/cleo (T11979).
 *
 * Copies the Studio adapter-node build output from
 * `packages/studio/build/` into `packages/cleo/studio-dist/` so the
 * published @cleocode/cleo tarball contains a batteries-included Studio
 * bundle that the gateway can serve at `/studio` with zero repo checkout.
 *
 * Resolution order for the Studio build source:
 *   1. `CLEO_STUDIO_BUILD_DIR` environment variable (CI override).
 *   2. `<monorepo-root>/packages/studio/build` (standard monorepo layout).
 *
 * When the source directory does not exist, the script exits successfully
 * with a warning — a missing Studio build is not a hard build failure in
 * dev checkouts where Studio has not been built yet. CI must explicitly
 * build Studio before building the cleo package (see the wave-based build
 * script at `build.mjs`).
 *
 * ## What is deliberately NOT copied (gh#1472)
 *
 * Studio's build output was 94% of the published @cleocode/cleo tarball —
 * 72 MB of web app around 4.6 MB of CLI — which pushed the package to 80.6 MB
 * unpacked. npm QUEUES packages that large for asynchronous processing and
 * returns exit 0 immediately, so v2026.9.6 reported a successful publish and
 * never became installable: 17 of 18 packages converged within 247 s while
 * `cleo` was still 404 at 1800 s.
 *
 * Two classes are therefore excluded from the PACKAGE (never from
 * `packages/studio/build/`, so developing or running Studio from a checkout is
 * unaffected):
 *
 *   - **`*.map`** — 26.1 MB. Sourcemaps are fetched only by devtools; no
 *     runtime code path reads them. Nobody debugging a `cleo` install steps
 *     through Studio's SSR bundle.
 *   - **`ort-wasm-*.wasm`** — 21.8 MB in one file, ONNX Runtime *Web*. It
 *     arrives transitively: `@cleocode/core` depends on
 *     `@huggingface/transformers` for BRAIN embeddings, Studio imports core,
 *     and the bundler follows the graph. Studio itself declares no onnx or
 *     transformers dependency and no Studio source file imports either, and at
 *     runtime the embedding path executes in Node via onnxruntime-node, not in
 *     the browser. This is a bundler artifact, not a feature.
 *
 * Together 47.9 MB of 80.6 MB. The target is chosen from evidence rather than
 * guessed: `@cleocode/core` is 42.8 MB across 5319 files and published
 * synchronously in the same run that `cleo` failed, so landing under it puts
 * the package in a range empirically proven to work.
 *
 * The exclusions are ASSERTED after the copy, not merely applied — a filter
 * that silently stops matching would restore the old size while still
 * reporting success, which is the failure shape this whole change exists to
 * close.
 *
 * @task T12241
 * @epic T11261
 */

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// packages/cleo/scripts → packages/cleo
const cleoPackageDir = resolve(__dirname, '..');
// packages/cleo → monorepo root
const monorepoRoot = resolve(cleoPackageDir, '..', '..');

const srcDir =
  process.env['CLEO_STUDIO_BUILD_DIR'] ??
  join(monorepoRoot, 'packages', 'studio', 'build');

const destDir = join(cleoPackageDir, 'studio-dist');

if (!existsSync(srcDir)) {
  console.warn(
    `[copy-studio-dist] Studio build not found at ${srcDir}. ` +
      'Run `pnpm --filter @cleocode/studio run build` first. ' +
      'Skipping studio-dist copy (bundle will be absent from the tarball).',
  );
  process.exit(0);
}

// Clean the destination directory so stale assets do not accumulate.
await rm(destDir, { recursive: true, force: true });
await mkdir(destDir, { recursive: true });

/**
 * Whether a path is excluded from the published bundle (gh#1472).
 *
 * Matches on the basename so it is independent of directory layout: the
 * bundler renames and relocates chunks between builds, and a rule keyed on a
 * path would quietly stop matching without anything reporting it.
 *
 * @param {string} filePath - Absolute or relative path to test.
 * @returns {boolean} `true` when the file must not be published.
 */
function isExcludedFromPackage(filePath) {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  if (base.endsWith('.map')) return true;
  if (base.startsWith('ort-wasm-') && base.endsWith('.wasm')) return true;
  return false;
}

await cp(srcDir, destDir, {
  recursive: true,
  filter: (src) => !isExcludedFromPackage(src),
});

/**
 * Walk a directory tree, returning every file path and the total byte size.
 *
 * @param {string} dir - Directory to walk.
 * @returns {Promise<{files: string[], bytes: number}>}
 */
async function walk(dir) {
  const files = [];
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    files.push(full);
    bytes += (await stat(full)).size;
  }
  return { files, bytes };
}

// Assert the exclusions actually applied. A filter that stops matching — after
// a bundler rename, a Node `cp` behaviour change, or an edit to the predicate —
// would restore the 80.6 MB package while this script still printed success.
// That is precisely the "reported success over an unverified outcome" shape
// that made gh#1472 possible, so it fails loudly here instead.
const copied = await walk(destDir);
const leaked = copied.files.filter((f) => isExcludedFromPackage(f));
if (leaked.length > 0) {
  console.error(
    `[copy-studio-dist] ERROR: ${leaked.length} excluded file(s) reached the package:\n` +
      leaked.slice(0, 10).map((f) => `  ${f}`).join('\n'),
  );
  process.exit(1);
}

const src = await walk(srcDir);
const savedMb = (src.bytes - copied.bytes) / 1e6;
console.log(
  `[copy-studio-dist] bundle ${(copied.bytes / 1e6).toFixed(1)} MB in ${copied.files.length} files ` +
    `(excluded ${(src.files.length - copied.files.length)} files, ${savedMb.toFixed(1)} MB)`,
);

// Quick sanity check: the adapter-node index.js must be present.
const indexJs = join(destDir, 'index.js');
if (!existsSync(indexJs)) {
  console.error(
    `[copy-studio-dist] ERROR: ${indexJs} not found after copy. ` +
      'The Studio build may be incomplete (client-only, no server).',
  );
  process.exit(1);
}

const clientDir = join(destDir, 'client');
if (!existsSync(clientDir)) {
  console.warn(
    `[copy-studio-dist] Warning: studio-dist/client/ not found. ` +
      'Gateway static serving at /studio will fall back to the absent-bundle 503.',
  );
}

console.log(`[copy-studio-dist] Copied ${srcDir} → ${destDir}`);
