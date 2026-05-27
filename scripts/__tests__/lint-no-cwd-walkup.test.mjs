/**
 * Tests for scripts/lint-no-cwd-walkup.mjs (T11019 / Saga T10295 / Epic T10297).
 *
 * Strategy:
 *   - Import scanSource, parseArgs, runLint for direct unit testing.
 *   - Also exercise the CLI end-to-end via spawnSync with --files.
 *
 * @task T11019
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArgs, runLint, scanSource } from '../lint-no-cwd-walkup.mjs';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-no-cwd-walkup.mjs');

// ============================================================================
// Pure helper — scanSource (RULE-1: getCleoDirAbsolute outside paths.ts)
// ============================================================================

describe('scanSource — RULE-1 (getCleoDirAbsolute)', () => {
  it('flags getCleoDirAbsolute in a non-shim file', () => {
    const src = `import { getCleoDirAbsolute } from './paths.js';\nconst dir = getCleoDirAbsolute('/foo');\n`;
    const results = scanSource(src, 'packages/core/src/upgrade.ts');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      rule: 'RULE-1',
      file: 'packages/core/src/upgrade.ts',
      line: 1,
    });
    expect(results[1]).toMatchObject({
      rule: 'RULE-1',
      file: 'packages/core/src/upgrade.ts',
      line: 2,
    });
  });

  it('allows getCleoDirAbsolute in paths.ts (the shim)', () => {
    const src = `export function getCleoDirAbsolute(cwd) { return join(getProjectRoot(cwd), '.cleo'); }\n`;
    const results = scanSource(src, 'packages/core/src/paths.ts');
    expect(results).toHaveLength(0);
  });

  it('allows getCleoDirAbsolute in test files', () => {
    const src = `import { getCleoDirAbsolute } from '../paths.js';\n`;
    const results = scanSource(src, 'packages/core/src/__tests__/paths.test.ts');
    expect(results).toHaveLength(0);
  });

  it('allows getCleoDirAbsolute with // get-cleodir-ok opt-out', () => {
    const src = `const dir = getCleoDirAbsolute(cwd); // get-cleodir-ok: legacy caller in migration queue\n`;
    const results = scanSource(src, 'packages/core/src/upgrade.ts');
    expect(results).toHaveLength(0);
  });

  it('allows getCleoDirAbsolute with // cwd-walkup-ok opt-out', () => {
    const src = `const dir = getCleoDirAbsolute(cwd); // cwd-walkup-ok: T10297 migration pending\n`;
    const results = scanSource(src, 'packages/core/src/upgrade.ts');
    expect(results).toHaveLength(0);
  });

  it('does not flag unrelated code', () => {
    const src = `import { getProjectRoot } from './paths.js';\nconst root = getProjectRoot();\n`;
    const results = scanSource(src, 'packages/core/src/init.ts');
    expect(results).toHaveLength(0);
  });

  it('catches getCleoDirAbsolute in type position', () => {
    const src = `type Resolver = typeof getCleoDirAbsolute;\n`;
    const results = scanSource(src, 'packages/core/src/index.ts');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ rule: 'RULE-1', line: 1 });
  });
});

// ============================================================================
// Pure helper — scanSource (RULE-2: getProjectRoot(process.cwd()))
// ============================================================================

describe('scanSource — RULE-2 (getProjectRoot(process.cwd()))', () => {
  it('flags getProjectRoot(process.cwd())', () => {
    const src = `const root = getProjectRoot(process.cwd());\n`;
    const results = scanSource(src, 'packages/core/src/upgrade.ts');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ rule: 'RULE-2', line: 1 });
  });

  it('flags getProjectRoot with whitespace around process.cwd()', () => {
    const src = `const root = getProjectRoot(  process.cwd( ) );\n`;
    const results = scanSource(src, 'packages/core/src/upgrade.ts');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ rule: 'RULE-2', line: 1 });
  });

  it('allows getProjectRoot() without process.cwd()', () => {
    const src = `const root = getProjectRoot();\nconst root2 = getProjectRoot('/explicit/path');\n`;
    const results = scanSource(src, 'packages/core/src/upgrade.ts');
    expect(results).toHaveLength(0);
  });

  it('allows getProjectRoot(process.cwd()) in RULE_2_FILE_ALLOWLIST', () => {
    const src = `const root = getProjectRoot(process.cwd());\n`;
    const results = scanSource(src, 'packages/core/src/paths.ts');
    expect(results).toHaveLength(0);
  });

  it('allows getProjectRoot(process.cwd()) in test files', () => {
    const src = `const root = getProjectRoot(process.cwd());\n`;
    const results = scanSource(src, 'packages/core/src/__tests__/foo.test.ts');
    expect(results).toHaveLength(0);
  });

  it('allows getProjectRoot(process.cwd()) with // cwd-walkup-ok opt-out', () => {
    const src = `const root = getProjectRoot(process.cwd()); // cwd-walkup-ok: legacy\n`;
    const results = scanSource(src, 'packages/core/src/upgrade.ts');
    expect(results).toHaveLength(0);
  });
});

// ============================================================================
// parseArgs
// ============================================================================

describe('parseArgs', () => {
  it('defaults — no flags', () => {
    expect(parseArgs([])).toMatchObject({
      baselineMode: false,
      checkMode: false,
      strictMode: false,
      jsonMode: false,
      help: false,
      explicitFiles: null,
    });
  });

  it('detects --baseline', () => {
    expect(parseArgs(['--baseline']).baselineMode).toBe(true);
  });

  it('detects --check', () => {
    expect(parseArgs(['--check']).checkMode).toBe(true);
  });

  it('detects --strict', () => {
    expect(parseArgs(['--strict']).strictMode).toBe(true);
  });

  it('detects --json', () => {
    expect(parseArgs(['--json']).jsonMode).toBe(true);
  });

  it('detects --help / -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('captures files after --files', () => {
    const out = parseArgs(['--files', 'a.ts', 'b.ts']);
    expect(out.explicitFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('combines multiple flags', () => {
    const out = parseArgs(['--check', '--json', '--files', 'x.ts']);
    expect(out).toMatchObject({ checkMode: true, jsonMode: true, explicitFiles: ['x.ts'] });
  });
});

// ============================================================================
// runLint (programmatic API)
// ============================================================================

describe('runLint — programmatic', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lint-no-cwd-walkup-test-'));
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 0 when no violations found', () => {
    // Create a packages dir with a clean file
    const pkgDir = join(tmpDir, 'packages', 'core', 'src');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'clean.ts'), 'export const x = 1;\n');

    const result = runLint({ explicitFiles: null }, tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.violations).toHaveLength(0);
  });

  it('detects RULE-1 violation in explicit file', () => {
    const result = runLint({ explicitFiles: ['packages/core/src/upgrade.ts'] }, REPO_ROOT);
    // This file should have getCleoDirAbsolute references
    expect(result.violations.some((v) => v.rule === 'RULE-1')).toBe(true);
  });

  it('returns zero RULE-1 violations for paths.ts', () => {
    const result = runLint({ explicitFiles: ['packages/core/src/paths.ts'] }, REPO_ROOT);
    expect(result.violations.filter((v) => v.rule === 'RULE-1')).toHaveLength(0);
  });
});

// ============================================================================
// CLI end-to-end (spawnSync)
// ============================================================================

function runCli(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO_ROOT,
    timeout: 30000,
  });
}

describe('CLI bootstrap', () => {
  it('--help exits 0 and prints usage', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('lint-no-cwd-walkup.mjs');
    expect(r.stdout).toContain('@task T11019');
  });

  it('exits 0 with PASS banner on clean --files list', () => {
    const r = runCli(['--files', 'packages/core/src/paths.ts']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });

  it('exits 1 with FAIL when a violating file is present', () => {
    // packages/core/src/upgrade.ts definitely has getCleoDirAbsolute references
    const r = runCli(['--files', 'packages/core/src/upgrade.ts']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('RULE-1');
  });

  it('--check with --files exits 0 when within baseline', () => {
    // Baseline already exists from the earlier --baseline run
    // A single file that IS in the baseline should pass --check
    const r = runCli(['--check', '--files', 'packages/core/src/upgrade.ts']);
    // Check mode against baseline: the violations in upgrade.ts are already
    // counted in the baseline, so even though the file has violations,
    // --check should pass if the total doesn't exceed baseline.
    // But --files mode only scans the given file, so the total will be lower
    // than baseline (only violations from those files), which should also pass.
    expect(r.status).toBe(0);
  });

  it('--json emits valid JSON', () => {
    const r = runCli(['--json', '--files', 'packages/core/src/paths.ts']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({
      gate: 'lint-no-cwd-walkup',
      total: 0,
      rule1Count: 0,
      rule2Count: 0,
    });
  });
});

// ============================================================================
// Self-test against the live repo
// ============================================================================

describe('self-test against live repo', () => {
  it('--check mode passes against committed baseline', () => {
    const r = runCli(['--check']);
    // The baseline was just generated, so --check should pass
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });
});
