#!/usr/bin/env node
/**
 * T12011: Assert that the @cleocode/cleo npm tarball will contain every entry
 * declared in packages/cleo/package.json `files[]` AND that the Studio bundle
 * (studio-dist/client/) is present with a non-empty asset tree.
 *
 * WHY THIS EXISTS
 * ---------------
 * npm silently omits `files[]` entries that do not exist on disk at publish
 * time. When T11979/#1074 merged Studio-in-package, `packages/cleo/package.json`
 * gained `"studio-dist"` in its `files[]` array. But the release CI pipeline
 * never built @cleocode/studio before running `pnpm publish`, so
 * `packages/cleo/studio-dist/` was never created and npm silently omitted it.
 * The published @cleocode/cleo tarball shipped without Studio from v2026.6.13
 * onward; every `cleo web` session served a blank Studio.
 *
 * This script catches that regression before `pnpm publish` runs:
 *  1. Reads `packages/cleo/package.json` `files[]`.
 *  2. Asserts every entry exists on disk as a file or directory.
 *  3. Asserts `packages/cleo/studio-dist/client/` exists (the path the gateway
 *     calls `resolveStudioStaticDir` expects — see
 *     `packages/runtime/src/gateway/http/studio-static.ts`).
 *  4. Asserts `packages/cleo/studio-dist/client/_app/` exists (the SvelteKit
 *     immutable-asset tree — its absence means the build is partial).
 *
 * Exit code 0 = all assertions passed.
 * Exit code 1 = one or more assertions failed (each failure is printed to stderr
 *   with a `::error::` annotation so GitHub Actions surfaces it as a step failure
 *   with the entry name highlighted).
 *
 * @task T12011
 * @epic T11261
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CLEO_PKG_DIR = join(REPO_ROOT, 'packages', 'cleo');
const CLEO_PKG_JSON = join(CLEO_PKG_DIR, 'package.json');

// ---------------------------------------------------------------------------
// Load packages/cleo/package.json
// ---------------------------------------------------------------------------

/** @type {{ files?: string[] }} */
let pkg;
try {
  pkg = JSON.parse(readFileSync(CLEO_PKG_JSON, 'utf8'));
} catch (err) {
  console.error(`::error::assert-cleo-tarball: cannot read ${CLEO_PKG_JSON}: ${err.message}`);
  process.exit(1);
}

const filesEntries = pkg.files ?? [];
if (filesEntries.length === 0) {
  console.warn('assert-cleo-tarball: packages/cleo/package.json has no files[] — skipping.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Gate 1: every files[] entry must exist on disk
// ---------------------------------------------------------------------------

let failed = false;

console.log('[assert-cleo-tarball] Checking packages/cleo/package.json files[] entries...');
for (const entry of filesEntries) {
  const absPath = join(CLEO_PKG_DIR, entry);
  if (!existsSync(absPath)) {
    console.error(
      `::error::assert-cleo-tarball: files[] entry "${entry}" is MISSING on disk at ${absPath}. ` +
        `npm will silently omit this from the published tarball. ` +
        `Ensure the build step that produces this entry runs BEFORE publish.`,
    );
    failed = true;
  } else {
    console.log(`  OK  ${entry}`);
  }
}

// ---------------------------------------------------------------------------
// Gate 2: studio-dist/client/ must contain SvelteKit static assets
//
// The gateway resolves `studio-dist/client/` via `resolveStudioStaticDir()`
// (packages/runtime/src/gateway/http/studio-static.ts). If this directory is
// absent or empty, every `cleo web` session serves E_STUDIO_BUNDLE_ABSENT.
// ---------------------------------------------------------------------------

const studioDist = join(CLEO_PKG_DIR, 'studio-dist');
const studioClient = join(studioDist, 'client');
const studioApp = join(studioClient, '_app');

console.log('\n[assert-cleo-tarball] Checking studio-dist layout...');

if (!existsSync(studioDist)) {
  console.error(
    `::error::assert-cleo-tarball: studio-dist/ directory is MISSING at ${studioDist}. ` +
      `Run \`pnpm --filter @cleocode/studio run build\` and then ` +
      `\`node packages/cleo/scripts/copy-studio-dist.mjs\` before publishing.`,
  );
  failed = true;
} else if (!existsSync(studioClient)) {
  console.error(
    `::error::assert-cleo-tarball: studio-dist/client/ is MISSING at ${studioClient}. ` +
      `The SvelteKit adapter-node build places static assets in build/client/; ` +
      `copy-studio-dist.mjs copies the full build/ tree, so client/ must be present. ` +
      `Re-run the Studio build and staging step.`,
  );
  failed = true;
} else if (!existsSync(studioApp)) {
  console.error(
    `::error::assert-cleo-tarball: studio-dist/client/_app/ is MISSING at ${studioApp}. ` +
      `This directory contains the SvelteKit immutable asset tree. ` +
      `The Studio build may be partial or corrupted. Re-run the Studio build.`,
  );
  failed = true;
} else {
  console.log(`  OK  studio-dist/client/ (SvelteKit static assets present)`);
  console.log(`  OK  studio-dist/client/_app/ (immutable asset tree present)`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (failed) {
  console.error('\n[assert-cleo-tarball] FAILED — see errors above.');
  process.exit(1);
}

console.log('\n[assert-cleo-tarball] All assertions passed — @cleocode/cleo tarball is complete.');
