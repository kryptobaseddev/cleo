#!/usr/bin/env node
// scripts/lint-boundary-registry.mjs
//
// T10198 · Saga T10176 · ADR-078 · Decision D010 · T11107 (three-trigger update)
//
// Enforces the registry-vs-filesystem invariant for the Boundary Registry
// (packages/contracts/src/boundary.ts → BOUNDARY_REGISTRY).
//
// Rules:
//   1. ORPHAN — A crate/package exists on disk but has no BOUNDARY_REGISTRY entry.
//   2. MISSING — A BOUNDARY_REGISTRY entry references a rustCore/napiBinding/tsWrapper
//      path that no longer exists on disk (exempt when status is 'archived',
//      'deprecated', or 'migrated-out' with external canonicalHome).
//   3. INTENT_DRIFT — A registry entry declares napiBinding but intent is not
//      'rust-published' (lightweight heuristic).
//   4. INVALID_INTENT — An entry's intent is not one of the 3 valid triggers
//      ('ts-only', 'rust-published', 'rust-hotpath').
//   5. INVALID_STATUS — An entry's status is not one of the 4 valid values
//      ('active', 'deprecated', 'migrated-out', 'archived').
//
// The script loads the COMPILED registry from packages/contracts/dist/boundary.js,
// so `pnpm --filter @cleocode/contracts run build` MUST run first (CI handles this).
//
// Usage:
//   node scripts/lint-boundary-registry.mjs               # default — fails on any violation
//   node scripts/lint-boundary-registry.mjs --json        # machine-readable JSON report
//   node scripts/lint-boundary-registry.mjs --verbose     # also list OK modules
//   node scripts/lint-boundary-registry.mjs --fixture <p> # load a synthetic registry (poison-test mode)
//
// Exit codes:
//   0 — All registry entries match disk reality.
//   1 — One or more violations found.
//   2 — Setup/load error (compiled registry missing, etc.) — distinct from real violations
//       so CI surfaces the diagnostic separately.
//
// No untrusted input used — pure static analysis of checked-in source + the
// compiled registry artifact.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const verbose = args.includes('--verbose');

// Optional fixture path for poison-testing — when provided we load the
// registry from the fixture module instead of the canonical compiled artifact.
let fixturePath = null;
const fixtureIdx = args.indexOf('--fixture');
if (fixtureIdx !== -1) {
  fixturePath = args[fixtureIdx + 1];
  if (!fixturePath) {
    console.error('ERROR: --fixture requires a path argument');
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Registry loader
// ---------------------------------------------------------------------------

/**
 * Load the canonical BOUNDARY_REGISTRY from the compiled contracts artifact
 * (or a fixture path when poison-testing).
 *
 * @param {string|null} fixture - Optional absolute path to a fixture module.
 * @returns {Promise<readonly object[]>} The registry entries.
 */
async function loadRegistry(fixture) {
  if (fixture) {
    const abs = resolve(process.cwd(), fixture);
    if (!existsSync(abs)) {
      console.error(`ERROR: fixture not found: ${abs}`);
      process.exit(2);
    }
    const mod = await import(pathToFileURL(abs).href);
    if (!Array.isArray(mod.BOUNDARY_REGISTRY)) {
      console.error(`ERROR: fixture at ${abs} does not export BOUNDARY_REGISTRY array`);
      process.exit(2);
    }
    return mod.BOUNDARY_REGISTRY;
  }

  const compiled = join(REPO_ROOT, 'packages/contracts/dist/boundary.js');
  if (!existsSync(compiled)) {
    console.error(
      'ERROR: compiled boundary registry not found at packages/contracts/dist/boundary.js\n' +
        'Run: pnpm --filter @cleocode/contracts run build',
    );
    process.exit(2);
  }
  const mod = await import(pathToFileURL(compiled).href);
  if (!Array.isArray(mod.BOUNDARY_REGISTRY)) {
    console.error(
      'ERROR: packages/contracts/dist/boundary.js does not export BOUNDARY_REGISTRY array',
    );
    process.exit(2);
  }
  return mod.BOUNDARY_REGISTRY;
}

// ---------------------------------------------------------------------------
// Filesystem enumeration
// ---------------------------------------------------------------------------

/**
 * Enumerate Rust crate directories under `crates/`. A directory is treated as
 * a crate iff it contains a `Cargo.toml`.
 *
 * @returns {string[]} Sorted list of crate directory basenames.
 */
function enumerateCrates() {
  const cratesDir = join(REPO_ROOT, 'crates');
  if (!existsSync(cratesDir)) return [];
  return readdirSync(cratesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(cratesDir, name, 'Cargo.toml')))
    .sort();
}

/**
 * Enumerate npm package directories under `packages/`. A directory is treated
 * as a package iff it contains a `package.json`. Per-platform napi sidecar
 * packages (`<module>-napi-<triple>` such as `worktree-napi-linux-x64-gnu`)
 * are filtered OUT: they ship as artifacts of the canonical napi entry
 * already registered in BOUNDARY_REGISTRY and would otherwise produce false
 * ORPHAN reports.
 *
 * @returns {string[]} Sorted list of package directory basenames.
 */
function enumeratePackages() {
  const pkgDir = join(REPO_ROOT, 'packages');
  if (!existsSync(pkgDir)) return [];
  return readdirSync(pkgDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(pkgDir, name, 'package.json')))
    .filter((name) => !isNapiPlatformPackage(name))
    .sort();
}

/**
 * Returns true for per-platform napi sidecar packages whose canonical home
 * is the corresponding `<base>-napi` entry already in the registry.
 *
 * Matches names of the form `<base>-napi-<triple>` where `<triple>` looks
 * like `linux-x64-gnu`, `darwin-arm64`, `win32-x64-msvc`, etc.
 *
 * @param {string} name - Package directory name.
 * @returns {boolean}
 */
function isNapiPlatformPackage(name) {
  return /-napi-(linux|darwin|win32)(-[a-z0-9]+)+$/.test(name);
}

// ---------------------------------------------------------------------------
// Cross-check
// ---------------------------------------------------------------------------

/**
 * Returns true when a registry entry is allowed to reference a missing
 * on-disk module (e.g. migrated-out shells whose path may be deleted,
 * deprecated modules being phased out, archived entries).
 *
 * @param {object} entry - BoundaryEntry row.
 * @returns {boolean}
 */
function isMissingExempt(entry) {
  // Always exempt when status explicitly allows missing paths.
  if (entry.status === 'archived') return true;
  if (entry.status === 'deprecated') return true;
  // Migrated-out entries with external canonical home are reference-only —
  // the actual module lives elsewhere.
  if (entry.status === 'migrated-out') {
    if (
      typeof entry.canonicalHome === 'object' &&
      entry.canonicalHome &&
      'external' in entry.canonicalHome
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Cross-check the registry against on-disk reality.
 *
 * @param {readonly object[]} registry - Loaded BOUNDARY_REGISTRY entries.
 * @returns {{orphans: object[], missing: object[], driftIntent: object[], invalidIntent: object[], invalidStatus: object[], ok: object[]}}
 */
function crossCheck(registry) {
  const cratesOnDisk = enumerateCrates();
  const packagesOnDisk = enumeratePackages();

  // Collect every disk-relative path declared by the registry.
  const declaredRustCores = new Set();
  const declaredNapiBindings = new Set();
  const declaredTsWrappers = new Set();
  for (const entry of registry) {
    if (entry.rustCore) declaredRustCores.add(entry.rustCore);
    if (entry.napiBinding) declaredNapiBindings.add(entry.napiBinding);
    if (entry.tsWrapper) declaredTsWrappers.add(entry.tsWrapper);
  }

  const orphans = [];
  const missing = [];
  const driftIntent = [];
  const invalidIntent = [];
  const invalidStatus = [];
  const ok = [];

  // Valid intent and status values (three-trigger model: T11105/T11106).
  const VALID_INTENTS = new Set(['ts-only', 'rust-published', 'rust-hotpath']);
  const VALID_STATUSES = new Set(['active', 'deprecated', 'migrated-out', 'archived']);

  // Rule 1 — ORPHAN: crates on disk with no registry entry.
  for (const crate of cratesOnDisk) {
    const cratePath = `crates/${crate}`;
    const inRegistry = declaredRustCores.has(cratePath) || declaredNapiBindings.has(cratePath);
    if (!inRegistry) {
      orphans.push({ kind: 'crate', path: cratePath });
    }
  }

  // Rule 1 — ORPHAN: packages on disk with no registry entry.
  for (const pkg of packagesOnDisk) {
    const pkgPath = `packages/${pkg}`;
    const inRegistry = declaredTsWrappers.has(pkgPath) || declaredNapiBindings.has(pkgPath);
    if (!inRegistry) {
      orphans.push({ kind: 'package', path: pkgPath });
    }
  }

  // Rule 2 — MISSING: registry path that no longer exists on disk.
  // Rule 3 — INTENT_DRIFT: napiBinding declared but intent != rust-published.
  // Rule 4 — INVALID_INTENT: intent not in the 3-trigger set.
  // Rule 5 — INVALID_STATUS: status not in the 4-value set.
  for (const entry of registry) {
    const exemptMissing = isMissingExempt(entry);
    let entryOk = true;

    // Rule 4 — INVALID_INTENT
    if (!entry.intent || !VALID_INTENTS.has(entry.intent)) {
      invalidIntent.push({
        module: entry.module,
        declaredIntent: entry.intent ?? '(missing)',
      });
      entryOk = false;
    }

    // Rule 5 — INVALID_STATUS
    if (!entry.status || !VALID_STATUSES.has(entry.status)) {
      invalidStatus.push({
        module: entry.module,
        declaredStatus: entry.status ?? '(missing)',
      });
      entryOk = false;
    }

    if (entry.rustCore) {
      const absPath = join(REPO_ROOT, entry.rustCore);
      const exists = existsSync(absPath) && statSync(absPath).isDirectory();
      if (!exists && !exemptMissing) {
        missing.push({ module: entry.module, kind: 'rustCore', path: entry.rustCore });
        entryOk = false;
      }
    }
    if (entry.napiBinding) {
      const absPath = join(REPO_ROOT, entry.napiBinding);
      const exists = existsSync(absPath) && statSync(absPath).isDirectory();
      if (!exists && !exemptMissing) {
        missing.push({ module: entry.module, kind: 'napiBinding', path: entry.napiBinding });
        entryOk = false;
      }
      // Intent drift — napi binding declared but workload intent is not
      // rust-published (the three-trigger equivalent of the old ffi-surface).
      if (entry.intent !== 'rust-published') {
        driftIntent.push({
          module: entry.module,
          declaredIntent: entry.intent,
          reason: 'napiBinding present but intent !== rust-published',
        });
        entryOk = false;
      }
    }
    if (entry.tsWrapper) {
      const absPath = join(REPO_ROOT, entry.tsWrapper);
      const exists = existsSync(absPath) && statSync(absPath).isDirectory();
      if (!exists && !exemptMissing) {
        missing.push({ module: entry.module, kind: 'tsWrapper', path: entry.tsWrapper });
        entryOk = false;
      }
    }

    if (entryOk) ok.push(entry.module);
  }

  return { orphans, missing, driftIntent, invalidIntent, invalidStatus, ok };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Print a human-readable report to stderr/stdout and return the appropriate
 * exit code.
 *
 * @param {ReturnType<typeof crossCheck>} report - Cross-check result.
 * @returns {number} Process exit code.
 */
function printReport(report) {
  const { orphans, missing, driftIntent, invalidIntent, invalidStatus, ok } = report;
  const total = orphans.length + missing.length + driftIntent.length +
    invalidIntent.length + invalidStatus.length;

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          ok: total === 0,
          counts: {
            orphans: orphans.length,
            missing: missing.length,
            driftIntent: driftIntent.length,
            invalidIntent: invalidIntent.length,
            invalidStatus: invalidStatus.length,
            okEntries: ok.length,
          },
          orphans,
          missing,
          driftIntent,
          invalidIntent,
          invalidStatus,
        },
        null,
        2,
      ),
    );
    return total === 0 ? 0 : 1;
  }

  if (total === 0) {
    console.log(`Boundary registry matches filesystem reality. ${ok.length} entries verified.`);
    if (verbose) {
      for (const m of ok) console.log(`  ok  ${m}`);
    }
    return 0;
  }

  console.error('Boundary registry drift detected.');
  console.error('');
  if (orphans.length > 0) {
    console.error(`ORPHANS (${orphans.length}) — on disk but missing from BOUNDARY_REGISTRY:`);
    for (const o of orphans) {
      console.error(`  ${o.kind.padEnd(8)} ${o.path}`);
    }
    console.error('');
  }
  if (missing.length > 0) {
    console.error(
      `MISSING (${missing.length}) — registry entry references a path that does not exist:`,
    );
    for (const m of missing) {
      console.error(`  ${m.module.padEnd(28)} ${m.kind.padEnd(12)} ${m.path}`);
    }
    console.error('');
  }
  if (driftIntent.length > 0) {
    console.error(`INTENT DRIFT (${driftIntent.length}) — declared intent contradicts shape:`);
    for (const d of driftIntent) {
      console.error(`  ${d.module.padEnd(28)} intent=${d.declaredIntent}  ${d.reason}`);
    }
    console.error('');
  }
  console.error('Fix: amend BOUNDARY_REGISTRY in packages/contracts/src/boundary.ts');
  console.error('via an ADR-078 amendment + PR. See AGENTS.md "Boundary Registry" section.');
  return 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const registry = await loadRegistry(fixturePath);
const report = crossCheck(registry);
process.exit(printReport(report));
