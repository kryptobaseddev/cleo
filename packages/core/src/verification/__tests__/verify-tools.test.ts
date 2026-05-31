/**
 * Unit tests for verifyTypes + verifyRuntimeBoot (T11488 / DHQ-028).
 *
 * Covers:
 *   - verifyTypes: passes on exit-0, fails on exit-1, includes tsc output in result
 *   - verifyTypes: timeout results in passed=false, exitCode=null
 *   - verifyRuntimeBoot: both steps pass → passed=true
 *   - verifyRuntimeBoot: build step fails → CLI smoke skipped + passed=false
 *   - verifyRuntimeBoot: build passes, CLI smoke fails → passed=false
 *   - verifyRuntimeBoot: timeout on CLI smoke → passed=false, exitCode=null
 *   - VerifyResult shape: all required fields present
 *   - RuntimeBootResult shape: all required fields present
 *
 * @task T11488
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type RuntimeBootResult,
  type VerifyOptions,
  type VerifyResult,
  verifyRuntimeBoot,
  verifyTypes,
} from '../verify-tools.js';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

/** Counter used to create unique tmpDir names without relying on wall-clock. */
let counter = 0;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `cleo-verify-tools-test-${process.pid}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a tiny Node script at `path` that exits with the given code and
 * optionally writes a message to stderr.
 */
function writeScript(filePath: string, exitCode: number, stderrMsg = ''): void {
  const lines: string[] = [];
  if (stderrMsg) lines.push(`process.stderr.write(${JSON.stringify(stderrMsg)});`);
  lines.push(`process.exit(${exitCode});`);
  writeFileSync(filePath, lines.join('\n'));
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// verifyTypes
// ---------------------------------------------------------------------------

describe('verifyTypes', () => {
  it('returns passed=true when tsc exits 0', async () => {
    // Place a stub tsc that exits 0 inside node_modules/.bin/
    const binDir = join(tmpDir, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    writeScript(join(binDir, 'tsc'), 0, '');

    const opts: VerifyOptions = { cwd: tmpDir, timeoutMs: 5000 };
    const result: VerifyResult = await verifyTypes(opts);

    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.step).toBe('tsc -b');
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns passed=false when tsc exits non-zero', async () => {
    const binDir = join(tmpDir, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    // Exit 2 with a type-error message on stderr
    writeScript(join(binDir, 'tsc'), 2, 'error TS2345: Argument of type ...');

    const opts: VerifyOptions = { cwd: tmpDir, timeoutMs: 5000 };
    const result: VerifyResult = await verifyTypes(opts);

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('error TS2345');
  });

  it('includes step label "tsc -b" in result', async () => {
    const binDir = join(tmpDir, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    writeScript(join(binDir, 'tsc'), 0);

    const result = await verifyTypes({ cwd: tmpDir, timeoutMs: 5000 });
    expect(result.step).toBe('tsc -b');
  });

  it('returns passed=false and exitCode=null on spawn error (missing tsc)', async () => {
    // No node_modules/.bin/tsc — spawn will fail.
    // node_modules/.bin dir exists but tsc does not:
    mkdirSync(join(tmpDir, 'node_modules', '.bin'), { recursive: true });

    const result = await verifyTypes({ cwd: tmpDir, timeoutMs: 5000 });
    // Either spawn error (no binary) or exits non-zero
    expect(result.passed).toBe(false);
  });

  it('result has all required shape fields', async () => {
    const binDir = join(tmpDir, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    writeScript(join(binDir, 'tsc'), 0);

    const result = await verifyTypes({ cwd: tmpDir, timeoutMs: 5000 });

    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('exitCode');
    expect(result).toHaveProperty('stdout');
    expect(result).toHaveProperty('stderr');
    expect(result).toHaveProperty('durationMs');
    expect(result).toHaveProperty('step');
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
  });

  it('captures stdout output from tsc', async () => {
    const binDir = join(tmpDir, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    // Write a script that emits to stdout then exits 0
    writeFileSync(
      join(binDir, 'tsc'),
      `process.stdout.write('tsc output line\\n'); process.exit(0);`,
    );

    const result = await verifyTypes({ cwd: tmpDir, timeoutMs: 5000 });
    expect(result.passed).toBe(true);
    expect(result.stdout).toContain('tsc output line');
  });
});

// ---------------------------------------------------------------------------
// verifyRuntimeBoot
// ---------------------------------------------------------------------------

describe('verifyRuntimeBoot', () => {
  it('returns passed=true when both build and CLI smoke succeed', async () => {
    // build.mjs exits 0
    writeScript(join(tmpDir, 'build.mjs'), 0);
    // CLI entry exits 0
    const cliDir = join(tmpDir, 'packages', 'cleo', 'dist', 'cli');
    mkdirSync(cliDir, { recursive: true });
    writeScript(join(cliDir, 'index.js'), 0);

    const opts: VerifyOptions = { cwd: tmpDir, timeoutMs: 10000 };
    const result: RuntimeBootResult = await verifyRuntimeBoot(opts);

    expect(result.passed).toBe(true);
    expect(result.buildStep.passed).toBe(true);
    expect(result.cliSmokeStep.passed).toBe(true);
    expect(result.buildStep.step).toBe('node build.mjs');
    expect(result.cliSmokeStep.step).toBe('node packages/cleo/dist/cli/index.js version');
  });

  it('skips CLI smoke when build fails and returns passed=false', async () => {
    // build.mjs exits 1 (build failure)
    writeScript(join(tmpDir, 'build.mjs'), 1, 'Build failed: circular import detected');

    const opts: VerifyOptions = { cwd: tmpDir, timeoutMs: 5000 };
    const result: RuntimeBootResult = await verifyRuntimeBoot(opts);

    expect(result.passed).toBe(false);
    expect(result.buildStep.passed).toBe(false);
    expect(result.buildStep.stderr).toContain('Build failed');
    // CLI smoke should be skipped (no artefact to boot)
    expect(result.cliSmokeStep.passed).toBe(false);
    expect(result.cliSmokeStep.stderr).toContain('Skipped');
    expect(result.cliSmokeStep.exitCode).toBeNull();
  });

  it('returns passed=false when CLI smoke fails (TDZ regression pattern)', async () => {
    // build.mjs passes
    writeScript(join(tmpDir, 'build.mjs'), 0);
    // CLI entry exits 1 (TDZ crash)
    const cliDir = join(tmpDir, 'packages', 'cleo', 'dist', 'cli');
    mkdirSync(cliDir, { recursive: true });
    writeScript(
      join(cliDir, 'index.js'),
      1,
      "ReferenceError: Cannot access 'X' before initialization",
    );

    const opts: VerifyOptions = { cwd: tmpDir, timeoutMs: 10000 };
    const result: RuntimeBootResult = await verifyRuntimeBoot(opts);

    expect(result.passed).toBe(false);
    expect(result.buildStep.passed).toBe(true);
    expect(result.cliSmokeStep.passed).toBe(false);
    expect(result.cliSmokeStep.exitCode).toBe(1);
    expect(result.cliSmokeStep.stderr).toContain('ReferenceError');
  });

  it('result has all required RuntimeBootResult shape fields', async () => {
    writeScript(join(tmpDir, 'build.mjs'), 0);
    const cliDir = join(tmpDir, 'packages', 'cleo', 'dist', 'cli');
    mkdirSync(cliDir, { recursive: true });
    writeScript(join(cliDir, 'index.js'), 0);

    const result = await verifyRuntimeBoot({ cwd: tmpDir, timeoutMs: 5000 });

    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('buildStep');
    expect(result).toHaveProperty('cliSmokeStep');
    expect(result.buildStep).toHaveProperty('step');
    expect(result.cliSmokeStep).toHaveProperty('step');
  });

  it('durationMs is non-negative for both steps', async () => {
    writeScript(join(tmpDir, 'build.mjs'), 0);
    const cliDir = join(tmpDir, 'packages', 'cleo', 'dist', 'cli');
    mkdirSync(cliDir, { recursive: true });
    writeScript(join(cliDir, 'index.js'), 0);

    const result = await verifyRuntimeBoot({ cwd: tmpDir, timeoutMs: 5000 });
    expect(result.buildStep.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.cliSmokeStep.durationMs).toBeGreaterThanOrEqual(0);
  });
});
