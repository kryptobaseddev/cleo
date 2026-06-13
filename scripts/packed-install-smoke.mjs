#!/usr/bin/env node
/**
 * Packed-install smoke test (T12012 — systemic fix for third packaged-only
 * failure in 24h: DHQ-096 / DHQ-098 / DHQ-099).
 *
 * WHY THIS EXISTS
 * ---------------
 * The monorepo workspace resolves `@cleocode/*` imports via symlinks in
 * `node_modules/.pnpm`. A source file can import `@cleocode/utils` (or any
 * other workspace-private package) and every CI gate will pass because the
 * workspace graph satisfies the import at test/build time. The breakage only
 * surfaces when a CONSUMER installs the tarball from npm — the private package
 * is not published and the bare import is unresolvable.
 *
 * This script simulates a real npm install:
 *
 *   1. `npm pack` every published @cleocode package into a temp directory.
 *   2. Build a minimal app manifest that `npm install`s the @cleocode/cleo
 *      tarball with all peer @cleocode/* deps resolved from the LOCAL tarballs
 *      (via package.json `overrides`) rather than from the npm registry. This
 *      replicates the exact import graph a fresh `npm install @cleocode/cleo`
 *      would produce, without hitting the network.
 *   3. Run `cleo --version` via the installed binary and assert exit 0 +
 *      a non-empty version string.
 *
 * Any `ERR_MODULE_NOT_FOUND` for an undeclared workspace-private package will
 * surface here as a non-zero exit, failing the smoke test before publish.
 *
 * Usage (local):
 *   node scripts/packed-install-smoke.mjs
 *
 * Exit code 0 = smoke passed.
 * Exit code 1 = smoke failed (offending error printed to stderr).
 *
 * @task T12012
 * @epic T11679
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Published package list (must stay in sync with .github/workflows/release.yml
// `publish_pkg` invocations — see scripts/lint-publish-surface.mjs for the
// canonical enforcement).
// ---------------------------------------------------------------------------
const PUBLISHED_PKGS = [
  'adapters',
  'agents',
  'animations',
  'brain',
  'caamp',
  'cant',
  'cleo',
  'cleo-os',
  'contracts',
  'core',
  'git-shim',
  'lafs',
  'nexus',
  'paths',
  'playbooks',
  'runtime',
  'skills',
  'worktree',
];

/** Human-readable byte formatter. */
function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/**
 * Run a command synchronously, streaming stdout/stderr to the parent unless
 * `capture` is true (returns stdout as string).
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string; capture?: boolean; env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string | undefined}
 */
function run(cmd, args, opts = {}) {
  const { cwd = REPO_ROOT, capture = false, env } = opts;
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      stdio: capture ? 'pipe' : 'inherit',
      encoding: 'utf8',
      env: env ?? process.env,
    });
    return capture ? out : undefined;
  } catch (err) {
    if (capture && err.stdout) return err.stdout;
    throw err;
  }
}

async function main() {
  const tmpBase = mkdtempSync(join(tmpdir(), 'cleo-packed-smoke-'));
  console.log(`\n[packed-smoke] Working in ${tmpBase}`);

  const tarballs = join(tmpBase, 'tarballs');
  const app = join(tmpBase, 'app');
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(app, { recursive: true });

  // ---------------------------------------------------------------------------
  // Step 1: pnpm pack every published package into tarballs/
  //
  // IMPORTANT: must use `pnpm pack` (not `npm pack`) because this monorepo uses
  // pnpm workspaces. `npm pack` leaves `workspace:*` specifiers intact in the
  // packed package.json, which npm install cannot resolve. `pnpm pack` resolves
  // `workspace:*` to actual version strings before packing, matching the real
  // `pnpm publish` behaviour.
  // ---------------------------------------------------------------------------
  console.log('\n[packed-smoke] Step 1: packing all published packages (pnpm pack)...');
  /** @type {Record<string, string>} pkgName -> tarball absolute path */
  const tarballMap = {};

  for (const pkgDir of PUBLISHED_PKGS) {
    const pkgPath = join(REPO_ROOT, 'packages', pkgDir);
    if (!existsSync(pkgPath)) {
      console.warn(`  SKIP packages/${pkgDir} — directory not found`);
      continue;
    }
    const pkgJson = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'));
    const pkgName = pkgJson.name;
    if (!pkgName) {
      console.warn(`  SKIP packages/${pkgDir} — no name in package.json`);
      continue;
    }
    try {
      // pnpm pack outputs a multi-line summary ending with the tarball path.
      // We scan the output for the last line that ends with .tgz.
      const out = run('pnpm', ['pack', '--pack-destination', tarballs], {
        cwd: pkgPath,
        capture: true,
      });
      const lines = (out ?? '').trim().split('\n').filter(Boolean);
      // pnpm pack prints the tarball path as the last line; earlier lines are
      // a human-readable "Tarball Details" table. The tarball filename itself
      // may appear as a full path or a bare name depending on pnpm version.
      const tarLine = lines[lines.length - 1].trim();
      // If pnpm printed the full path, use it directly; otherwise join with tarballs dir.
      const tarPath = tarLine.startsWith('/') ? tarLine : join(tarballs, tarLine);
      if (!existsSync(tarPath)) {
        // Fallback: scan the tarballs dir for a file matching this package's name
        // (handles pnpm versions that print just the filename, not the full path).
        const tarName = lines
          .map((l) => l.trim())
          .find((l) => l.endsWith('.tgz') && l.includes(pkgDir.replace('/', '-')));
        const fallback = tarName ? join(tarballs, tarName) : null;
        if (!fallback || !existsSync(fallback)) {
          console.error(
            `  FAIL packages/${pkgDir}: pnpm pack reported '${tarLine}' but no matching tarball found in ${tarballs}`,
          );
          process.exit(1);
        }
        tarballMap[pkgName] = fallback;
        const size = readFileSync(fallback).length;
        console.log(`  packed ${pkgName} -> ${tarName} (${fmtBytes(size)})`);
        continue;
      }
      const size = readFileSync(tarPath).length;
      tarballMap[pkgName] = tarPath;
      console.log(`  packed ${pkgName} -> ${tarPath.split('/').pop()} (${fmtBytes(size)})`);
    } catch (err) {
      console.error(`  FAIL packages/${pkgDir}: pnpm pack failed — ${err.message}`);
      process.exit(1);
    }
  }

  const cleoTarball = tarballMap['@cleocode/cleo'];
  if (!cleoTarball) {
    console.error('  FATAL: @cleocode/cleo tarball not produced — check packages/cleo/');
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Step 2: build a minimal app package.json with overrides so npm resolves
  //         every @cleocode/* dependency to the local tarballs rather than the
  //         registry.
  // ---------------------------------------------------------------------------
  console.log('\n[packed-smoke] Step 2: building isolated app manifest...');

  // Build the overrides map: every @cleocode/* with a local tarball gets
  // overridden to `file:<path>` so npm does not fetch from the registry.
  /** @type {Record<string, string>} */
  const overrides = {};
  for (const [pkgName, tarPath] of Object.entries(tarballMap)) {
    overrides[pkgName] = `file:${tarPath}`;
  }

  const appPkgJson = {
    name: 'packed-smoke-app',
    version: '0.0.1',
    private: true,
    dependencies: {
      '@cleocode/cleo': `file:${cleoTarball}`,
    },
    overrides,
  };

  writeFileSync(join(app, 'package.json'), JSON.stringify(appPkgJson, null, 2) + '\n', 'utf8');
  console.log('  app/package.json written');

  // ---------------------------------------------------------------------------
  // Step 3: npm install into the app directory (no registry traffic — all
  //         @cleocode/* deps are served from local tarballs via overrides).
  // ---------------------------------------------------------------------------
  console.log('\n[packed-smoke] Step 3: npm install from local tarballs...');
  try {
    run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=warn'], { cwd: app });
  } catch (err) {
    console.error(`\n[packed-smoke] FAIL: npm install failed — ${err.message}`);
    console.error(
      'This means a published @cleocode/* package imports a workspace-private package ' +
        'that is not declared in its dependencies (ERR_MODULE_NOT_FOUND class of bug).',
    );
    process.exit(1);
  }
  console.log('  npm install succeeded');

  // ---------------------------------------------------------------------------
  // Step 4: smoke the installed binary.
  // ---------------------------------------------------------------------------
  console.log('\n[packed-smoke] Step 4: running installed cleo --version...');
  const cleoBin = join(app, 'node_modules', '.bin', 'cleo');
  if (!existsSync(cleoBin)) {
    console.error(`  FAIL: cleo binary not found at ${cleoBin} after install`);
    process.exit(1);
  }

  let versionOut;
  try {
    versionOut = run('node', [cleoBin, '--version'], {
      cwd: app,
      capture: true,
      env: {
        ...process.env,
        // Prevent cleo from trying to connect to a daemon or read live DBs;
        // we only need the version string to prove the module graph loads.
        CLEO_OFFLINE: '1',
        NO_COLOR: '1',
      },
    });
  } catch (err) {
    console.error(`\n[packed-smoke] FAIL: cleo --version exited non-zero — ${err.message}`);
    if (err.stderr) console.error(err.stderr);
    process.exit(1);
  }

  const version = (versionOut ?? '').trim();
  if (!version) {
    console.error('  FAIL: cleo --version printed nothing — binary may be broken');
    process.exit(1);
  }
  console.log(`  cleo --version => ${version}`);

  // ---------------------------------------------------------------------------
  // Cleanup and final verdict
  // ---------------------------------------------------------------------------
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }

  console.log('\n[packed-smoke] PASS — packed install smoke test succeeded.');
  console.log(
    `  Verified: npm pack + install + cleo --version exit 0 with ${Object.keys(tarballMap).length} @cleocode/* tarballs`,
  );
}

main().catch((err) => {
  console.error(`\n[packed-smoke] FATAL: ${err?.stack ?? err}`);
  process.exit(2);
});
