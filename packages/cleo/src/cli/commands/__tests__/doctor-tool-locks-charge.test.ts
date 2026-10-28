/**
 * T14116 — `cleo doctor tool-locks` reports what a `cleo run` holder is
 * charged now (`chargedBytes`, lowered to its measured peak after a warm-up)
 * next to its plan (`plannedBytes`), and sums the current charges as
 * `usedBytes`.
 *
 * The ledger and the run registry are mocked, so no ledger file is read.
 *
 * @task T14116
 */

import type { LedgerEntry } from '@cleocode/core/resources/admission-ledger.js';
import type { RunJob } from '@cleocode/core/resources/run-admission.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { GIB, NOW, ENTRY, JOB } = vi.hoisted(() => {
  const GIB = 1024 ** 3;
  const NOW = Date.now();
  const ENTRY: LedgerEntry = {
    id: 'push',
    nonce: 'n',
    pid: process.pid,
    host: 'h',
    startedAt: null,
    label: 'run:scoped-build',
    command: 'git push',
    cwd: '/p',
    footprintBytes: 12 * GIB,
    footprintReason: 'scoped-build plan: runs the pre-push hook',
    chargedBytes: 0.7 * GIB,
    measuredPeakBytes: 0.17 * GIB,
    state: 'admitted',
    enqueuedAtMs: NOW,
    admittedAtMs: NOW,
    heartbeatAtMs: NOW,
    toolGroups: [],
  };
  const JOB: RunJob = {
    id: 'job',
    pid: process.pid,
    runnerStart: 'start',
    childPid: 500,
    childStart: null,
    class: 'scoped-build',
    command: 'git push',
    cwd: '/p',
    startedAtMs: NOW,
    sessionId: 'ses_1',
    pausedAtMs: null,
    pausable: true,
    heartbeatAtMs: NOW,
    measuredRssBytes: 0.15 * GIB,
  };
  return { GIB, NOW, ENTRY, JOB };
});

vi.mock('@cleocode/core/resources/admission-ledger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cleocode/core/resources/admission-ledger.js')>();
  return {
    ...actual,
    readLedger: vi.fn(() => [ENTRY]),
    readForeignEntries: vi.fn(() => []),
    readLedgerBudget: vi.fn(() => null),
    admissionCapacityBytes: vi.fn(() => 48 * GIB),
  };
});

vi.mock('@cleocode/core/resources/run-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/resources/run-admission.js')>()),
  listRunJobs: vi.fn(() => [JOB]),
}));

import { setFormatContext } from '../../format-context.js';
import { doctorToolLocksCommand } from '../doctor-tool-locks.js';

let written: string[];

beforeEach(() => {
  written = [];
  const capture = (chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  setFormatContext({ format: 'json', source: 'default', quiet: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('doctor tool-locks charge fields (T14116)', () => {
  it('reports the lowered charge as chargedBytes and the plan as plannedBytes', async () => {
    const run = doctorToolLocksCommand.run as (ctx: {
      args: Record<string, unknown>;
    }) => Promise<void>;
    await run({ args: { _: [] } });
    const envelope = JSON.parse(written.join('').trim()) as {
      data: {
        usedBytes: number;
        entries: Array<{
          chargedBytes: number;
          plannedBytes: number;
          measuredPeakBytes: number | null;
          run: { chargedBytes: number; plannedBytes: number; measuredRssBytes: number } | null;
        }>;
      };
    };
    const [entry] = envelope.data.entries;
    expect(entry).toMatchObject({
      chargedBytes: 0.7 * GIB,
      plannedBytes: 12 * GIB,
      measuredPeakBytes: 0.17 * GIB,
      run: { chargedBytes: 0.7 * GIB, plannedBytes: 12 * GIB, measuredRssBytes: 0.15 * GIB },
    });
    expect(envelope.data.usedBytes).toBe(0.7 * GIB);
  });
});
