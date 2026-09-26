#!/usr/bin/env node
/**
 * Lint rule: native binaries are BUILT, never committed (T12382 · arch gate 24).
 *
 * Until T12382 the only `.cant` parser users ever received was
 * `packages/cant/napi/cant.linux-x64-gnu.node`, a binary committed to git.
 * Every other OS threw on the first `.cant` parse, and nothing tied that
 * binary to the source it claimed to be: `crates/lafs-napi`'s committed
 * binary had already drifted far enough to reject every real CLEO envelope.
 * A committed binary goes stale silently, so this gate has two modes.
 *
 * 1. Repository mode (default, `--check`, `--strict`): no tracked `*.node` or
 *    `*.wasm` file. {@link BASELINE} holds pre-existing violations outside
 *    the cant addon so the gate can ratchet; `--strict` ignores the
 *    baseline. A cant binary (`packages/cant/**`, `crates/cant-*`) can never
 *    be baselined.
 *
 * 2. Packed mode (`--packed <packageDir> --expect-rev <rev>`), run by the
 *    release after staging `@cleocode/cant`: `npm pack --dry-run` must ship
 *    exactly the generated loader, the WASI glue, the `.wasm` and one `.node`
 *    per required triple, and every packed binary must carry the literal
 *    `cant-napi-source-rev:<rev>` (stamped by `crates/cant-napi/build.rs`).
 *    A leftover or stale binary lacks the stamp of the commit being released
 *    and fails the release.
 *
 * REPO_ROOT is `process.cwd()` so unit tests can target a synthetic tree.
 *
 * @task T12382
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tracked native binaries that predate this gate. Each must leave the tree;
 * the gate only stops the list from growing. `--strict` ignores it.
 *
 * - `crates/lafs-napi/lafs-napi.linux-x64-gnu.node`: stale (rejects every
 *   real envelope) and never loaded (see the T12382 Rust study, section 5).
 *   Removing it belongs to the LAFS-native work, not the cant addon.
 */
export const BASELINE = new Set(['crates/lafs-napi/lafs-napi.linux-x64-gnu.node']);

/** Every native triple the release ships for `@cleocode/cant`. */
export const CANT_NATIVE_TRIPLES = [
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'linux-x64-musl',
  'linux-arm64-musl',
  'darwin-arm64',
  'darwin-x64',
  'win32-x64-msvc',
  'win32-arm64-msvc',
];

/** The WebAssembly fallback artifact name (napi-rs `wasm32-wasip1-threads`). */
export const CANT_WASM_FILE = 'napi/cant.wasm32-wasi.wasm';

/** Non-binary files the generated loader needs at runtime. */
export const CANT_LOADER_FILES = ['napi/index.cjs', 'napi/cant.wasi.cjs', 'napi/wasi-worker.mjs'];

/** Prefix of the source-revision stamp compiled into every binary. */
export const SOURCE_REV_PREFIX = 'cant-napi-source-rev:';

/**
 * Whether a repo-relative path belongs to the cant addon (never baselinable).
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isCantBinaryPath(path) {
  return path.startsWith('packages/cant/') || /^crates\/cant-[^/]+\//.test(path);
}

/**
 * Classify tracked files: which native binaries violate the gate.
 *
 * @param {string[]} trackedFiles - repo-relative paths from `git ls-files`
 * @param {{ strict?: boolean }} [options]
 * @returns {{ violations: string[], baselined: string[] }}
 */
export function scanCommittedBinaries(trackedFiles, options = {}) {
  const violations = [];
  const baselined = [];
  for (const file of trackedFiles) {
    if (!/\.(node|wasm)$/.test(file)) continue;
    if (!options.strict && BASELINE.has(file) && !isCantBinaryPath(file)) {
      baselined.push(file);
      continue;
    }
    violations.push(file);
  }
  return { violations: violations.sort(), baselined: baselined.sort() };
}

/**
 * Assess what `npm pack` would ship for `@cleocode/cant`.
 *
 * @param {object} input
 * @param {string[]} input.packedFiles - package-relative paths `npm pack` lists
 * @param {(path: string) => Buffer} input.readFile - reads a package-relative file
 * @param {string} input.expectRev - the revision every binary must be stamped with
 * @param {string[]} [input.triples] - native triples that must be present
 * @returns {string[]} problems; empty means the pack is complete and fresh
 */
export function assessPackedCant({
  packedFiles,
  readFile,
  expectRev,
  triples = CANT_NATIVE_TRIPLES,
}) {
  const problems = [];
  const packed = new Set(packedFiles);
  const requiredBinaries = [...triples.map((t) => `napi/cant.${t}.node`), CANT_WASM_FILE];

  for (const file of [...CANT_LOADER_FILES, ...requiredBinaries]) {
    if (!packed.has(file)) problems.push(`missing from the pack: ${file}`);
  }
  for (const file of packedFiles) {
    if (/\.(node|wasm)$/.test(file) && !requiredBinaries.includes(file)) {
      problems.push(`unexpected binary in the pack (leftover or debug build): ${file}`);
    }
  }
  const stamp = Buffer.from(`${SOURCE_REV_PREFIX}${expectRev}`);
  for (const file of requiredBinaries) {
    if (!packed.has(file)) continue;
    const bytes = readFile(file);
    if (bytes.length === 0) {
      problems.push(`empty binary: ${file}`);
    } else if (!bytes.includes(stamp)) {
      problems.push(`stale binary (not built from ${expectRev}): ${file}`);
    }
  }
  return problems;
}

/**
 * Read an option value from argv (`--name value`).
 *
 * @param {string[]} argv
 * @param {string} name
 * @returns {string | undefined}
 */
function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/** Packed-mode CLI entry. */
function mainPacked(argv) {
  const packageDir = option(argv, '--packed');
  const expectRev = option(argv, '--expect-rev');
  const triplesArg = option(argv, '--triples');
  if (!packageDir || !expectRev) {
    console.error(
      'usage: lint-no-committed-native-binaries.mjs --packed <dir> --expect-rev <rev> [--triples a,b]',
    );
    return 2;
  }
  const triples = triplesArg ? triplesArg.split(',').filter(Boolean) : CANT_NATIVE_TRIPLES;
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const [report] = JSON.parse(out);
  const packedFiles = report.files.map((f) => f.path.replaceAll('\\', '/'));
  const problems = assessPackedCant({
    packedFiles,
    readFile: (path) => readFileSync(join(packageDir, path)),
    expectRev,
    triples,
  });
  if (problems.length > 0) {
    console.error(
      `\n✗ packed @cleocode/cant is incomplete or stale (${problems.length} problem(s)):\n`,
    );
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `\nEvery binary must be built in this run from ${expectRev} (CANT_NAPI_SOURCE_REV) by\n` +
        '.github/workflows/cant-napi-build.yml and staged into packages/cant/napi/.\n',
    );
    return 1;
  }
  console.log(
    `✓ packed @cleocode/cant ships ${triples.length} native triple(s) + WASI, all stamped ${expectRev}.`,
  );
  return 0;
}

/** Repository-mode CLI entry. */
function mainRepo(argv) {
  const strict = argv.includes('--strict');
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\0')
    .filter(Boolean);
  const { violations, baselined } = scanCommittedBinaries(tracked, { strict });
  if (violations.length > 0) {
    console.error(`\n✗ committed native binaries (${violations.length}):\n`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      '\nNative binaries are built by CI and staged at release, never committed: a committed\n' +
        'binary goes stale silently. `git rm --cached` the file and gitignore its build output.\n' +
        'The cant addon is built by `pnpm --filter @cleocode/cant build:napi` (and build:napi:wasi).\n',
    );
    return 1;
  }
  const note = baselined.length > 0 ? ` (${baselined.length} baselined, see BASELINE)` : '';
  console.log(`✓ no committed native binaries${note}.`);
  return 0;
}

if (process.argv[1]?.endsWith('lint-no-committed-native-binaries.mjs')) {
  const argv = process.argv.slice(2);
  process.exit(argv.includes('--packed') ? mainPacked(argv) : mainRepo(argv));
}
