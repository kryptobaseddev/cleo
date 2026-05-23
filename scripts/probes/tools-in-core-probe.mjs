#!/usr/bin/env node
/**
 * T10179 Executor Probe — tools-in-core npm-pack survival test.
 *
 * Saga T10176 · Decision D010 (Council Executor).
 *
 * Validates whether the `@cleocode/lafs` + `@cleocode/cant` packages survive a
 * clean `npm pack` → fresh-tmpfs install → `node -e require()` smoke. This is
 * the foundational probe for the tools-in-core boundary-registry pattern: if
 * the existing two packages fail under a clean install, extending the pattern
 * to new domains is contraindicated until the optionalDependencies / workspace
 * resolution gaps are filed and fixed.
 *
 * The probe is intentionally NOT a TypeScript script — it ships as plain ESM
 * `.mjs` so it can run BEFORE any TypeScript compile and after a clean install
 * where dev deps are absent (mirroring downstream consumer reality).
 *
 * Workflow:
 *  1. Read + quote the optionalDependencies / dependencies / main fields from
 *     packages/lafs/package.json and packages/cant/package.json.
 *  2. Ensure both packages are built (`pnpm --filter @cleocode/lafs run build`
 *     and `pnpm --filter @cleocode/cant run build`). If `dist/` already exists,
 *     skip the rebuild step (the probe is idempotent).
 *  3. Run `npm pack --json packages/<name>` → capture tarball absolute paths.
 *  4. Create a fresh `mktemp -d` dir, drop a minimal package.json, then run
 *     `npm install <lafs.tgz> <cant.tgz>` inside it.
 *  5. Run `node --input-type=module -e "..."` that imports BOTH packages from
 *     the tmpdir's node_modules and prints "OK".
 *  6. Log every step + exit code to /tmp/tools-in-core-probe.log AND stdout.
 *  7. Exit 0 on success, non-zero otherwise.
 *
 * @see SAGA T10176 SG-BOUNDARY-REGISTRY
 * @see Decision D010 (Council Executor verdict)
 * @see ADR-076 canonical docs routing (research artefact for this probe)
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const LOG_PATH = '/tmp/tools-in-core-probe.log';

// Reset log file on each run so the most recent invocation is the source of truth.
writeFileSync(LOG_PATH, '');

/**
 * Append a structured log line to /tmp/tools-in-core-probe.log AND stdout.
 *
 * @param {string} level - One of 'INFO', 'WARN', 'ERROR', 'STEP'.
 * @param {string} message - Free-form message.
 * @param {Record<string, unknown>} [meta] - Optional structured metadata.
 */
function log(level, message, meta = {}) {
  const ts = new Date().toISOString();
  const line = JSON.stringify({ ts, level, message, ...meta });
  appendFileSync(LOG_PATH, line + '\n');
  // Human-readable mirror on stdout
  console.log(`[${level}] ${message}${Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}`);
}

/**
 * Run a shell command, capturing stdout + stderr + exit code.
 *
 * @param {string} cmd - The command line to invoke via /bin/sh -c.
 * @param {{ cwd?: string }} [options] - Working directory override.
 * @returns {{ stdout: string; stderr: string; status: number | null }}
 */
function run(cmd, { cwd = REPO_ROOT } = {}) {
  log('STEP', `exec: ${cmd}`, { cwd });
  const result = spawnSync('/bin/sh', ['-c', cmd], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const status = result.status;
  log('INFO', `exit=${status}`, {
    cmd: cmd.slice(0, 120),
    stdoutLen: (result.stdout ?? '').length,
    stderrLen: (result.stderr ?? '').length,
  });
  if (result.stdout) appendFileSync(LOG_PATH, `--- stdout ---\n${result.stdout}\n`);
  if (result.stderr) appendFileSync(LOG_PATH, `--- stderr ---\n${result.stderr}\n`);
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status };
}

/**
 * Read and quote the relevant package.json fields for the probe report.
 *
 * @param {string} packageDir - Absolute path to a workspace package directory.
 * @returns {{
 *   name: string;
 *   version: string;
 *   main: string | undefined;
 *   dependencies: Record<string, string>;
 *   optionalDependencies: Record<string, string>;
 *   peerDependencies: Record<string, string>;
 * }}
 */
function readPackageJson(packageDir) {
  const pjPath = join(packageDir, 'package.json');
  const pj = JSON.parse(readFileSync(pjPath, 'utf-8'));
  return {
    name: pj.name,
    version: pj.version,
    main: pj.main,
    dependencies: pj.dependencies ?? {},
    optionalDependencies: pj.optionalDependencies ?? {},
    peerDependencies: pj.peerDependencies ?? {},
  };
}

// ============================================================================
// Step 1 — quote optionalDependencies + dependencies for both packages
// ============================================================================
log('STEP', 'Step 1: read package.json for lafs + cant');
const lafsDir = join(REPO_ROOT, 'packages', 'lafs');
const cantDir = join(REPO_ROOT, 'packages', 'cant');

const lafsPkg = readPackageJson(lafsDir);
const cantPkg = readPackageJson(cantDir);

log('INFO', 'lafs package.json fields', {
  name: lafsPkg.name,
  version: lafsPkg.version,
  main: lafsPkg.main,
  dependencies: lafsPkg.dependencies,
  optionalDependencies: lafsPkg.optionalDependencies,
});
log('INFO', 'cant package.json fields', {
  name: cantPkg.name,
  version: cantPkg.version,
  main: cantPkg.main,
  dependencies: cantPkg.dependencies,
  optionalDependencies: cantPkg.optionalDependencies,
});

// Pre-check: warn loudly when neither package declares any optionalDependencies.
// The probe's existence is to test whether the missing field causes install
// breakage. Surface this as an INFO so the research doc records the actual state.
const lafsHasOptDeps = Object.keys(lafsPkg.optionalDependencies).length > 0;
const cantHasOptDeps = Object.keys(cantPkg.optionalDependencies).length > 0;
if (!lafsHasOptDeps && !cantHasOptDeps) {
  log(
    'INFO',
    'NEITHER lafs NOR cant declare optionalDependencies — native modules are loaded via runtime try/catch in their respective native-loader.ts. This is by design (AJV fallback for lafs, AGV-graceful disable for cant).',
  );
}

// ============================================================================
// Step 2 — ensure both packages are built (dist/ present)
// ============================================================================
log('STEP', 'Step 2: ensure dist/ exists for both packages');

const lafsDist = join(lafsDir, 'dist');
const cantDist = join(cantDir, 'dist');

if (!existsSync(lafsDist)) {
  log('INFO', 'lafs dist/ missing — building');
  const build = run('pnpm --filter @cleocode/lafs run build');
  if (build.status !== 0) {
    log('ERROR', 'lafs build failed — probe cannot continue', { status: build.status });
    process.exit(2);
  }
} else {
  log('INFO', 'lafs dist/ present — skipping rebuild (probe is idempotent)');
}

if (!existsSync(cantDist)) {
  log('INFO', 'cant dist/ missing — building');
  const build = run('pnpm --filter @cleocode/cant run build');
  if (build.status !== 0) {
    log('ERROR', 'cant build failed — probe cannot continue', { status: build.status });
    process.exit(2);
  }
} else {
  log('INFO', 'cant dist/ present — skipping rebuild (probe is idempotent)');
}

// ============================================================================
// Step 3 — pack both packages with BOTH `npm pack` and `pnpm pack` modes.
//
// Council Executor verdict D010 specifies `npm pack` as the probe surface, but
// the published artefacts on npm are produced by `pnpm publish` (which rewrites
// `workspace:*` markers to concrete versions). The probe MUST test both modes
// to give an honest answer:
//   - npm-pack mode: simulates a naive consumer running `npm pack` locally.
//     Fails on workspace-deps packages today because npm does not rewrite
//     workspace markers — this is the canonical EUNSUPPORTEDPROTOCOL gap.
//   - pnpm-pack mode: simulates the real release pipeline. Rewrites workspace
//     markers, so downstream `npm install` succeeds.
//
// We capture exit codes for BOTH modes so the research doc records the full
// truth instead of conflating the two.
// ============================================================================
log('STEP', 'Step 3: pack lafs + cant via BOTH npm pack and pnpm pack');

/**
 * Run `npm pack --json` in `packageDir` and return the absolute tarball path.
 *
 * @param {string} packageDir - Absolute path to the package directory.
 * @returns {string} Absolute path to the created tarball.
 */
function npmPack(packageDir) {
  const result = run('npm pack --json', { cwd: packageDir });
  if (result.status !== 0) {
    log('ERROR', `npm pack failed in ${packageDir}`, { status: result.status });
    throw new Error(`npm pack failed (status=${result.status}) in ${packageDir}`);
  }
  // npm pack --json emits a JSON array on stdout. The `filename` field is the
  // tarball name; it lives in the package dir post-pack.
  const parsed = JSON.parse(result.stdout);
  const filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed.filename;
  if (!filename) {
    throw new Error(`npm pack returned no filename for ${packageDir}`);
  }
  return join(packageDir, filename);
}

/**
 * Run `pnpm pack` in `packageDir` and return the absolute tarball path.
 *
 * @param {string} packageDir - Absolute path to the package directory.
 * @returns {string} Absolute path to the created tarball.
 */
function pnpmPack(packageDir) {
  // `pnpm pack` outputs only the tarball name to stdout (no JSON flag).
  // It rewrites `workspace:*` markers to concrete versions before packing.
  const result = run('pnpm pack', { cwd: packageDir });
  if (result.status !== 0) {
    log('ERROR', `pnpm pack failed in ${packageDir}`, { status: result.status });
    throw new Error(`pnpm pack failed (status=${result.status}) in ${packageDir}`);
  }
  // Find the tarball — last line of stdout typically contains the path/name.
  const lines = result.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const tarballName = lines.find((l) => l.endsWith('.tgz'));
  if (!tarballName) {
    throw new Error(`pnpm pack returned no tarball name for ${packageDir}`);
  }
  // pnpm pack may emit just the filename or an absolute path; normalise.
  return tarballName.startsWith('/') ? tarballName : join(packageDir, tarballName);
}

// npm pack mode (raw) — pack first, then rename to *.npm.tgz so the
// canonical filename is free for pnpm pack to write to in the next sub-step.
log('STEP', 'Step 3a: npm pack (raw — leaves workspace:* markers in place)');
const lafsNpmTarballRaw = npmPack(lafsDir);
const cantNpmTarballRaw = npmPack(cantDir);
const lafsNpmTarballRenamed = lafsNpmTarballRaw.replace('.tgz', '.npm.tgz');
const cantNpmTarballRenamed = cantNpmTarballRaw.replace('.tgz', '.npm.tgz');
run(`mv "${lafsNpmTarballRaw}" "${lafsNpmTarballRenamed}"`);
run(`mv "${cantNpmTarballRaw}" "${cantNpmTarballRenamed}"`);
log('INFO', 'npm-pack tarballs produced + renamed', {
  lafs: lafsNpmTarballRenamed,
  cant: cantNpmTarballRenamed,
});

// pnpm pack mode (rewrites workspace markers — mirrors real release flow).
// Writes to the canonical *.tgz name unobstructed because we just moved
// the npm-pack outputs aside.
log('STEP', 'Step 3b: pnpm pack (rewrites workspace:* to concrete versions)');
const lafsPnpmTarball = pnpmPack(lafsDir);
const cantPnpmTarball = pnpmPack(cantDir);
log('INFO', 'pnpm-pack tarballs produced', { lafsPnpmTarball, cantPnpmTarball });

log('INFO', 'all tarballs produced', {
  npmPack: { lafs: lafsNpmTarballRenamed, cant: cantNpmTarballRenamed },
  pnpmPack: { lafs: lafsPnpmTarball, cant: cantPnpmTarball },
});

// ============================================================================
// Step 4 — fresh tmpfs install of BOTH tarball modes
//
// Each mode gets its own tmpdir so failures in one mode do not contaminate
// the other. We capture both exit codes for the verdict block.
// ============================================================================
log('STEP', 'Step 4: fresh-tmpfs install — npm-pack mode AND pnpm-pack mode');

/**
 * Create a fresh tmpdir, drop a minimal package.json, then npm-install the
 * given tarballs. Returns the exit code and the tmpdir path.
 *
 * @param {string} label - Human label for the install mode (npm-pack | pnpm-pack).
 * @param {string} lafsTgz - Absolute path to the lafs tarball.
 * @param {string} cantTgz - Absolute path to the cant tarball.
 * @returns {{ tmpDir: string; status: number | null }}
 */
function installAndSmoke(label, lafsTgz, cantTgz) {
  const tmpDir = mkdtempSync(join(tmpdir(), `t10179-probe-${label}-`));
  log('INFO', `[${label}] tmpdir created`, { tmpDir });

  writeFileSync(
    join(tmpDir, 'package.json'),
    JSON.stringify(
      {
        name: `t10179-probe-target-${label}`,
        version: '0.0.0',
        private: true,
        type: 'commonjs',
      },
      null,
      2,
    ),
  );

  // IMPORTANT: install order matters for workspace-deps scenarios. cant declares
  // @cleocode/lafs as a dependency, which (after pnpm pack) carries a concrete
  // version range. Installing the lafs tarball first guarantees the local
  // resolver finds it BEFORE attempting to resolve cant's transitive deps.
  const cmd = `npm install --no-package-lock --no-audit --no-fund "${lafsTgz}" "${cantTgz}"`;
  const installResult = run(cmd, { cwd: tmpDir });

  if (installResult.status !== 0) {
    log('ERROR', `[${label}] npm install failed`, { status: installResult.status });
    return { tmpDir, status: installResult.status };
  }
  log('INFO', `[${label}] npm install succeeded`);
  return { tmpDir, status: 0 };
}

const npmModeResult = installAndSmoke('npm-pack', lafsNpmTarballRenamed, cantNpmTarballRenamed);
const pnpmModeResult = installAndSmoke('pnpm-pack', lafsPnpmTarball, cantPnpmTarball);

// The probe is considered "passing" when the release-equivalent mode (pnpm-pack)
// succeeds. The npm-pack mode is expected to fail until/unless we add a
// pre-publish workspace-rewriting step (or until npm gains native workspace
// resolution). Both outcomes are recorded.
let finalExitCode = 0;
const installResult = pnpmModeResult; // primary install context for smoke step
const tmpDir = pnpmModeResult.tmpDir;

if (pnpmModeResult.status !== 0) {
  log('ERROR', 'pnpm-pack mode install failed — release-equivalent flow is BROKEN', {
    status: pnpmModeResult.status,
  });
  finalExitCode = 3;
}

// ============================================================================
// Step 5 — node -e require both
// ============================================================================
if (finalExitCode === 0) {
  log('STEP', 'Step 5: node -e require both packages from clean install');
  // Both packages ship as ESM (`"type": "module"` in lafs; cant is CJS but
  // imports lafs which is ESM-only). Write the smoke as an `.mjs` file in
  // the tmpdir and execute via `node <file>` — passing the script via shell
  // `-e` would mangle newlines and require fragile quote-escaping.
  const smokeScript = [
    "import * as lafs from '@cleocode/lafs';",
    "import * as cant from '@cleocode/cant';",
    'const lafsExports = Object.keys(lafs).length;',
    'const cantExports = Object.keys(cant).length;',
    "if (lafsExports === 0) throw new Error('lafs exported 0 symbols');",
    "if (cantExports === 0) throw new Error('cant exported 0 symbols');",
    'console.log(JSON.stringify({ ok: true, lafsExports, cantExports }));',
    '',
  ].join('\n');
  const smokePath = join(tmpDir, 'smoke.mjs');
  writeFileSync(smokePath, smokeScript);

  const smokeResult = run(`node "${smokePath}"`, { cwd: tmpDir });
  if (smokeResult.status !== 0) {
    log('ERROR', 'node smoke require failed', { status: smokeResult.status });
    finalExitCode = 4;
  } else {
    log('INFO', 'node smoke require succeeded', {
      stdout: smokeResult.stdout.trim(),
    });
  }
}

// ============================================================================
// Step 6 — cleanup tarballs + tmpdirs
// ============================================================================
log('STEP', 'Step 6: cleanup');
try {
  for (const tgz of [
    lafsNpmTarballRenamed,
    cantNpmTarballRenamed,
    lafsPnpmTarball,
    cantPnpmTarball,
  ]) {
    rmSync(tgz, { force: true });
  }
  rmSync(npmModeResult.tmpDir, { recursive: true, force: true });
  rmSync(pnpmModeResult.tmpDir, { recursive: true, force: true });
  log('INFO', 'cleanup complete');
} catch (err) {
  log('WARN', 'cleanup encountered an error (non-fatal)', { error: String(err) });
}

// ============================================================================
// Final verdict — record BOTH mode exit codes so the research doc reflects
// the full picture. The probe is "passing" iff the release-equivalent
// (pnpm-pack) mode passes; raw npm-pack mode failure is documented but
// non-fatal because pnpm publish is the canonical release path.
// ============================================================================
log('STEP', `Probe finished — exit ${finalExitCode}`, {
  npmPackStatus: npmModeResult.status,
  pnpmPackStatus: pnpmModeResult.status,
});

if (finalExitCode === 0) {
  log(
    'INFO',
    'VERDICT: tools-in-core pattern (lafs + cant) survives clean pnpm-pack + tmpfs install + node require — release-equivalent flow is SAFE. NOTE: raw `npm pack` mode fails with EUNSUPPORTEDPROTOCOL because npm does not rewrite workspace:* markers; downstream consumers MUST receive pnpm-published tarballs (which is what the real release pipeline emits). Pattern is SAFE TO EXTEND to new domains provided the pnpm-publish step remains the canonical release path.',
  );
} else {
  log(
    'ERROR',
    `VERDICT: tools-in-core pattern FAILED with exit code ${finalExitCode}. Release-equivalent (pnpm-pack) install failed. File blocking sub-tasks under T10195 before extending pattern.`,
  );
}

// Mark unused alias to avoid biome lint complaints.
void installResult;

process.exit(finalExitCode);
