/**
 * Tests for scripts/lint-cli-package-boundary.mjs (T10076 / SG-ARCH-SOLID T9837e).
 *
 * Strategy:
 *   - Create an isolated tmpdir with synthetic TypeScript command files.
 *   - Override the scan directory via a test-only --dir flag is not supported
 *     by the script, so we symlink the scan dir or use SCAN_DIR env shim.
 *   - Instead: the script hard-codes `packages/cleo/src/cli/commands` relative
 *     to cwd. We run the script with a temporary cwd that contains a
 *     synthetic `packages/cleo/src/cli/commands/` subtree.
 *   - Assert stdout/stderr content and exit codes.
 *
 * Cases covered:
 *   - PASS: file with only small functions (< 30 LOC)
 *   - PASS: file with only defineCommand shapes
 *   - PASS: function named *Command (exempt by convention)
 *   - PASS: function with inline opt-out `// cli-boundary-ok:`
 *   - PASS: file-level opt-out `// cli-boundary-file-ok:`
 *   - FAIL: file with a standalone function > 30 LOC
 *   - BASELINE: writes baseline JSON, exits 0
 *   - CHECK/PASS: violation count matches baseline
 *   - CHECK/FAIL: violation count exceeds baseline
 *   - STRICT/PASS: zero violations in strict mode
 *   - STRICT/FAIL: violations present in strict mode
 *   - JSON: emits parseable JSON to stdout
 *
 * @task T10076
 * @epic T9837
 * @saga T9831
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-cli-package-boundary.mjs');

/** Synthetic project root containing a commands subtree. */
let tmpRoot;
/** The synthetic commands directory inside the project root. */
let commandsDir;
/** The synthetic dispatch domains directory inside the project root. */
let domainsDir;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-cli-boundary-lint-'));
  commandsDir = join(tmpRoot, 'packages', 'cleo', 'src', 'cli', 'commands');
  domainsDir = join(tmpRoot, 'packages', 'cleo', 'src', 'dispatch', 'domains');
  mkdirSync(commandsDir, { recursive: true });
  mkdirSync(domainsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Run the lint script with tmpRoot as cwd (so scan dir resolves correctly).
 * @param {string[]} extraArgs
 */
function runLint(extraArgs = []) {
  return spawnSync('node', [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: tmpRoot,
  });
}

/** Write a synthetic TypeScript command file into the commands dir. */
function writeCommandFile(name, content) {
  writeFileSync(join(commandsDir, name), content);
}

/** Write a synthetic TypeScript dispatch domain file into the domains dir. */
function writeDomainFile(name, content) {
  writeFileSync(join(domainsDir, name), content);
}

/** Build a function body string that is guaranteed to be exactly `loc` lines long. */
function buildFunctionBody(name, loc) {
  const bodyLines = loc - 2; // subtract the opening and closing brace lines
  const body = Array.from({ length: Math.max(1, bodyLines) }, (_, i) => `  const x${i} = ${i};`);
  return `function ${name}() {\n${body.join('\n')}\n}\n`;
}

// ============================================================================
// PASS cases
// ============================================================================

describe('lint-cli-package-boundary — clean files', () => {
  it('exits 0 when the commands directory is empty', () => {
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits 0 when all functions are <= 30 LOC', () => {
    writeCommandFile('small.ts', buildFunctionBody('doSomethingSmall', 10));
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits 0 when file contains only defineCommand assignments', () => {
    writeCommandFile(
      'dispatch.ts',
      `import { defineCommand } from 'citty';\n` +
        `export const fooCommand = defineCommand({\n` +
        `  meta: { name: 'foo' },\n` +
        `  async run() {\n` +
        `    return;\n` +
        `  },\n` +
        `});\n`,
    );
    const result = runLint();
    expect(result.status).toBe(0);
  });

  it('exits 0 for a large function named *Command (exempt by convention)', () => {
    writeCommandFile('maker.ts', buildFunctionBody('makeFooCommand', 80));
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits 0 for a large function named *Command (camelCase suffix)', () => {
    writeCommandFile('maker2.ts', buildFunctionBody('buildBarCommand', 60));
    const result = runLint();
    expect(result.status).toBe(0);
  });

  it('exits 0 when function has per-line opt-out comment', () => {
    const body = `function bigHelper() { // cli-boundary-ok: wraps OS-level API, cannot move to core\n${Array.from({ length: 35 }, (_, i) => `  const v${i} = ${i};`).join('\n')}\n}\n`;
    writeCommandFile('opt-out.ts', body);
    const result = runLint();
    expect(result.status).toBe(0);
  });

  it('exits 0 when file has per-file opt-out marker in first 20 lines', () => {
    const header = `// cli-boundary-file-ok: legacy file, migration tracked by T9833\n`;
    writeCommandFile('file-opt-out.ts', header + buildFunctionBody('veryBigHelper', 100));
    const result = runLint();
    expect(result.status).toBe(0);
  });

  it('skips __tests__ subdirectory', () => {
    const testsDir = join(commandsDir, '__tests__');
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(join(testsDir, 'big.test.ts'), buildFunctionBody('doTestStuff', 100));
    const result = runLint();
    expect(result.status).toBe(0);
  });

  it('skips *.test.ts files at the commands level', () => {
    writeCommandFile('foo.test.ts', buildFunctionBody('bigTestHelper', 80));
    const result = runLint();
    expect(result.status).toBe(0);
  });
});

// ============================================================================
// FAIL (default mode)
// ============================================================================

describe('lint-cli-package-boundary — violations (default mode)', () => {
  it('exits 1 when a function exceeds 30 LOC', () => {
    writeCommandFile('bad.ts', buildFunctionBody('bigBusinessHelper', 50));
    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bigBusinessHelper');
    expect(result.stderr).toContain('RULE-1');
  });

  it('reports file path relative to repo root', () => {
    writeCommandFile('path-check.ts', buildFunctionBody('fatHelper', 40));
    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('path-check.ts');
  });

  it('reports line number of the function declaration', () => {
    const preamble = '// top comment\n// second comment\n';
    writeCommandFile('line-num.ts', preamble + buildFunctionBody('bigHelper', 50));
    const result = runLint();
    expect(result.status).toBe(1);
    // The function starts at line 3 (after two preamble lines)
    expect(result.stderr).toMatch(/:3\b/);
  });

  it('reports LOC count in the violation message', () => {
    writeCommandFile('loc-report.ts', buildFunctionBody('bigOp', 45));
    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/\d+ LOC/);
  });

  it('flags exactly 31 LOC as a violation (boundary case)', () => {
    writeCommandFile('boundary.ts', buildFunctionBody('boundaryHelper', 31));
    const result = runLint();
    expect(result.status).toBe(1);
  });

  it('exits 1 when a CLI command imports the dispatch registry compatibility layer', () => {
    writeCommandFile(
      'registry-backedge.ts',
      `import { OPERATIONS } from '../../dispatch/registry.js';\n` +
        `export const names = OPERATIONS.map((op) => op.operation);\n`,
    );
    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RULE-2');
    expect(result.stderr).toContain('dispatch/registry.js');
  });

  it('exits 1 when a dispatch domain handler imports the dispatch registry compatibility layer', () => {
    writeDomainFile(
      'tasks.ts',
      `import { resolve } from '../registry.js';\n` +
        `export function handle() { return resolve('query', 'tasks', 'show'); }\n`,
    );
    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RULE-2');
    expect(result.stderr).toContain('../registry.js');
  });

  it('does not flag CLI/domain adapters that import operation metadata from contracts', () => {
    writeCommandFile(
      'contracts-registry.ts',
      `import { OPERATIONS } from '@cleocode/contracts';\n` +
        `export const names = OPERATIONS.map((op) => op.operation);\n`,
    );
    writeDomainFile(
      'contracts-domain.ts',
      `import { type OperationDef } from '@cleocode/contracts';\n` +
        `export function handle(def: OperationDef) { return def.operation; }\n`,
    );
    const result = runLint();
    expect(result.status).toBe(0);
  });

  it('does NOT flag exactly 30 LOC (at threshold, not over)', () => {
    writeCommandFile('at-threshold.ts', buildFunctionBody('okHelper', 30));
    const result = runLint();
    expect(result.status).toBe(0);
  });
});

// ============================================================================
// --baseline mode
// ============================================================================

describe('lint-cli-package-boundary — --baseline mode', () => {
  it('writes baseline JSON and exits 0 even with violations', () => {
    writeCommandFile('big.ts', buildFunctionBody('reallyBigHelper', 60));
    const result = runLint(['--baseline']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Baseline written');

    const baselinePath = join(tmpRoot, 'scripts', '.lint-cli-boundary-baseline.json');
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    expect(baseline.total).toBeGreaterThanOrEqual(1);
    expect(baseline.gate).toBe('cli-package-boundary');
  });

  it('baseline contains violation details', () => {
    writeCommandFile('documented.ts', buildFunctionBody('detailedHelper', 55));
    runLint(['--baseline']);

    const baselinePath = join(tmpRoot, 'scripts', '.lint-cli-boundary-baseline.json');
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    expect(baseline.violations.length).toBeGreaterThanOrEqual(1);
    const v = baseline.violations[0];
    expect(v).toHaveProperty('funcName');
    expect(v).toHaveProperty('file');
    expect(v).toHaveProperty('loc');
  });
});

// ============================================================================
// --check mode
// ============================================================================

describe('lint-cli-package-boundary — --check mode', () => {
  it('exits 1 when baseline file is missing', () => {
    const result = runLint(['--check']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('baseline file not found');
  });

  it('exits 0 when violation count matches baseline', () => {
    writeCommandFile('stable.ts', buildFunctionBody('stableHelper', 50));
    runLint(['--baseline']);
    const result = runLint(['--check']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits 0 when violation count DECREASES (progress)', () => {
    // First generate a baseline with 1 violation
    writeCommandFile('one.ts', buildFunctionBody('helperOne', 50));
    runLint(['--baseline']);

    // Remove the violating file (improvement)
    rmSync(join(commandsDir, 'one.ts'));

    const result = runLint(['--check']);
    expect(result.status).toBe(0);
  });

  it('exits 1 when violation count INCREASES above baseline', () => {
    writeCommandFile('original.ts', buildFunctionBody('helperOrig', 50));
    runLint(['--baseline']);

    // Add a new violation above the baseline
    writeCommandFile('new-bad.ts', buildFunctionBody('newBadHelper', 60));
    const result = runLint(['--check']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('REGRESSION');
  });
});

// ============================================================================
// --strict mode
// ============================================================================

describe('lint-cli-package-boundary — --strict mode', () => {
  it('exits 0 in strict mode when no violations exist', () => {
    writeCommandFile('clean.ts', buildFunctionBody('tinyHelper', 5));
    const result = runLint(['--strict']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits 1 in strict mode when any violation exists', () => {
    writeCommandFile('big.ts', buildFunctionBody('bigFatHelper', 55));
    const result = runLint(['--strict']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('strict mode');
  });
});

// ============================================================================
// --json mode
// ============================================================================

describe('lint-cli-package-boundary — --json mode', () => {
  it('emits parseable JSON to stdout', () => {
    writeCommandFile('json-test.ts', buildFunctionBody('jsonHelper', 50));
    const result = runLint(['--json']);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('gate', 'cli-package-boundary');
    expect(parsed).toHaveProperty('total');
    expect(parsed).toHaveProperty('violations');
    expect(Array.isArray(parsed.violations)).toBe(true);
  });

  it('JSON output includes violation metadata', () => {
    writeCommandFile('meta-test.ts', buildFunctionBody('metaHelper', 55));
    const result = runLint(['--json']);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.violations.length).toBeGreaterThanOrEqual(1);
    const v = parsed.violations[0];
    expect(v).toHaveProperty('file');
    expect(v).toHaveProperty('line');
    expect(v).toHaveProperty('funcName');
    expect(v).toHaveProperty('loc');
    expect(v).toHaveProperty('rule', 'RULE-1');
  });

  it('exits 1 with --json when violations exist (default mode)', () => {
    writeCommandFile('json-fail.ts', buildFunctionBody('bigJsonHelper', 70));
    const result = runLint(['--json']);
    expect(result.status).toBe(1);
  });
});
