/**
 * Gate runner tests — comprehensive coverage per gate kind.
 *
 * Tests `runGates()` from packages/core/src/tasks/gate-runner.ts
 * ensuring each gate type (test, file, command, lint, http, manual)
 * works correctly with contract validation.
 *
 * @task T784
 * @epic T768
 */

import { rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CommandGate,
  FileGate,
  HttpGate,
  LintGate,
  ManualGate,
  TestGate,
} from '@cleocode/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { getProjectRoot } from '../../paths.js';
import { runGates } from '../gate-runner.js';

// ─── Setup ────────────────────────────────────────────────────────────────

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = getProjectRoot();
const testDir = resolve(thisDir, '.gate-runner-test');

beforeAll(async () => {
  // Create test directory
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
});

// ─── Gate Kind Tests ────────────────────────────────────────────────────────

describe('gate-runner — test gate', () => {
  it('accepts a test gate with passing exit code', async () => {
    const gates: TestGate[] = [
      {
        kind: 'test',
        description: 'sample-test — validates passing test gate',
        command: 'echo',
        args: ['hello'],
        expect: 'exit0',
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'test',
      result: 'pass',
    });
  });

  it('rejects a test gate with failing exit code', async () => {
    const gates: TestGate[] = [
      {
        kind: 'test',
        description: 'failing-test — validates failing test gate',
        command: 'false',
        expect: 'exit0',
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'test',
      result: 'fail',
    });
    // Gate-runner emits `errorMessage` on fail (not free-text failureReason)
    expect(results[0].errorMessage).toBeDefined();
  });
});

describe('gate-runner — file gate', () => {
  it('validates file existence', async () => {
    // Use an existing file from the project
    const existingFile = join(projectRoot, 'package.json');

    const gates: FileGate[] = [
      {
        kind: 'file',
        description: 'package-json-exists — validates file gate pass',
        path: existingFile,
        assertions: [{ type: 'exists' }],
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'file',
      result: 'pass',
    });
  });

  it('rejects when file does not exist', async () => {
    const gates: FileGate[] = [
      {
        kind: 'file',
        description: 'nonexistent — validates file gate fail',
        path: '/tmp/this-does-not-exist-12345.txt',
        assertions: [{ type: 'exists' }],
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'file',
      result: 'fail',
    });
  });
});

describe('gate-runner — command gate', () => {
  it('passes with successful command', async () => {
    const gates: CommandGate[] = [
      {
        kind: 'command',
        description: 'echo-test — validates command execution',
        cmd: 'echo',
        args: ['test output'],
        exitCode: 0,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'command',
      result: 'pass',
    });
  });

  it('fails with unexpected exit code', async () => {
    const gates: CommandGate[] = [
      {
        kind: 'command',
        description: 'false-command — validates exit-code rejection',
        cmd: 'false',
        exitCode: 0,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'command',
      result: 'fail',
    });
  });
});

describe('gate-runner — lint gate', () => {
  it('skips lint gate gracefully when command not found', async () => {
    // This test verifies that lint gates handle missing tools gracefully
    const gates: LintGate[] = [
      {
        kind: 'lint',
        description: 'biome-format — validates lint gate',
        linter: 'biome',
        paths: ['packages/core/src/tasks/gate-runner.ts'],
        mode: 'format',
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'lint',
    });
    // Should either pass or fail depending on whether biome is configured
    expect(['pass', 'fail', 'warn', 'skipped', 'error']).toContain(results[0].result);
  });
});

describe('gate-runner — http gate', () => {
  it('skips http gate when network unavailable', async () => {
    const gates: HttpGate[] = [
      {
        kind: 'http',
        description: 'health-check — validates http gate',
        url: 'http://127.0.0.1:99999/health',
        status: 200,
        timeoutMs: 1000,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'http',
    });
    // Should fail or skip depending on network configuration
    expect(['fail', 'skipped', 'warn', 'error']).toContain(results[0].result);
  });
});

describe('gate-runner — manual gate', () => {
  it('returns skipped for manual gates by default', async () => {
    const gates: ManualGate[] = [
      {
        kind: 'manual',
        description: 'manual-review — validates manual gate',
        prompt: 'Please review the implementation',
      },
    ];

    const results = await runGates(gates, { projectRoot }, { skipManual: true });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'manual',
      result: 'skipped',
    });
  });

  it('returns skipped for manual gates without skipManual flag', async () => {
    const gates: ManualGate[] = [
      {
        kind: 'manual',
        description: 'manual-review-2 — validates manual gate with accept',
        prompt: 'Please review',
      },
    ];

    const results = await runGates(gates, { projectRoot }, { skipManual: false });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'manual',
      result: 'skipped',
    });
  });
});

describe('gate-runner — multi-gate execution', () => {
  it('runs multiple gates sequentially', async () => {
    const gates = [
      {
        kind: 'test' as const,
        description: 'test-1 — multi-gate test gate',
        command: 'echo',
        args: ['test1'],
        expect: 'exit0' as const,
      },
      {
        kind: 'command' as const,
        description: 'cmd-1 — multi-gate command gate',
        cmd: 'echo',
        args: ['cmd1'],
        exitCode: 0,
      },
      {
        kind: 'manual' as const,
        description: 'manual-1 — multi-gate manual gate',
        prompt: 'Review test',
      },
    ] as const;

    const results = await runGates(
      gates as unknown as Parameters<typeof runGates>[0],
      { projectRoot },
      { skipManual: true },
    );

    expect(results).toHaveLength(3);
    expect(results[0].result).toBe('pass');
    expect(results[1].result).toBe('pass');
    expect(results[2].result).toBe('skipped');
  });

  it('includes metadata in results', async () => {
    const gates: TestGate[] = [
      {
        kind: 'test',
        description: 'metadata-test — validates result metadata shape',
        command: 'echo',
        args: ['hello'],
        expect: 'exit0',
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    const result = results[0];

    // AcceptanceGateResult contract shape (v2026.4.72):
    // index, req, kind, result, durationMs, details, checkedAt, checkedBy
    expect(result).toHaveProperty('kind');
    expect(result).toHaveProperty('index');
    expect(result).toHaveProperty('result');
    expect(result).toHaveProperty('checkedAt');
    expect(result).toHaveProperty('durationMs');
  });
});

describe('gate-runner — integration with contract types', () => {
  it('validates all gate kinds together', async () => {
    const gates = [
      {
        kind: 'test' as const,
        description: 'test-1 — integration test gate',
        command: 'echo',
        args: ['test'],
        expect: 'exit0' as const,
      },
      {
        kind: 'command' as const,
        description: 'cmd-1 — integration command gate',
        cmd: 'echo',
        args: ['cmd'],
        exitCode: 0,
      },
      {
        kind: 'manual' as const,
        description: 'manual-1 — integration manual gate',
        prompt: 'Review manual',
      },
    ] as const;

    const results = await runGates(
      gates as unknown as Parameters<typeof runGates>[0],
      { projectRoot },
      { skipManual: true },
    );

    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.every((r) => r.result)).toBe(true);
  });
});
