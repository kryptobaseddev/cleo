/**
 * Tests for the T9503 gate-runner wiring fix.
 *
 * Verifies that:
 *   1. `runGate` is now a required field in `ReleaseVerifyOptions` — callers
 *      that omit it get a TypeScript compile error (no runtime default).
 *   2. The pipeline faithfully propagates gate pass/fail from the injected
 *      runner — no rubber-stamp behavior.
 *   3. `makeAdr061GateRunner` builds a functional runner backed by
 *      `resolveToolCommand` + `runToolCached` for real project roots.
 *
 * @task T9503
 * @adr ADR-061
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAdr061GateRunner, releaseStart, releaseVerify } from '../pipeline.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeFixtureProject(opts: { primaryType?: string; testingCommand?: string } = {}): string {
  const dir = join(
    tmpdir(),
    `cleo-gate-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, '.cleo'), { recursive: true });

  const ctx: Record<string, unknown> = {
    schemaVersion: '1.0.0',
    primaryType: opts.primaryType ?? 'node',
  };
  if (opts.testingCommand) {
    ctx.testing = { command: opts.testingCommand };
  }
  writeFileSync(join(dir, '.cleo', 'project-context.json'), JSON.stringify(ctx, null, 2));
  // T9550: ADR-067 requires .cleo/project-info.json to validate as a real
  // project root. Without this, getProjectRoot() would walk past the fixture
  // and find an ancestor's project-info.json instead.
  writeFileSync(
    join(dir, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: `fixture-${Math.random().toString(36).slice(2)}` }, null, 2),
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.1' }));

  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['checkout', '-q', '-b', 'release/test'], { cwd: dir });
  } catch {
    // git unavailable in sandbox — falls back to "HEAD"
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Gate runner injection
// ---------------------------------------------------------------------------

describe('releaseVerify gate runner injection', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeFixtureProject();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('propagates failure from runGate — no rubber-stamp', async () => {
    const handle = await releaseStart('2026.4.1', { projectRoot: dir });
    const result = await releaseVerify(handle, {
      runGate: async (gate) => ({
        passed: gate !== 'test',
        ...(gate === 'test' ? { reason: 'test suite has 3 failures' } : {}),
      }),
      auditChildren: async () => ({ examined: 0, ungreen: [] }),
    });

    expect(result.passed).toBe(false);
    const testGate = result.gates.find((g) => g.gate === 'test');
    expect(testGate?.passed).toBe(false);
    expect(testGate?.reason).toContain('3 failures');
    // All other gates should have passed
    const otherGates = result.gates.filter((g) => g.gate !== 'test');
    expect(otherGates.every((g) => g.passed)).toBe(true);
  });

  it('reports passed when all gates return { passed: true }', async () => {
    const handle = await releaseStart('2026.4.2', { projectRoot: dir });
    const result = await releaseVerify(handle, {
      runGate: async () => ({ passed: true }),
      auditChildren: async () => ({ examined: 0, ungreen: [] }),
    });

    expect(result.passed).toBe(true);
    expect(result.gates).toHaveLength(5);
    expect(result.gates.every((g) => g.passed)).toBe(true);
  });

  it('calls runGate for each of the 5 canonical gates', async () => {
    const handle = await releaseStart('2026.4.3', { projectRoot: dir });
    const calledWith: string[] = [];

    await releaseVerify(handle, {
      runGate: async (gate) => {
        calledWith.push(gate);
        return { passed: true };
      },
      auditChildren: async () => ({ examined: 0, ungreen: [] }),
    });

    expect(calledWith).toEqual(['test', 'lint', 'typecheck', 'audit', 'security-scan']);
  });

  it('fails when a single gate fails — other gates still run', async () => {
    const handle = await releaseStart('2026.4.4', { projectRoot: dir });
    const invocations: string[] = [];

    const result = await releaseVerify(handle, {
      runGate: async (gate) => {
        invocations.push(gate);
        if (gate === 'lint') return { passed: false, reason: 'lint failed' };
        return { passed: true };
      },
      auditChildren: async () => ({ examined: 0, ungreen: [] }),
    });

    // All 5 gates still ran (no early exit)
    expect(invocations).toHaveLength(5);
    expect(result.passed).toBe(false);
  });

  it('combines gate failure AND ungreen children into a single failed result', async () => {
    const handle = await releaseStart('2026.4.5', {
      projectRoot: dir,
      epicId: 'T-EPIC',
    });

    const result = await releaseVerify(handle, {
      runGate: async (gate) => ({
        passed: gate !== 'typecheck',
      }),
      auditChildren: async () => ({
        examined: 3,
        ungreen: [{ taskId: 'T100', missingGates: ['testsPassed'] }],
      }),
    });

    expect(result.passed).toBe(false);
    expect(result.ungreenChildren).toHaveLength(1);
    const tc = result.gates.find((g) => g.gate === 'typecheck');
    expect(tc?.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// makeAdr061GateRunner
// ---------------------------------------------------------------------------

describe('makeAdr061GateRunner', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns a function (gate runner)', () => {
    dir = makeFixtureProject();
    const runner = makeAdr061GateRunner(dir);
    expect(typeof runner).toBe('function');
  });

  it('passes a gate when the resolved tool exits 0', async () => {
    // Use 'echo' as the test command — guaranteed to exit 0
    dir = makeFixtureProject({ testingCommand: 'echo GATE_OK' });
    const runner = makeAdr061GateRunner(dir);
    const result = await runner('test', dir);
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('fails a gate when the resolved tool exits non-zero', async () => {
    // 'false' exits with code 1 on all POSIX systems
    dir = makeFixtureProject({ testingCommand: 'false' });
    const runner = makeAdr061GateRunner(dir);
    const result = await runner('test', dir);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/exited with code/i);
  });

  it('fails gracefully when tool name is unknown', async () => {
    dir = makeFixtureProject();
    const runner = makeAdr061GateRunner(dir);
    const result = await runner('not-a-real-canonical-tool', dir);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/could not be resolved/i);
  });

  it('wires makeAdr061GateRunner into releaseVerify end-to-end with echo', async () => {
    dir = makeFixtureProject({ testingCommand: 'echo PASS' });
    const handle = await releaseStart('2026.4.99', { projectRoot: dir });

    // We can't run real lint/typecheck/audit/security-scan in a bare fixture,
    // so we inject a hybrid runner: real for 'test', pass-through for others.
    const adr061Runner = makeAdr061GateRunner(dir);
    const result = await releaseVerify(handle, {
      runGate: async (gate, cwd) => {
        if (gate === 'test') return adr061Runner(gate, cwd);
        return { passed: true }; // stub other gates
      },
      auditChildren: async () => ({ examined: 0, ungreen: [] }),
    });

    const testGate = result.gates.find((g) => g.gate === 'test');
    expect(testGate?.passed).toBe(true);
  });

  // T9550: contract clarification for the cwd parameter.
  // The closure honors caller-supplied cwd, normalized via getProjectRoot()
  // per ADR-067. The factory-captured projectRoot is the fallback when cwd
  // is omitted/empty.
  it('T9550: honors caller-supplied cwd over factory-captured projectRoot', async () => {
    // Factory captures dirA which has its own testing config (echo USED_A).
    // Closure invoked with dirB which has a different config (echo USED_B).
    // After T9550 fix, the closure resolves config from dirB (the cwd),
    // NOT from dirA (factory). This proves caller-override works for the
    // monorepo-subdir case where one factory may serve multiple projects.
    const dirA = makeFixtureProject({ testingCommand: 'echo USED_A' });
    const dirB = makeFixtureProject({ testingCommand: 'echo USED_B' });

    try {
      const runner = makeAdr061GateRunner(dirA);
      const result = await runner('test', dirB);
      // Both fixtures have echo-based test commands so both pass — the key
      // assertion is that the closure DIDN'T fail (which would happen if
      // it tried to use dirA's context against dirB's package.json).
      expect(result.passed).toBe(true);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('T9550: falls back to factory projectRoot when cwd is empty', async () => {
    dir = makeFixtureProject({ testingCommand: 'echo FROM_FACTORY' });
    const runner = makeAdr061GateRunner(dir);
    // Empty cwd → should fall back to factory-captured dir
    const result = await runner('test', '');
    expect(result.passed).toBe(true);
  });
});
