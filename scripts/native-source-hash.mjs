#!/usr/bin/env node
/**
 * Native SOURCE hash for the napi addons the release bundles.
 *
 * Until now every native binary was stamped with `GITHUB_SHA`, so the release
 * rebuilt 8 cant triples + WASI and 4 worktree triples from scratch on every
 * tag, even when not one byte of Rust had changed since the last release.
 * The stamp proved "built in this run", which is stronger than the property
 * T12382 needs and far more expensive: the property is that the published
 * binary was built from THIS release's native SOURCE.
 *
 * This script names that source. The hash covers exactly the inputs that can
 * change the bytes of the binary:
 *
 *   - every tracked file under the addon's crates (`crates/cant-*`, or
 *     `crates/worktree-napi` + its path dependency `crates/worktrunk-core`);
 *   - `Cargo.lock`, the workspace `Cargo.toml` (profiles, workspace deps) and
 *     `rust-toolchain.toml`;
 *   - the workflow that builds the addon (its build flags, `-x`, `--use-cross`,
 *     WASI setup) and this script (so a change to the definition busts the
 *     cache rather than silently reusing a binary hashed a different way);
 *   - the napi build config, as a PROJECTION of the package.json that carries
 *     it: the `napi` block and the `build:napi*` scripts, plus the WASI glue
 *     versions for cant. The whole manifest is NOT hashed, because the release
 *     rewrites its `version` on every release and the version never reaches
 *     the binary.
 *
 * Files are identified by their git blob id from the index (`git ls-files -s`)
 * rather than working-tree bytes, so line-ending conversion and the release's
 * own version sync cannot move the hash.
 *
 * The hash is the stamp: CI exports it as `CANT_NAPI_SOURCE_REV` /
 * `WORKTREE_NAPI_SOURCE_REV`, `build.rs` compiles it into the binary, the
 * build workflows cache the verified bundle under it, and the release's
 * publish job recomputes it from the tagged commit and refuses any binary
 * that does not carry it (`lint-no-committed-native-binaries.mjs --packed`).
 *
 * Usage: `node scripts/native-source-hash.mjs <cant|worktree>` prints the hex
 * digest on stdout. REPO_ROOT is `process.cwd()` so tests can target a
 * synthetic repository.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Workspace-wide inputs shared by every addon. */
const SHARED_PATHS = ['Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml', '.cargo'];

/**
 * Per-addon source definition.
 *
 * `paths` are git pathspecs; `exclude` removes tracked files whose content is
 * covered by a projection instead; `projections` name a manifest and the keys
 * of it that reach the build.
 *
 * @type {Record<string, { paths: string[]; exclude: string[]; projections: { file: string; pick: (manifest: Record<string, unknown>) => unknown }[] }>}
 */
export const NATIVE_SOURCE_SETS = {
  cant: {
    paths: [
      'crates/cant-*',
      ...SHARED_PATHS,
      '.github/workflows/cant-napi-build.yml',
      'scripts/native-source-hash.mjs',
    ],
    exclude: [],
    projections: [
      {
        file: 'packages/cant/package.json',
        pick: (m) => {
          const scripts = /** @type {Record<string, string>} */ (m.scripts ?? {});
          const deps = /** @type {Record<string, string>} */ (m.dependencies ?? {});
          return {
            napi: m.napi ?? null,
            buildNapi: scripts['build:napi'] ?? null,
            buildNapiWasi: scripts['build:napi:wasi'] ?? null,
            emnapiCore: deps['@emnapi/core'] ?? null,
            emnapiRuntime: deps['@emnapi/runtime'] ?? null,
            wasmRuntime: deps['@napi-rs/wasm-runtime'] ?? null,
          };
        },
      },
    ],
  },
  worktree: {
    paths: [
      'crates/worktree-napi',
      'crates/worktrunk-core',
      ...SHARED_PATHS,
      '.github/workflows/worktree-napi-prebuild.yml',
      'scripts/native-source-hash.mjs',
    ],
    // The release syncs this manifest's `version`; only its `napi` block
    // reaches the build, and that is hashed through the projection below.
    exclude: ['crates/worktree-napi/package.json'],
    projections: [
      {
        file: 'crates/worktree-napi/package.json',
        pick: (m) => ({ napi: m.napi ?? null }),
      },
    ],
  },
};

/**
 * Compute the native source hash for one addon.
 *
 * @param {keyof typeof NATIVE_SOURCE_SETS} addon - `cant` or `worktree`
 * @param {string} [root] - repository root (defaults to cwd)
 * @returns {string} lowercase hex sha256
 */
export function computeNativeSourceHash(addon, root = process.cwd()) {
  const set = NATIVE_SOURCE_SETS[addon];
  if (!set) {
    throw new Error(
      `unknown addon '${addon}' (expected one of: ${Object.keys(NATIVE_SOURCE_SETS).join(', ')})`,
    );
  }
  const listing = execFileSync('git', ['ls-files', '-s', '-z', '--', ...set.paths], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  const entries = [];
  for (const record of listing.split('\0')) {
    if (record === '') continue;
    // `<mode> <blob> <stage>\t<path>`
    const tab = record.indexOf('\t');
    const [mode, blob] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (set.exclude.includes(path)) continue;
    entries.push(`${path}\0${mode}\0${blob}`);
  }
  if (entries.length === 0) {
    throw new Error(`no tracked files matched the ${addon} native source set`);
  }
  entries.sort();

  const hash = createHash('sha256');
  hash.update(`native-source-hash:v1:${addon}\n`);
  for (const entry of entries) hash.update(`${entry}\n`);
  for (const projection of set.projections) {
    const raw = execFileSync('git', ['cat-file', 'blob', `:${projection.file}`], {
      cwd: root,
      encoding: 'utf8',
    });
    const picked = projection.pick(JSON.parse(raw));
    hash.update(`${projection.file}\0${JSON.stringify(picked)}\n`);
  }
  return hash.digest('hex');
}

if (process.argv[1]?.endsWith('native-source-hash.mjs')) {
  const addon = process.argv[2];
  if (addon === undefined || !(addon in NATIVE_SOURCE_SETS)) {
    console.error(`usage: native-source-hash.mjs <${Object.keys(NATIVE_SOURCE_SETS).join('|')}>`);
    process.exit(2);
  }
  process.stdout.write(`${computeNativeSourceHash(/** @type {'cant' | 'worktree'} */ (addon))}\n`);
}
