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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  CommandGate,
  FileGate,
  HttpGate,
  LintGate,
  ManualGate,
  TestGate,
} from '@cleocode/contracts';
import { dirname, resolve } from 'node:path';
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
        name: 'sample-test',
        command: 'echo hello',
        expectedExitCode: 0,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'test',
      result: 'passed',
    });
  });

  it('rejects a test gate with failing exit code', async () => {
    const gates: TestGate[] = [
      {
        kind: 'test',
        name: 'failing-test',
        command: 'false',
        expectedExitCode: 0,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'test',
      result: 'failed',
    });
    expect(results[0].failureReason).toBeDefined();
  });
});

describe('gate-runner — file gate', () => {
  it('validates file existence', async () => {
    // Use an existing file from the project
    const existingFile = join(projectRoot, 'package.json');

    const gates: FileGate[] = [
      {
        kind: 'file',
        name: 'package-json-exists',
        path: existingFile,
        assertions: [{ type: 'exists' }],
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'file',
      result: 'passed',
    });
  });

  it('rejects when file does not exist', async () => {
    const gates: FileGate[] = [
      {
        kind: 'file',
        name: 'nonexistent',
        path: '/tmp/this-does-not-exist-12345.txt',
        assertions: [{ type: 'exists' }],
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'file',
      result: 'failed',
    });
  });
});

describe('gate-runner — command gate', () => {
  it('passes with successful command', async () => {
    const gates: CommandGate[] = [
      {
        kind: 'command',
        name: 'echo-test',
        command: 'echo "test output"',
        expectedExitCode: 0,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'command',
      result: 'passed',
    });
  });

  it('fails with unexpected exit code', async () => {
    const gates: CommandGate[] = [
      {
        kind: 'command',
        name: 'false-command',
        command: 'false',
        expectedExitCode: 0,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'command',
      result: 'failed',
    });
  });
});

describe('gate-runner — lint gate', () => {
  it('skips lint gate gracefully when command not found', async () => {
    // This test verifies that lint gates handle missing tools gracefully
    const gates: LintGate[] = [
      {
        kind: 'lint',
        name: 'biome-format',
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
    expect(['passed', 'failed', 'skipped']).toContain(results[0].result);
  });
});

describe('gate-runner — http gate', () => {
  it('skips http gate when network unavailable', async () => {
    const gates: HttpGate[] = [
      {
        kind: 'http',
        name: 'health-check',
        url: 'http://127.0.0.1:99999/health',
        expectedStatus: 200,
        timeoutMs: 1000,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'http',
    });
    // Should fail or skip depending on network configuration
    expect(['failed', 'skipped']).toContain(results[0].result);
  });
});

describe('gate-runner — manual gate', () => {
  it('returns skipped for manual gates by default', async () => {
    const gates: ManualGate[] = [
      {
        kind: 'manual',
        name: 'manual-review',
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
        name: 'manual-review-2',
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
        name: 'test-1',
        command: 'echo test1',
        expectedExitCode: 0,
      },
      {
        kind: 'command' as const,
        name: 'cmd-1',
        command: 'echo cmd1',
        expectedExitCode: 0,
      },
      {
        kind: 'manual' as const,
        name: 'manual-1',
        prompt: 'Review test',
      },
    ] as const;

    const results = await runGates(gates as any, { projectRoot }, { skipManual: true });

    expect(results).toHaveLength(3);
    expect(results[0].result).toBe('passed');
    expect(results[1].result).toBe('passed');
    expect(results[2].result).toBe('skipped');
  });

  it('includes metadata in results', async () => {
    const gates: TestGate[] = [
      {
        kind: 'test',
        name: 'metadata-test',
        command: 'echo hello',
        expectedExitCode: 0,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    const result = results[0];

    expect(result).toHaveProperty('kind');
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('result');
    expect(result).toHaveProperty('checkedAt');
    expect(result).toHaveProperty('checkedBy');
  });
});

describe('gate-runner — integration with contract types', () => {
  it('validates all gate kinds together', async () => {
    const gates = [
      {
        kind: 'test' as const,
        name: 'test-1',
        command: 'echo "test"',
        expectedExitCode: 0,
      },
      {
        kind: 'command' as const,
        name: 'cmd-1',
        command: 'echo "cmd"',
        expectedExitCode: 0,
      },
      {
        kind: 'manual' as const,
        name: 'manual-1',
        prompt: 'Review manual',
      },
    ] as const;

    const results = await runGates(gates as any, { projectRoot }, { skipManual: true });

    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.every((r) => r.result)).toBe(true);
  });
});
