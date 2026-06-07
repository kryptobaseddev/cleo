/**
 * Tests for scripts/lint-no-bare-get-active-session.mjs (T11640 · Epic T11638).
 *
 * Strategy mirrors the sibling SG-ARCH-SOLID lint tests: run the real script
 * with a synthetic `packages/...` subtree as cwd, asserting that NET-NEW bare
 * `getActiveSession(` callsites are caught while definitions, the
 * `getActiveSessionInfo(` symbol, opt-outs, and baselined callsites are not.
 *
 * Cases covered:
 *   - STRICT: zero bare callsites → exit 0
 *   - STRICT: a bare callsite → exit 1 + reports the file
 *   - DEFINITION: method/interface signatures are NOT bare callsites
 *   - INFO: getActiveSessionInfo() is NOT counted
 *   - OPT-OUT: `// get-active-session-allowed` suppresses a callsite
 *   - TEST FILES: *.test.ts and __tests__/ are skipped
 *   - BASELINE: first run writes baseline, exits 0
 *   - DEFAULT: count == baseline → exit 0; NET-NEW callsite → exit 1
 *
 * @task T11640
 * @epic T11638
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-no-bare-get-active-session.mjs');

/** Synthetic project root containing a packages subtree. */
let tmpRoot;
/** A scannable source dir inside the synthetic project. */
let srcDir;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-gas-lint-'));
  srcDir = join(tmpRoot, 'packages', 'core', 'src', 'demo');
  mkdirSync(srcDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Run the lint script with tmpRoot as cwd so its `packages/` scan resolves.
 * @param {string[]} extraArgs
 */
function runLint(extraArgs = []) {
  return spawnSync('node', [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: tmpRoot,
  });
}

/** Write a synthetic source file into the scannable src dir. */
function writeSrc(name, content) {
  writeFileSync(join(srcDir, name), content);
}

const baselinePath = () =>
  join(tmpRoot, 'scripts', '.lint-no-bare-get-active-session-baseline.json');

// ============================================================================
// --strict mode
// ============================================================================

describe('lint-no-bare-get-active-session — --strict mode', () => {
  it('exits 0 when there are no bare callsites', () => {
    writeSrc('clean.ts', 'export const x = 1;\n');
    const result = runLint(['--strict']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('STRICT OK');
  });

  it('exits 1 and reports a synthetic NEW bare callsite', () => {
    writeSrc(
      'identity.ts',
      'export async function whoAmI() {\n' +
        '  const s = await getActiveSession(projectRoot);\n' +
        '  return s;\n' +
        '}\n',
    );
    const result = runLint(['--strict']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('STRICT FAIL');
    expect(result.stderr).toContain('packages/core/src/demo/identity.ts');
  });

  it('catches an accessor-method bare invocation', () => {
    writeSrc('via-accessor.ts', 'const s = await accessor.getActiveSession();\n');
    const result = runLint(['--strict']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('via-accessor.ts');
  });

  it('does NOT flag a method/interface DEFINITION', () => {
    writeSrc(
      'definition.ts',
      'interface Acc {\n' +
        '  getActiveSession(): Promise<unknown>;\n' +
        '}\n' +
        'class Impl implements Acc {\n' +
        '  async getActiveSession(): Promise<unknown> {\n' +
        '    return null;\n' +
        '  }\n' +
        '}\n',
    );
    const result = runLint(['--strict']);
    expect(result.status).toBe(0);
  });

  it('does NOT flag the distinct getActiveSessionInfo() symbol', () => {
    writeSrc('info.ts', 'const info = await getActiveSessionInfo(cwd);\n');
    const result = runLint(['--strict']);
    expect(result.status).toBe(0);
  });

  it('does NOT flag a line that only mentions the symbol in a comment', () => {
    writeSrc('comment.ts', '// historically used getActiveSession() here\nexport const y = 2;\n');
    const result = runLint(['--strict']);
    expect(result.status).toBe(0);
  });

  it('honours the per-line opt-out marker', () => {
    writeSrc(
      'scan.ts',
      'const any = await getActiveSession(); // get-active-session-allowed: scan for any active session\n',
    );
    const result = runLint(['--strict']);
    expect(result.status).toBe(0);
  });

  it('skips *.test.ts files', () => {
    writeSrc('demo.test.ts', 'const s = await getActiveSession();\n');
    const result = runLint(['--strict']);
    expect(result.status).toBe(0);
  });

  it('skips __tests__ directories', () => {
    const testsDir = join(srcDir, '__tests__');
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(join(testsDir, 'mock.ts'), 'const s = await getActiveSession();\n');
    const result = runLint(['--strict']);
    expect(result.status).toBe(0);
  });
});

// ============================================================================
// baseline / default mode
// ============================================================================

describe('lint-no-bare-get-active-session — baseline (default) mode', () => {
  it('first run writes the baseline and exits 0 even with callsites', () => {
    writeSrc('pre-existing.ts', 'const s = await getActiveSession(projectRoot);\n');
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('baseline created');

    const baseline = JSON.parse(readFileSync(baselinePath(), 'utf-8'));
    expect(baseline.total).toBe(1);
    expect(baseline.callsites).toContain('packages/core/src/demo/pre-existing.ts:1');
  });

  it('passes when the count matches the baseline', () => {
    writeSrc('stable.ts', 'const s = await getActiveSession();\n');
    runLint(); // write baseline
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('passes (and notes progress) when a baselined callsite is removed', () => {
    writeSrc('going.ts', 'const s = await getActiveSession();\n');
    runLint(); // baseline with 1
    rmSync(join(srcDir, 'going.ts'));
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('migrated vs baseline');
  });

  it('FAILS on a NET-NEW bare callsite above the baseline', () => {
    writeSrc('original.ts', 'const s = await getActiveSession();\n');
    runLint(); // baseline with 1

    writeSrc('new-identity.ts', 'const s2 = await getActiveSession(projectRoot);\n');
    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL');
    expect(result.stderr).toContain('packages/core/src/demo/new-identity.ts');
    // The pre-existing baselined callsite is NOT listed as a new violation.
    expect(result.stderr).not.toContain('original.ts');
  });

  it('--check is a no-op alias for default baseline mode', () => {
    writeSrc('stable.ts', 'const s = await getActiveSession();\n');
    runLint(['--check']); // bootstraps baseline
    const result = runLint(['--check']);
    expect(result.status).toBe(0);
  });

  it('--update-baseline lowers the recorded count', () => {
    writeSrc('a.ts', 'const s = await getActiveSession();\n');
    writeSrc('b.ts', 'const s = await getActiveSession();\n');
    runLint(); // baseline with 2
    rmSync(join(srcDir, 'b.ts'));
    const result = runLint(['--update-baseline']);
    expect(result.status).toBe(0);
    const baseline = JSON.parse(readFileSync(baselinePath(), 'utf-8'));
    expect(baseline.total).toBe(1);
  });
});
