#!/usr/bin/env node

/**
 * Copy the self-improvement scenario fixtures into `packages/core/dist` (T11974).
 *
 * The self-improvement loop (`cleo selfimprove run --scenario <name>`) loads its
 * scenario + golden fixtures from disk at runtime via
 * {@link ../src/selfimprove/scenario.ts | loadScenario}, which resolves the
 * fixture directory relative to its own compiled location
 * (`dist/selfimprove/scenarios/<name>/{scenario,golden}.json`).
 *
 * These are non-TS assets, so neither `tsc` nor the esbuild entry-point scan in
 * the root `build.mjs` emits them — without this copy step a released/built
 * install ships no fixtures and the loop trips its circuit-breaker with
 * `E_SELFIMPROVE_SCENARIO_INVALID: Cannot read scenario fixture …` (DHQ-078).
 *
 * Mirrors the established convention of shipping non-TS runtime assets (the
 * `templates`, `schemas`, `migrations` top-level dirs in the package `files`
 * list) — here the fixtures must live *inside* `dist` because the resolver
 * derives their path from `import.meta.url` of the compiled module.
 *
 * Idempotent: re-running overwrites the destination tree.
 *
 * @module copy-selfimprove-fixtures
 * @task T11974
 */

import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');

/** Source fixture root (TypeScript-source tree). */
const SRC = resolve(packageRoot, 'src/selfimprove/scenarios');
/** Destination fixture root inside the compiled bundle. */
const DEST = resolve(packageRoot, 'dist/selfimprove/scenarios');

/**
 * Copy the scenario fixture tree from `src` into `dist`.
 *
 * @returns Resolves once the copy completes.
 */
async function copySelfImproveFixtures() {
  if (!existsSync(SRC)) {
    throw new Error(`[copy-selfimprove-fixtures] source fixtures missing at ${SRC}`);
  }
  await mkdir(dirname(DEST), { recursive: true });
  await cp(SRC, DEST, { recursive: true });
  console.log(`[copy-selfimprove-fixtures] ${SRC} -> ${DEST}`);
}

await copySelfImproveFixtures();
