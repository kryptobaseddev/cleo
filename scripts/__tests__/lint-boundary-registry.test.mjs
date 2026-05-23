/**
 * Poison tests for scripts/lint-boundary-registry.mjs.
 *
 * Strategy:
 *   - The script accepts a `--fixture <path>` flag that bypasses the canonical
 *     compiled registry and loads BOUNDARY_REGISTRY from a synthetic ESM module
 *     instead. This lets us exercise every branch (clean, orphan, missing,
 *     intent-drift) without mutating the real packages/contracts/dist/boundary.js.
 *   - Each test writes a small fixture .mjs file under a tmpdir, runs the
 *     script with that fixture, and asserts on exit code + JSON output.
 *   - Disk enumeration still runs against the real cleocode tree, so fixtures
 *     either include EVERY on-disk crate/package (to demonstrate "clean"), or
 *     intentionally omit some entries (to demonstrate "orphan").
 *
 * @task T10198
 * @saga T10176
 * @adr ADR-078
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-boundary-registry.mjs');

/** @type {string} */
let tmpRoot;
/** @type {string} */
let fixturePath;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-boundary-lint-'));
  fixturePath = join(tmpRoot, 'fixture-registry.mjs');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Write a fixture module that exports a BOUNDARY_REGISTRY array.
 *
 * @param {object[]} entries
 */
function writeFixture(entries) {
  const src = `export const BOUNDARY_REGISTRY = ${JSON.stringify(entries, null, 2)};\n`;
  writeFileSync(fixturePath, src);
}

/**
 * Run the lint script with a fixture path.
 *
 * @param {string[]} extraArgs
 */
function runLint(extraArgs = []) {
  return spawnSync('node', [SCRIPT, '--fixture', fixturePath, ...extraArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO_ROOT,
  });
}

/**
 * Build a registry entry that mirrors a real on-disk crate so the script
 * treats it as known-good. Returns the minimal shape the linter inspects.
 *
 * @param {object} overrides
 */
function entry(overrides) {
  return {
    module: 'sample',
    intent: 'cpu-bound',
    canonicalHome: 'cleocode',
    perfBudget: {},
    safetyBudget: { panic_unwind: 'forbidden', root_escape: 'forbidden' },
    amendments: [],
    rationale: 'fixture entry',
    ...overrides,
  };
}

/**
 * Read all the real on-disk crates + packages so a "clean" fixture can
 * register every one of them. Mirrors the script's own enumeration so the
 * fixture matches the linter's expected universe exactly.
 *
 * @returns {{crates: string[], packages: string[]}}
 */
function enumerateDisk() {
  const cratesDir = join(REPO_ROOT, 'crates');
  const pkgDir = join(REPO_ROOT, 'packages');
  const crates = readdirSync(cratesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => existsSync(join(cratesDir, n, 'Cargo.toml')))
    .sort();
  const packages = readdirSync(pkgDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => existsSync(join(pkgDir, n, 'package.json')))
    .filter((n) => !/-napi-(linux|darwin|win32)(-[a-z0-9]+)+$/.test(n))
    .sort();
  return { crates, packages };
}

/**
 * Build a registry that covers EVERY on-disk module — represents a "clean" state.
 *
 * @returns {object[]}
 */
function buildCleanFixture() {
  const { crates, packages } = enumerateDisk();
  const entries = [];
  for (const c of crates) {
    entries.push(
      entry({
        module: c,
        // napi crates get napiBinding instead of rustCore so the intent-drift
        // heuristic stays happy.
        ...(c.endsWith('-napi')
          ? { napiBinding: `crates/${c}`, intent: 'ffi-surface' }
          : { rustCore: `crates/${c}` }),
      }),
    );
  }
  for (const p of packages) {
    entries.push(entry({ module: p, tsWrapper: `packages/${p}`, intent: 'orchestration-glue' }));
  }
  return entries;
}

// ============================================================================
// Clean-state fixture
// ============================================================================

describe('lint-boundary-registry — clean fixture', () => {
  it('exits 0 when every on-disk module has a matching registry entry', () => {
    writeFixture(buildCleanFixture());
    const result = runLint(['--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.counts.orphans).toBe(0);
    expect(parsed.counts.missing).toBe(0);
    expect(parsed.counts.driftIntent).toBe(0);
  });
});

// ============================================================================
// ORPHAN — disk module missing from registry
// ============================================================================

describe('lint-boundary-registry — orphan detection', () => {
  it('exits 1 and reports a crate orphan when registry omits an on-disk crate', () => {
    // Drop ALL crate entries — every on-disk crate should be reported as orphan.
    const clean = buildCleanFixture();
    const noCrates = clean.filter((e) => !e.rustCore && !e.napiBinding);
    writeFixture(noCrates);
    const result = runLint(['--json']);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.counts.orphans).toBeGreaterThan(0);
    const orphanKinds = parsed.orphans.map((o) => o.kind);
    expect(orphanKinds).toContain('crate');
  });

  it('exits 1 and reports a package orphan when registry omits an on-disk package', () => {
    // Drop ALL package entries — every on-disk package should be reported.
    const clean = buildCleanFixture();
    const noPackages = clean.filter((e) => !e.tsWrapper);
    writeFixture(noPackages);
    const result = runLint(['--json']);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.counts.orphans).toBeGreaterThan(0);
    const orphanKinds = parsed.orphans.map((o) => o.kind);
    expect(orphanKinds).toContain('package');
  });
});

// ============================================================================
// MISSING — registry references a path that does not exist on disk
// ============================================================================

describe('lint-boundary-registry — missing detection', () => {
  it('exits 1 when a registry rustCore path does not exist on disk', () => {
    const clean = buildCleanFixture();
    clean.push(
      entry({
        module: 'phantom-crate',
        rustCore: 'crates/does-not-exist-on-disk',
        intent: 'cpu-bound',
      }),
    );
    writeFixture(clean);
    const result = runLint(['--json']);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.counts.missing).toBeGreaterThanOrEqual(1);
    expect(parsed.missing.some((m) => m.module === 'phantom-crate')).toBe(true);
  });

  it('exits 1 when a registry tsWrapper path does not exist on disk', () => {
    const clean = buildCleanFixture();
    clean.push(
      entry({
        module: 'phantom-package',
        tsWrapper: 'packages/does-not-exist-on-disk',
        intent: 'orchestration-glue',
      }),
    );
    writeFixture(clean);
    const result = runLint(['--json']);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.counts.missing).toBeGreaterThanOrEqual(1);
  });

  it('does NOT report MISSING when canonicalHome === "archived"', () => {
    const clean = buildCleanFixture();
    clean.push(
      entry({
        module: 'phantom-archived',
        rustCore: 'crates/does-not-exist-on-disk',
        intent: 'migration-pending',
        canonicalHome: 'archived',
      }),
    );
    writeFixture(clean);
    const result = runLint(['--json']);
    // Archived path is exempt from missing — exit 0 unless other failures exist.
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.counts.missing).toBe(0);
  });
});

// ============================================================================
// INTENT DRIFT — napiBinding declared but workload intent doesn't match
// ============================================================================

describe('lint-boundary-registry — intent drift', () => {
  it('exits 1 when napiBinding is declared but intent is not ffi-surface', () => {
    const clean = buildCleanFixture();
    // Pick an existing napi crate but tag it with a non-ffi intent.
    const napiCrateIdx = clean.findIndex((e) => e.napiBinding);
    expect(napiCrateIdx).toBeGreaterThanOrEqual(0);
    clean[napiCrateIdx] = { ...clean[napiCrateIdx], intent: 'data-manifest' };
    writeFixture(clean);
    const result = runLint(['--json']);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.counts.driftIntent).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// CLI plumbing — fixture flag validation
// ============================================================================

describe('lint-boundary-registry — CLI plumbing', () => {
  it('exits 2 when --fixture path does not exist', () => {
    const result = spawnSync('node', [SCRIPT, '--fixture', join(tmpRoot, 'no-such-file.mjs')], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('fixture not found');
  });

  it('exits 2 when fixture does not export BOUNDARY_REGISTRY', () => {
    writeFileSync(fixturePath, 'export const NOT_THE_REGISTRY = [];\n');
    const result = runLint();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('does not export BOUNDARY_REGISTRY');
  });
});
