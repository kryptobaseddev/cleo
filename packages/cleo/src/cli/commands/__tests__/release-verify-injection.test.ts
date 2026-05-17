/**
 * Tests for the CLI `release verify` command — gate-runner injection (T9503).
 *
 * Verifies that the CLI `verifyCommand` passes a real ADR-061-based gate
 * runner to `releaseVerify` so gates actually execute and drive pass/fail.
 *
 * Strategy:
 *   - Set up a tmp project with `.cleo/project-context.json` declaring a
 *     `testing.command` that exits non-zero (simulates a real test failure).
 *   - Invoke `releaseVerify` with the `makeAdr061GateRunner` runner (same
 *     code path as the CLI command).
 *   - Assert the result has `passed: false` and the `test` gate shows a
 *     real failure reason (exit-code based, not "runner not configured").
 *
 * @task T9503
 * @adr ADR-061
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  makeAdr061GateRunner,
  releaseStart,
  releaseVerify,
} from '../../../../../core/src/release/pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal fixture project with a `.cleo/project-context.json` that
 * configures a given `testing.command`.  All other gates are left as language
 * defaults so the test only needs to care about `test`.
 */
function makeProject(opts: { testingCommand: string }): string {
  const dir = join(
    tmpdir(),
    `cleo-cli-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, '.cleo'), { recursive: true });

  writeFileSync(
    join(dir, '.cleo', 'project-context.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      primaryType: 'node',
      testing: { command: opts.testingCommand },
    }),
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'verify-fixture', version: '0.0.1' }),
  );

  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['checkout', '-q', '-b', 'release/verify-test'], { cwd: dir });
  } catch {
    // git unavailable — falls back to "HEAD"
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('CLI verify — ADR-061 gate-runner injection', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('produces a real exit-code failure when testing.command exits non-zero', async () => {
    dir = makeProject({ testingCommand: 'false' });
    const handle = await releaseStart('2026.4.1', { projectRoot: dir });

    const runner = makeAdr061GateRunner(dir);
    const result = await releaseVerify(handle, {
      runGate: async (gate, cwd) => {
        if (gate === 'test') return runner(gate, cwd);
        return { passed: true }; // other gates pass
      },
      skipChildAudit: true,
    });

    // The test gate must fail with a real exit-code reason — not theater.
    expect(result.passed).toBe(false);
    const testGate = result.gates.find((g) => g.gate === 'test');
    expect(testGate?.passed).toBe(false);
    expect(testGate?.reason).toMatch(/exited with code/i);
    // MUST NOT contain the old theater string.
    expect(testGate?.reason).not.toContain('runner not configured');
  });

  it('produces passed=true when testing.command exits 0', async () => {
    dir = makeProject({ testingCommand: 'echo ALL_TESTS_PASS' });
    const handle = await releaseStart('2026.4.2', { projectRoot: dir });

    const runner = makeAdr061GateRunner(dir);
    const result = await releaseVerify(handle, {
      runGate: async (gate, cwd) => {
        if (gate === 'test') return runner(gate, cwd);
        return { passed: true };
      },
      skipChildAudit: true,
    });

    const testGate = result.gates.find((g) => g.gate === 'test');
    expect(testGate?.passed).toBe(true);
  });

  it('runner resolves tool from project-context — not a hardcoded command', async () => {
    // Confirm the runner reads testing.command from project-context.
    // Use a unique marker so we know the exact command was used.
    dir = makeProject({ testingCommand: 'echo UNIQUE_MARKER_FOR_TESTING' });
    const runner = makeAdr061GateRunner(dir);
    const result = await runner('test', dir);
    // exit 0 means the resolved command (echo ...) actually ran
    expect(result.passed).toBe(true);
  });

  it('runner falls back to language defaults when project-context is absent', async () => {
    // Create a project without project-context.json
    dir = join(tmpdir(), `cleo-no-ctx-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'no-ctx', version: '0.0.1' }));

    const runner = makeAdr061GateRunner(dir);
    // Resolving should not throw — should fall back to npm test
    const result = await runner('test', dir);
    // npm test will fail in a bare fixture (no scripts), but the runner must
    // attempt execution (exit code non-null) rather than erroring out.
    // We just verify it doesn't contain the "runner not configured" theater string.
    expect(result.reason ?? '').not.toContain('runner not configured');
  });
});
