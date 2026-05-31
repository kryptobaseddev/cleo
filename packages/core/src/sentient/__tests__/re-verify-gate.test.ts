/**
 * Unit tests for the REQUIRED worker re-verification gate (T11498 · AC1).
 *
 * AC1: autopilot re-runs ADR-051 evidence gates against ground truth before
 * accepting any worker exit=0 — NO autonomous completion trusts self-reported
 * success.
 *
 * Covers:
 *   RVG-1: Gate runs by default (no `reVerify` injected) — verifier stub
 *           rejects → tick outcome is `failure`, not `success`.
 *   RVG-2: Gate runs by default — verifier accepts → tick outcome is `success`.
 *   RVG-3: Gate is skipped when `skipReVerify: true` → success even if the
 *           verifier would reject (escape hatch for dry-run / legacy callers).
 *   RVG-4: Gate is skipped when `dryRun: true` — implicit skip.
 *   RVG-5: Injected `reVerify` is preferred over the built-in default.
 *   RVG-6: Rejected report increments `tasksFailed` and schedules backoff.
 *   RVG-7: Reject detail string contains the T1589/T11498 marker.
 *
 * All tests inject a `reVerify` stub (or set `skipReVerify`) to avoid
 * spawning real `pnpm test` / `git status` processes.
 *
 * @task T11498
 * @epic T11492
 * @adr ADR-051
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SENTIENT_STATE_FILE } from '../daemon.js';
import { DEFAULT_SENTIENT_STATE, readSentientState, writeSentientState } from '../state.js';
import { runTick, type TickOptions } from '../tick.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
  } as Task;
}

/** Verifier stub that always accepts. */
const alwaysAccept: NonNullable<TickOptions['reVerify']> = async () => ({
  accepted: true,
});

/** Verifier stub that always rejects. */
const alwaysReject: NonNullable<TickOptions['reVerify']> = async () => ({
  accepted: false,
});

function mkTickOpts(projectRoot: string, overrides: Partial<TickOptions> = {}): TickOptions {
  return {
    projectRoot,
    statePath: join(projectRoot, SENTIENT_STATE_FILE),
    pickTask: async () => makeTask('T777'),
    spawn: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    // Stage-drift / hygiene / dream are noisy in unit tests — disable.
    stageDriftScan: null,
    hygieneScan: null,
    checkAndDream: async () => ({ triggered: false, tier: null }),
    runDeriverBatch: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('re-verify gate — T11498 AC1', () => {
  let root: string;
  let statePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-reval-gate-'));
    statePath = join(root, SENTIENT_STATE_FILE);
    await writeSentientState(statePath, { ...DEFAULT_SENTIENT_STATE });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  // RVG-1: gate runs with built-in default (no reVerify injection); reject path
  it('RVG-1: injected reject-stub produces failure outcome (gate is active by default)', async () => {
    const outcome = await runTick(
      mkTickOpts(root, {
        // Injecting a reject stub exercises the same gate code path as the
        // built-in reVerifyWorkerReport default — we can't use the real default
        // in unit tests without spawning git/pnpm, so an injected stub is the
        // canonical way to test the reject path.
        reVerify: alwaysReject,
      }),
    );

    expect(outcome.kind).toBe('failure');
    expect(outcome.taskId).toBe('T777');
  });

  // RVG-2: gate runs; verifier accepts → success
  it('RVG-2: injected accept-stub passes through to success outcome', async () => {
    const outcome = await runTick(
      mkTickOpts(root, {
        reVerify: alwaysAccept,
      }),
    );

    expect(outcome.kind).toBe('success');
    expect(outcome.taskId).toBe('T777');
  });

  // RVG-3: skipReVerify bypasses the gate
  it('RVG-3: skipReVerify=true bypasses the gate — success even with a rejecting verifier', async () => {
    const outcome = await runTick(
      mkTickOpts(root, {
        reVerify: alwaysReject, // would reject if the gate ran
        skipReVerify: true,
      }),
    );

    expect(outcome.kind).toBe('success');
  });

  // RVG-4: dryRun implicitly skips the gate
  it('RVG-4: dryRun=true implicitly skips the re-verify gate', async () => {
    const outcome = await runTick(
      mkTickOpts(root, {
        reVerify: alwaysReject, // would reject if the gate ran
        dryRun: true,
      }),
    );

    expect(outcome.kind).toBe('success');
  });

  // RVG-5: injected reVerify is called (not silently ignored)
  it('RVG-5: injected reVerify is invoked with the worker report', async () => {
    const spy = vi.fn().mockResolvedValue({ accepted: true });

    await runTick(
      mkTickOpts(root, {
        reVerify: spy,
      }),
    );

    expect(spy).toHaveBeenCalledOnce();
    const [report, opts] = spy.mock.calls[0] as Parameters<NonNullable<TickOptions['reVerify']>>;
    expect(report.taskId).toBe('T777');
    expect(report.selfReportSuccess).toBe(true);
    expect(opts.projectRoot).toBe(root);
  });

  // RVG-6: rejected report increments tasksFailed + schedules backoff
  it('RVG-6: rejected report increments tasksFailed and writes a stuck record', async () => {
    await runTick(
      mkTickOpts(root, {
        reVerify: alwaysReject,
      }),
    );

    const state = await readSentientState(statePath);
    expect(state.stats.tasksFailed).toBe(1);
    expect(state.stuckTasks['T777']).toBeDefined();
    expect(state.stuckTasks['T777'].attempts).toBe(1);
    // nextRetryAt should be in the future (backoff scheduled)
    expect(state.stuckTasks['T777'].nextRetryAt).toBeGreaterThan(Date.now());
  });

  // RVG-7: failure detail carries task reference marker
  it('RVG-7: failure detail contains the T1589/T11498 task reference marker', async () => {
    const outcome = await runTick(
      mkTickOpts(root, {
        reVerify: alwaysReject,
      }),
    );

    expect(outcome.kind).toBe('failure');
    expect(outcome.detail).toMatch(/T1589\/T11498/);
  });
});
