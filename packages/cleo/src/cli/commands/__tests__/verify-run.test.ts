/**
 * `cleo verify <id> --run` — the typed-gate runner, restored (gh#1468).
 *
 * ## The defect
 *
 * Typed acceptance gates had exactly one execution path: a side effect of
 * `cleo verify <id> --gate <g> --evidence <atoms>`. Every typed gate on the
 * task ran during a call whose stated purpose was to ATTEST a different gate,
 * so the only way to find out whether the gates would pass was to record an
 * attestation.
 *
 * The explicit driver had been documented since T768 (`cleo verify --run`
 * executes gates via `runGates()`) and is still written into every
 * validation-stage spawn prompt — but the flag had been dropped from the
 * command, so the instruction CLEO itself emits produced `Unknown flag`.
 *
 * ## What these tests pin
 *
 * 1. The flag exists and is a boolean.
 * 2. It routes to `check.gate.run` on the QUERY gateway — it observes, and
 *    only `--evidence` attests.
 * 3. It does not disturb the existing routing of `--explain`, the bare read,
 *    or any write flag.
 * 4. Combining it with a write is REJECTED rather than silently ignored,
 *    because the gates already run during a write and the reader would have no
 *    way to tell an observed result from an attested one.
 *
 * @task gh#1468
 */

import { ExitCode } from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Gateway } from '../../../dispatch/types.js';
import { verifyCommand } from '../verify.js';

/** Capture what `verifyCommand.run` dispatches, exactly as verify-explain does. */
async function runVerifyCommand(cliArgs: Record<string, unknown>): Promise<{
  gateway: Gateway;
  domain: string;
  operation: string;
  params: Record<string, unknown>;
} | null> {
  let captured: {
    gateway: Gateway;
    domain: string;
    operation: string;
    params: Record<string, unknown>;
  } | null = null;

  const adapter = await import('../../../dispatch/adapters/cli.js');
  const spy = vi
    .spyOn(adapter, 'dispatchFromCli')
    .mockImplementation(async (gateway, domain, operation, params) => {
      captured = {
        gateway: gateway as Gateway,
        domain: domain as string,
        operation: operation as string,
        params: params as Record<string, unknown>,
      };
      return {
        meta: { gateway, domain, operation, startTime: 0, durationMs: 0 } as never,
        success: true,
        data: {},
      };
    });

  try {
    await verifyCommand.run?.({
      args: cliArgs as never,
      cmd: verifyCommand as never,
      rawArgs: [] as never,
    } as never);
  } finally {
    spy.mockRestore();
  }
  return captured;
}

describe('verifyCommand exposes --run (gh#1468)', () => {
  it('declares --run as a boolean flag', () => {
    const runArg = verifyCommand.args?.run;
    expect(runArg).toBeDefined();
    expect(runArg?.type).toBe('boolean');
  });

  it('says in its own description that it records nothing', () => {
    // The distinction this flag exists to draw has to survive `--help`, which
    // is the only place most callers will ever read it.
    expect(verifyCommand.args?.run?.description).toMatch(/read-only|nothing is recorded/i);
  });
});

describe('--run routes to the read-only typed-gate runner (gh#1468)', () => {
  it('dispatches check.gate.run on the query gateway', async () => {
    const captured = await runVerifyCommand({ taskId: 'T489', run: true, value: 'true' });
    expect(captured?.gateway).toBe('query');
    expect(captured?.domain).toBe('check');
    expect(captured?.operation).toBe('gate.run');
    expect(captured?.params.taskId).toBe('T489');
  });

  it('leaves the bare read on gate.status', async () => {
    const captured = await runVerifyCommand({ taskId: 'T489', value: 'true' });
    expect(captured?.operation).toBe('gate.status');
  });

  it('leaves --explain on verify.explain', async () => {
    const captured = await runVerifyCommand({ taskId: 'T489', explain: true, value: 'true' });
    expect(captured?.operation).toBe('verify.explain');
  });
});

describe('--run cannot be combined with a write (gh#1468)', () => {
  it.each([
    ['--gate', { gate: 'implemented', evidence: 'note:x' }],
    ['--all', { all: true }],
    ['--reset', { reset: true }],
  ])('rejects %s rather than silently dropping one of the two', async (_label, write) => {
    // The refusal travels as a LAFS envelope on stdout, like every other
    // outcome (ADR-086). It used to be a raw `process.stderr.write`, which
    // handed a machine consumer an exit code and nothing parseable — the
    // JSON-stream-hygiene gate caught that line before it shipped.
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const originalExitCode = process.exitCode;
    try {
      const captured = await runVerifyCommand({
        taskId: 'T489',
        run: true,
        value: 'true',
        ...write,
      });
      // Nothing dispatched: neither the observation nor the attestation ran.
      expect(captured).toBeNull();
      // 6 is E_VALIDATION in the documented exit-code table, not a bare 1.
      expect(process.exitCode).toBe(ExitCode.VALIDATION_ERROR);

      const written = [...stdout.mock.calls, ...stderr.mock.calls]
        .map((c) => String(c[0]))
        .join('');
      expect(written).toContain('--run');
      // The refusal must name the two-step recovery, not just say no.
      expect(written).toContain('--evidence');

      // And it must be ONE parseable envelope, not prose.
      const envelope = JSON.parse(written.trim().split('\n').pop() as string);
      expect(envelope.success).toBe(false);
      expect(envelope.error.codeName).toBe('E_VALIDATION');
    } finally {
      process.exitCode = originalExitCode;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
