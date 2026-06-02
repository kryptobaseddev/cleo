#!/usr/bin/env node
/**
 * Generate the sha256 manifest for the cross-compiled worktree-napi `.node`
 * addons (T11580 — R10-L1 · SG-PACKAGE-ARCH).
 *
 * Mirrors `gen-supervisor-manifest.mjs`. Distribution Pattern P2: the manifest
 * is generated in CI from the `.node` binaries attached to a GitHub Release and
 * CHECKED INTO the @cleocode/core tarball at publish time (NOT fetched at
 * runtime). The shared postinstall picker (`napi-binary-picker.mjs`, driven by
 * `install-supervisor-binary.mjs`) downloads the matching `.node` from the
 * Release and verifies it against the pinned sha256 here, failing closed on a
 * mismatch.
 *
 * The buildable worktree-napi matrix is FOUR triples (`linux-x64-gnu`,
 * `linux-arm64-gnu`, `darwin-arm64`, `win32-x64-msvc`) — `darwin-x64` was
 * dropped (T10479) because macos-13 Intel runners stall the release. This
 * generator emits an entry for every `worktree-napi.<triple>.node` found in the
 * bin dir, so it adapts if the matrix changes.
 *
 * Manifest schema (stable — the picker reads it; identical shape to the
 * supervisor manifest so one picker consumes both):
 *
 * ```jsonc
 * {
 *   "version": "2026.5.130",
 *   "generatedAt": "2026-05-30T01:23:45.678Z",
 *   "baseUrl": "https://github.com/kryptobaseddev/cleo/releases/download/v2026.5.130",
 *   "binaries": {
 *     "linux-x64-gnu":   { "file": "worktree-napi.linux-x64-gnu.node",   "sha256": "…", "size": 1441472 },
 *     "linux-arm64-gnu": { "file": "worktree-napi.linux-arm64-gnu.node", "sha256": "…", "size": 1400000 },
 *     "darwin-arm64":    { "file": "worktree-napi.darwin-arm64.node",    "sha256": "…", "size": 1480000 },
 *     "win32-x64-msvc":  { "file": "worktree-napi.win32-x64-msvc.node",  "sha256": "…", "size": 1600000 }
 *   }
 * }
 * ```
 *
 * Usage:
 *   node packages/core/scripts/gen-napi-manifest.mjs \
 *     --bin-dir <dir-with-worktree-napi.*.node> \
 *     --out <manifest.json> \
 *     [--version <ver>] [--repo kryptobaseddev/cleo]
 *
 * @task T11580
 */

import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Filename prefix shared by every worktree-napi binary artifact. */
const BIN_PREFIX = 'worktree-napi.';

/** Filename suffix shared by every napi addon artifact. */
const BIN_SUFFIX = '.node';

/** Default GitHub repository slug for the release download base URL. */
const DEFAULT_REPO = 'kryptobaseddev/cleo';

/**
 * Map an artifact filename to its platform triple.
 *
 * `worktree-napi.linux-x64-gnu.node`   -> `linux-x64-gnu`
 * `worktree-napi.win32-x64-msvc.node`  -> `win32-x64-msvc`
 *
 * @param {string} file - The artifact basename.
 * @returns {string | null} The triple, or null if the name is not a napi addon.
 */
function tripleFromFile(file) {
  if (!file.startsWith(BIN_PREFIX) || !file.endsWith(BIN_SUFFIX)) return null;
  const rest = file.slice(BIN_PREFIX.length, -BIN_SUFFIX.length);
  return rest.length > 0 ? rest : null;
}

/**
 * Compute the sha256 hex digest of a file via streaming.
 *
 * @param {string} path - Absolute file path.
 * @returns {Promise<string>} Lowercase hex digest.
 */
function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Parse `--flag value` style CLI args into a plain object.
 *
 * @param {string[]} argv - Raw argv slice.
 * @returns {Record<string, string>} Parsed flags.
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

/**
 * Resolve the version: explicit flag wins, else the root package.json version.
 *
 * @param {string | undefined} flag - Explicit `--version` value.
 * @returns {string} The resolved version string.
 */
function resolveVersion(flag) {
  if (flag) return flag;
  const here = fileURLToPath(import.meta.url);
  // packages/core/scripts/gen-napi-manifest.mjs -> repo root is ../../..
  const rootPkg = join(here, '..', '..', '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(rootPkg, 'utf8'));
  return pkg.version;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const binDir = args['bin-dir'];
  const outPath = args.out;
  if (!binDir || !outPath) {
    console.error(
      'usage: gen-napi-manifest.mjs --bin-dir <dir> --out <manifest.json> [--version <v>] [--repo <slug>]',
    );
    process.exit(2);
  }
  const version = resolveVersion(args.version);
  const repo = args.repo ?? DEFAULT_REPO;
  const baseUrl = `https://github.com/${repo}/releases/download/v${version}`;

  /** @type {Record<string, { file: string; sha256: string; size: number }>} */
  const binaries = {};
  for (const entry of readdirSync(binDir)) {
    const triple = tripleFromFile(basename(entry));
    if (!triple) continue;
    const full = join(binDir, entry);
    const sha256 = await sha256File(full);
    const size = readFileSync(full).length;
    binaries[triple] = { file: entry, sha256, size };
  }

  const found = Object.keys(binaries);
  if (found.length === 0) {
    console.error(`no worktree-napi.*.node binaries found in ${binDir}`);
    process.exit(1);
  }

  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    baseUrl,
    binaries,
  };
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`wrote ${outPath} with ${found.length} binaries: ${found.join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
