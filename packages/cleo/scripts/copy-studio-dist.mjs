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
 * @task T11979
 * @epic T11261
 */

import { cp, mkdir, rm } from 'node:fs/promises';
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

await cp(srcDir, destDir, { recursive: true });

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
