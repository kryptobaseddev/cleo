/**
 * Tests for verifier-runner.ts (T9219 / ADR-070).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backfillAllPendingVerifiers,
  backfillVerifier,
  resolveVerifierScript,
  runVerifier,
} from '../verifier-runner.js';

function makeTmpRoot(): string {
  const root = join(
    tmpdir(),
    `verifier-runner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(root, 'scripts'), { recursive: true });
  return root;
}

describe('resolveVerifierScript', () => {
  it('returns null when no verifier exists', () => {
    const root = makeTmpRoot();
    expect(resolveVerifierScript('T9999', root)).toBeNull();
  });

  it('resolves verify-<lowercase-id>-fu.mjs first', () => {
    const root = makeTmpRoot();
    const path = join(root, 'scripts', 'verify-t9001-fu.mjs');
    writeFileSync(path, '');
    expect(resolveVerifierScript('T9001', root)).toBe(path);
  });

  it('resolves verify-<lowercase-id>.mjs when fu variant missing', () => {
    const root = makeTmpRoot();
    const path = join(root, 'scripts', 'verify-t9002.mjs');
    writeFileSync(path, '');
    expect(resolveVerifierScript('T9002', root)).toBe(path);
  });

  it('resolves lowercase variant', () => {
    const root = makeTmpRoot();
    const path = join(root, 'scripts', 'verify-t9003.mjs');
    writeFileSync(path, '');
    expect(resolveVerifierScript('T9003', root)).toBe(path);
  });
});

describe('runVerifier', () => {
  it('returns exitCode 0 for a passing script', () => {
    const root = makeTmpRoot();
    const scriptPath = join(root, 'scripts', 'verify-pass.mjs');
    writeFileSync(scriptPath, 'process.exit(0);\n');
    const result = runVerifier(scriptPath);
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero exitCode for a failing script', () => {
    const root = makeTmpRoot();
    const scriptPath = join(root, 'scripts', 'verify-fail.mjs');
    writeFileSync(scriptPath, 'process.exit(1);\n');
    const result = runVerifier(scriptPath);
    expect(result.exitCode).toBe(1);
  });

  it('captures stdout from the verifier script', () => {
    const root = makeTmpRoot();
    const scriptPath = join(root, 'scripts', 'verify-stdout.mjs');
    writeFileSync(scriptPath, 'process.stdout.write("hello\\n"); process.exit(0);\n');
    const result = runVerifier(scriptPath);
    expect(result.stdout).toContain('hello');
    expect(result.exitCode).toBe(0);
  });
});

describe('backfillVerifier', () => {
  const makeTask = (id: string) => ({
    id,
    title: `Test Task ${id}`,
    status: 'pending',
    acceptance: ['AC-1: something passes', 'AC-2: another thing passes'],
  });

  it('generates a verifier stub for a task', () => {
    const root = makeTmpRoot();
    const task = makeTask('T9100');
    const result = backfillVerifier(task, root, false);
    expect(result.status).toBe('generated');
    expect(result.path).toBeDefined();
    expect(existsSync(result.path!)).toBe(true);
  });

  it('skips if verifier already exists and force is false', () => {
    const root = makeTmpRoot();
    const task = makeTask('T9101');
    const existingPath = join(root, 'scripts', 'verify-t9101.mjs');
    writeFileSync(existingPath, '// existing');
    const result = backfillVerifier(task, root, false);
    expect(result.status).toBe('skipped');
    expect(result.path).toBe(existingPath);
  });

  it('overwrites if force is true', () => {
    const root = makeTmpRoot();
    const task = makeTask('T9102');
    const existingPath = join(root, 'scripts', 'verify-t9102.mjs');
    writeFileSync(existingPath, '// existing');
    const result = backfillVerifier(task, root, true);
    expect(result.status).toBe('generated');
  });

  it('returns failed status for task with no id', () => {
    const root = makeTmpRoot();
    const result = backfillVerifier({ title: 'no id task' }, root, false);
    expect(result.status).toBe('failed');
  });
});

describe('backfillAllPendingVerifiers', () => {
  const makeTask = (id: string) => ({
    id,
    title: `Task ${id}`,
    status: 'pending',
    acceptance: [`AC-1 for ${id}`],
  });

  it('generates stubs for all tasks lacking verifiers', () => {
    const root = makeTmpRoot();
    const tasks = [makeTask('T9200'), makeTask('T9201'), makeTask('T9202')];
    const summary = backfillAllPendingVerifiers(tasks, root, false);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  it('skips tasks that already have verifiers', () => {
    const root = makeTmpRoot();
    const tasks = [makeTask('T9210'), makeTask('T9211')];
    writeFileSync(join(root, 'scripts', 'verify-t9210.mjs'), '// exists');
    const summary = backfillAllPendingVerifiers(tasks, root, false);
    expect(summary.succeeded).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.results.length).toBe(1);
  });
});
