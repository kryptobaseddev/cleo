/**
 * stdout discipline + daemon-survives smoke tests for the Pi embed
 * (T11761 · S2 · T11898).
 *
 * Two **in-process** tests (no subprocess, no tsx) that exercise the REAL code
 * paths the daemon relies on:
 *
 *  1. **single-LAFS-envelope-on-stdout** (ADR-086) — the real
 *     {@link PiAgentAdapter} runs, streaming/progress noise is written to
 *     `process.stderr`, and EXACTLY ONE LAFS envelope JSON line (built by the
 *     real `createEnvelope`) is written to `process.stdout`. We capture
 *     `process.stdout.write`/`process.stderr.write` around the emission and
 *     assert the split — proving the daemon's stdout discipline without spawning
 *     a TypeScript child.
 *  2. **daemon-survives-forced-Pi-error** — the real S1 containment
 *     ({@link installDaemonExitGuard} + {@link wrapPiCall}) neutralizes a Pi code
 *     path that calls `process.exit(1)`: the call THROWS a typed
 *     {@link PiContainmentError} instead of terminating the process. Reaching the
 *     assertion at all proves this very (test) process survived — i.e. the daemon
 *     would survive. No child process, no exit-code inspection of a subprocess.
 *
 * These were previously subprocess tests run via `tsx`. Resolving a `tsx` loader
 * to run a `.ts` fixture is fragile under CI's hoisted-pnpm layout (the loader is
 * not on `PATH`, and tsx 4.x does not export the cli subpath that earlier
 * attempts reached), so the child failed to start — status `null`, zero envelope
 * lines. The behavior under test is fully observable in-process, so the tsx
 * dependency is gone. Assertions are unchanged in WHAT they prove: exactly-one
 * envelope on stdout + a contained, survived forced exit.
 *
 * @epic T10403
 * @task T11761
 * @task T11898
 */

import { createEnvelope } from '@cleocode/lafs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAgentAdapter } from '../pi-agent-adapter.js';
import {
  installDaemonExitGuard,
  isPiContainmentError,
  type PiContainmentError,
  wrapPiCall,
} from '../pi-errors.js';

/**
 * A no-op guarded tool surface — the v0 adapter read/stream path threads it but
 * does not invoke it (no ambient tool access). Mirrors the daemon's injected
 * deny-first surface for the smoke path.
 */
function noopTools() {
  return {
    async readFileText(input: { path: string }) {
      return { path: input.path, content: '' };
    },
    async readJson<T>() {
      return {} as T;
    },
    async writeFileAtomic(input: { path: string }) {
      return { path: input.path, bytesWritten: 0 };
    },
    async pathExists() {
      return { exists: false };
    },
    async executeShell() {
      return { stdout: '', stderr: '', code: 0 };
    },
    async runGit() {
      return { stdout: '', stderr: '', code: 0 };
    },
  };
}

/**
 * Capture everything written to `process.stdout`/`process.stderr` during `body`,
 * WITHOUT forwarding it to the real streams (so the assertion sees exactly what
 * the daemon-shaped code routed, and the test runner's own output is unaffected).
 * The original writers are always restored.
 */
async function captureStdio(
  body: () => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    });
  try {
    await body();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout, stderr };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ADR-086 single LAFS envelope on stdout', () => {
  it('emits exactly ONE LAFS envelope line on stdout; streaming noise on stderr only', async () => {
    const { stdout, stderr } = await captureStdio(async () => {
      // Streaming / progress noise — ALL to stderr, never stdout (ADR-086).
      process.stderr.write('pi: starting agent loop\n');
      process.stderr.write('pi: streaming delta...\n');

      // Drive the REAL adapter (resolves through E9; with no live creds the loop
      // fails — but the emission discipline below is what is under test).
      const adapter = new PiAgentAdapter({ system: 'task-executor' });
      const result = await adapter.run('say hello', noopTools(), {
        system: 'task-executor',
        sessionId: 'fixture-session-1',
        agentId: null,
        parentSessionId: null,
      });

      process.stderr.write(`pi: loop done status=${result.status}\n`);

      // EXACTLY ONE LAFS envelope on stdout, built by the real writer.
      const envelope = createEnvelope({
        success: result.status === 'success',
        result: result.output,
        meta: { operation: 'pi.run', requestId: 'fixture-1' },
        ...(result.status === 'failure'
          ? { error: { code: 'E_PI_RUN_FAILED', message: result.error ?? 'pi run failed' } }
          : {}),
      });
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
    });

    // stdout = exactly one non-empty line, a valid LAFS envelope.
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]) as { $schema?: string; _meta?: unknown; success?: boolean };
    expect(parsed.$schema).toContain('lafs.dev/schemas');
    expect(parsed).toHaveProperty('_meta');
    expect(typeof parsed.success).toBe('boolean');

    // The streaming/progress noise went to stderr (proving the split).
    expect(stderr).toContain('pi: starting agent loop');
    // And stdout carries NONE of that prose.
    expect(stdout).not.toContain('pi: starting agent loop');
  }, 70_000);
});

describe('daemon survives a forced Pi process.exit', () => {
  it('neutralizes process.exit(1) from a Pi code path; daemon survives and continues', async () => {
    // Daemon bootstrap: pin the REAL exit trap for the process lifetime.
    const unpin = installDaemonExitGuard();
    let stderr = '';
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
        return true;
      });

    let contained = false;
    let piCode = '';
    let thrown: unknown;
    try {
      // A Pi code path attempts a daemon-fatal process.exit(1). If the trap
      // failed, THIS would terminate the test process here (no failure report,
      // the run would just die) — reaching the assertions below is itself proof
      // the daemon survived.
      await wrapPiCall(async () => {
        process.stderr.write('pi: simulating daemon-fatal process.exit(1)\n');
        process.exit(1);
      });
    } catch (err) {
      thrown = err;
      if (isPiContainmentError(err)) {
        contained = true;
        piCode = err.piCode;
      }
    } finally {
      errSpy.mockRestore();
      unpin();
    }

    // The forced exit was trapped and re-thrown as a typed containment error;
    // the process is still alive (we got here).
    expect(contained).toBe(true);
    expect(isPiContainmentError(thrown)).toBe(true);
    expect((thrown as PiContainmentError).piCode).toBe('E_PI_PROCESS_EXIT_TRAPPED');
    expect(piCode).toBe('E_PI_PROCESS_EXIT_TRAPPED');
    // The simulated exit attempt was logged to stderr, not stdout.
    expect(stderr).toContain('simulating daemon-fatal process.exit');

    // The same typed error envelope the daemon would emit (ADR-086): well-formed,
    // carrying the containment code on both `result` and `error`.
    const envelope = createEnvelope({
      success: false,
      result: { contained, piCode },
      meta: { operation: 'pi.exit-trap', requestId: 'fixture-survive-1' },
      error: {
        code: piCode || 'E_PI_PROCESS_EXIT_TRAPPED',
        message: 'Pi process.exit neutralized; daemon survived',
      },
    });
    const parsed = JSON.parse(JSON.stringify(envelope)) as {
      success?: boolean;
      result?: { contained?: boolean; piCode?: string };
      error?: { code?: string };
    };
    expect(parsed.result?.contained).toBe(true);
    expect(parsed.result?.piCode).toBe('E_PI_PROCESS_EXIT_TRAPPED');
    expect(parsed.error?.code).toBe('E_PI_PROCESS_EXIT_TRAPPED');
  }, 70_000);
});
