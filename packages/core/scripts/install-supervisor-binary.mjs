#!/usr/bin/env node
/**
 * Postinstall picker entrypoint for CLEO-managed native binaries
 * (T11340 — SG-RUNTIME-UNIFICATION R1; extended T11580 — R10-L1).
 *
 * Historically this script resolved ONLY the `cleo-supervisor` executable. As
 * of R10-L1 (T11580) it drives the SAME picker over BOTH CLEO-managed native
 * binaries — `cleo-supervisor` and `worktree-napi` — via the shared
 * {@link pickBinary} module. The resolution + verification flow (P2 download +
 * sha256 fail-closed + `CLEO_NAPI_BINARY_MIRROR` override + idempotent cache
 * reuse + P1 bundled fallback) is identical for both; only the manifest,
 * fallback path, and cache filename differ per binary.
 *
 * The package `postinstall` invokes this once. Each binary is resolved
 * independently and best-effort — a failure of one never blocks the other, and
 * neither ever fails `npm install` (graceful degrade; the dependent feature is
 * resolved on first use).
 *
 * Standalone binary specs:
 *
 *   - `cleo-supervisor`: a single executable per triple, cached as
 *     `cleo-supervisor<ext>` and chmod +x.
 *   - `worktree-napi`: a napi-rs `.node` addon, cached as
 *     `worktree-napi.<triple>.node` (no exec bit needed — it is `require()`d).
 *
 * @task T11340
 * @task T11580
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBinary } from './napi-binary-picker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Package root: packages/core (scripts/ is a direct child). */
const PKG_ROOT = join(__dirname, '..');

/** Directory holding the checked-in manifests + bundled P1 fallbacks. */
const BINARIES_DIR = join(PKG_ROOT, 'binaries');

/**
 * The CLEO-managed native binaries resolved at postinstall. Each entry is a
 * {@link import('./napi-binary-picker.mjs').BinarySpec}.
 */
const BINARY_SPECS = [
  {
    label: 'cleo-supervisor',
    manifestPath: join(BINARIES_DIR, 'cleo-supervisor-manifest.json'),
    fallbackPath: join(BINARIES_DIR, 'fallback', 'cleo-supervisor'),
    executable: true,
    cachedName: (_triple, ext) => `cleo-supervisor${ext}`,
  },
  {
    label: 'worktree-napi',
    manifestPath: join(BINARIES_DIR, 'worktree-napi-manifest.json'),
    fallbackPath: join(BINARIES_DIR, 'fallback', 'worktree-napi.linux-x64-gnu.node'),
    executable: false,
    cachedName: (triple) => `worktree-napi.${triple}.node`,
  },
];

async function main() {
  // Resolve each binary independently — one failure must not block the other.
  await Promise.all(
    BINARY_SPECS.map((spec) =>
      pickBinary(spec).catch((err) => {
        console.warn(`[${spec.label}] picker error (non-fatal): ${err?.message ?? err}`);
      }),
    ),
  );
}

main().catch((err) => {
  // postinstall must never break `npm install`.
  console.warn(`[cleo-napi] postinstall picker error (non-fatal): ${err?.message ?? err}`);
  process.exit(0);
});
