#!/usr/bin/env node
/**
 * Generate the sha256 manifest for the cross-compiled cleo-supervisor binaries
 * (T11340, SG-RUNTIME-UNIFICATION R1).
 *
 * Distribution Pattern P2: the manifest is generated in CI from the binaries
 * attached to a GitHub Release and CHECKED INTO the @cleocode/core tarball at
 * publish time (NOT fetched at runtime). The postinstall picker
 * (`install-supervisor-binary.mjs`) downloads the matching binary from the
 * Release and verifies it against the pinned sha256 here, failing closed on a
 * mismatch.
 *
 * Manifest schema (stable — the picker reads it):
 *
 * ```jsonc
 * {
 *   "version": "2026.5.130",
 *   "generatedAt": "2026-05-30T01:23:45.678Z",
 *   "baseUrl": "https://github.com/kryptobaseddev/cleo/releases/download/v2026.5.130",
 *   "binaries": {
 *     "linux-x64-gnu":   { "file": "cleo-supervisor.linux-x64-gnu",     "sha256": "…", "size": 2441472 },
 *     "linux-arm64-gnu": { "file": "cleo-supervisor.linux-arm64-gnu",   "sha256": "…", "size": 2400000 },
 *     "darwin-x64":      { "file": "cleo-supervisor.darwin-x64",        "sha256": "…", "size": 2500000 },
 *     "darwin-arm64":    { "file": "cleo-supervisor.darwin-arm64",      "sha256": "…", "size": 2480000 },
 *     "win32-x64-msvc":  { "file": "cleo-supervisor.win32-x64-msvc.exe","sha256": "…", "size": 2600000 }
 *   }
 * }
 * ```
 *
 * Usage:
 *   node packages/core/scripts/gen-supervisor-manifest.mjs \
 *     --bin-dir <dir-with-binaries> \
 *     --out <manifest.json> \
 *     [--version <ver>] [--repo kryptobaseddev/cleo]
 *
 * @task T11340
 */

import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Filename prefix shared by every supervisor binary artifact. */
const BIN_PREFIX = 'cleo-supervisor.';

/** Default GitHub repository slug for the release download base URL. */
const DEFAULT_REPO = 'kryptobaseddev/cleo';

/**
 * Map an artifact filename to its platform triple.
 *
 * `cleo-supervisor.linux-x64-gnu`        -> `linux-x64-gnu`
 * `cleo-supervisor.win32-x64-msvc.exe`   -> `win32-x64-msvc`
 *
 * @param {string} file - The artifact basename.
 * @returns {string | null} The triple, or null if the name is not a binary.
 */
function tripleFromFile(file) {
  if (!file.startsWith(BIN_PREFIX)) return null;
  let rest = file.slice(BIN_PREFIX.length);
  if (rest.endsWith('.exe')) rest = rest.slice(0, -'.exe'.length);
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
  // packages/core/scripts/gen-supervisor-manifest.mjs -> repo root is ../../..
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
      'usage: gen-supervisor-manifest.mjs --bin-dir <dir> --out <manifest.json> [--version <v>] [--repo <slug>]',
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
    console.error(`no cleo-supervisor.* binaries found in ${binDir}`);
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
