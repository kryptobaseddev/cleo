/**
 * Tests for T9538 — `cleo release ship` deprecation shim (SPEC-T9345 §12 R-420).
 *
 * Updated by T9772 (JSON stream hygiene): the deprecation notice now ships
 * through `meta.warnings[]` via `pushWarning(...)` instead of raw stderr, so
 * JSON consumers parsing stdout see the deprecation without losing parseability
 * of the dispatch envelope. The exported `SHIP_DEPRECATION_NOTICE` string is
 * still asserted in full (constant contents unchanged).
 *
 * Verifies that the deprecated `ship` verb:
 *   1. Pushes a `W_DEPRECATED_COMMAND` warning carrying SHIP_DEPRECATION_NOTICE
 *      into the LAFS envelope (not stderr) on every invocation.
 *   2. Default path: forwards to `release.plan` then `release.open` via
 *      dispatch.
 *   3. Dry-run forwards plan but skips open (preview semantics).
 *   4. The exported notice constant is a non-empty string for downstream
 *      assertions.
 *
 * Note: the `--workflow=false` escape hatch was removed in T9540 (Phase 6 of
 * T9499) along with the legacy `releaseShip` monolith. Tests covering that
 * escape hatch were dropped here when the flag itself was deleted.
 *
 * Strategy:
 *   - Mock `dispatchFromCli` so we observe operation names + params without
 *     spawning a real release.
 *   - Mock `pushWarning` so we can assert the deprecation warning is queued
 *     for the next envelope.
 *   - Capture `process.stderr.write` to confirm NO stderr writes occur on
 *     the ship path (T9772 hygiene guarantee).
 *
 * @task T9538
 * @task T9540 — removed `--workflow=false` + audit hook
 * @task T9772 — deprecation now goes through `pushWarning`, not stderr
 * @epic T9498
 * @spec SPEC-T9345 §12 R-420 / R-440 / R-441
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE importing the command under test
// ---------------------------------------------------------------------------

const mockDispatchFromCli = vi.fn();
const mockAppendBypass = vi.fn();
const mockPushWarning = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
}));

vi.mock('@cleocode/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cleocode/core')>();
  return {
    ...original,
    pushWarning: (...args: unknown[]) => mockPushWarning(...args),
    release: {
      ...original.release,
      appendReleaseWorkflowBypass: (...args: unknown[]) => mockAppendBypass(...args),
    },
  };
});

// ---------------------------------------------------------------------------
// Import command + notice constant after mocks are registered
// ---------------------------------------------------------------------------

import { releaseCommand, SHIP_DEPRECATION_NOTICE } from '../release.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ShipArgs {
  version: string;
  epic: string;
  'dry-run'?: boolean;
}

/**
 * Invoke the `ship` subcommand `run` with structured args. Looks the
 * subcommand up by name so the test mirrors the citty dispatch path used by
 * the real CLI.
 */
async function invokeShip(args: ShipArgs): Promise<void> {
  const sub = (
    releaseCommand as unknown as {
      subCommands: Record<string, { run: (ctx: { args: ShipArgs }) => Promise<void> }>;
    }
  ).subCommands.ship;
  if (!sub || typeof sub.run !== 'function') {
    throw new Error('ship subcommand not found on releaseCommand');
  }
  await sub.run({ args });
}

/** Capture writes to process.stderr.write during a single test. */
function captureStderr(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  return {
    writes,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('cleo release ship — T9538 deprecation shim', () => {
  beforeEach(() => {
    mockDispatchFromCli.mockReset();
    mockDispatchFromCli.mockResolvedValue({ success: true, data: {}, _meta: {} });
    mockAppendBypass.mockReset();
    mockPushWarning.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports SHIP_DEPRECATION_NOTICE with replacement guidance and removal hint', () => {
    expect(SHIP_DEPRECATION_NOTICE).toEqual(expect.any(String));
    expect(SHIP_DEPRECATION_NOTICE.length).toBeGreaterThan(0);
    // R-431: notice MUST include the replacement invocation.
    expect(SHIP_DEPRECATION_NOTICE).toContain('cleo release plan');
    expect(SHIP_DEPRECATION_NOTICE).toContain('cleo release open');
    // R-431: notice MUST mention a removal milestone.
    expect(SHIP_DEPRECATION_NOTICE.toLowerCase()).toContain('deprecated');
  });

  it('queues the deprecation warning via pushWarning (envelope, not stderr) on every invocation', async () => {
    const cap = captureStderr();
    try {
      await invokeShip({ version: '2026.6.0', epic: 'T9498' });
    } finally {
      cap.restore();
    }
    // T9772: notice MUST surface through the LAFS envelope, NOT stderr.
    expect(cap.writes.join('')).toBe('');
    expect(mockPushWarning).toHaveBeenCalledTimes(1);
    const warn = mockPushWarning.mock.calls[0]?.[0] as {
      code: string;
      message: string;
      deprecated?: string;
      replacement?: string;
    };
    expect(warn.code).toBe('W_DEPRECATED_COMMAND');
    expect(warn.message).toBe(SHIP_DEPRECATION_NOTICE);
    expect(warn.deprecated).toBe('cleo release ship');
    expect(warn.replacement).toContain('cleo release plan');
    expect(warn.replacement).toContain('cleo release open');
  });

  it('default path forwards to release.plan then release.open', async () => {
    const cap = captureStderr();
    try {
      await invokeShip({ version: '2026.6.0', epic: 'T9498' });
    } finally {
      cap.restore();
    }

    // Two dispatches total: plan + open.
    expect(mockDispatchFromCli).toHaveBeenCalledTimes(2);

    const [firstCall, secondCall] = mockDispatchFromCli.mock.calls;
    // Call 1: release.plan with version + epicId.
    expect(firstCall?.[0]).toBe('mutate');
    expect(firstCall?.[1]).toBe('release');
    expect(firstCall?.[2]).toBe('plan');
    expect(firstCall?.[3]).toMatchObject({
      version: '2026.6.0',
      epicId: 'T9498',
      dryRun: false,
    });

    // Call 2: release.open with version.
    expect(secondCall?.[0]).toBe('mutate');
    expect(secondCall?.[1]).toBe('release');
    expect(secondCall?.[2]).toBe('open');
    expect(secondCall?.[3]).toMatchObject({ version: '2026.6.0' });

    // T9540: bypass audit hook removed — legacy `--workflow=false` no longer exists.
    expect(mockAppendBypass).not.toHaveBeenCalled();
  });

  it('dry-run forwards release.plan but skips release.open (preview semantics)', async () => {
    const cap = captureStderr();
    try {
      await invokeShip({ version: '2026.6.0', epic: 'T9498', 'dry-run': true });
    } finally {
      cap.restore();
    }

    expect(mockDispatchFromCli).toHaveBeenCalledTimes(1);
    const call = mockDispatchFromCli.mock.calls[0];
    expect(call?.[2]).toBe('plan');
    expect(call?.[3]).toMatchObject({ dryRun: true });
    expect(mockAppendBypass).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// release command — 4-verb surface ordering (T9538 / R-420)
// ---------------------------------------------------------------------------

describe('cleo release — subcommand surface ordering (T9538)', () => {
  it('lists the new 4-verb pipeline first in subCommands declaration order', () => {
    const subKeys = Object.keys(
      (releaseCommand as unknown as { subCommands: Record<string, unknown> }).subCommands,
    );
    // The first four entries MUST be the canonical SPEC-T9345 verbs in order.
    expect(subKeys.slice(0, 4)).toEqual(['plan', 'open', 'reconcile', 'rollback']);
  });

  it('keeps deprecated verbs registered (compatibility window not removed yet)', () => {
    const subs = (releaseCommand as unknown as { subCommands: Record<string, unknown> })
      .subCommands;
    // R-420 → R-423: each deprecated verb MUST still resolve.
    expect(subs.ship).toBeDefined();
    expect(subs.start).toBeDefined();
    expect(subs.verify).toBeDefined();
    expect(subs.publish).toBeDefined();
  });

  it('exposes a description that marks ship/start/verify/publish as deprecated', () => {
    const description = (releaseCommand as unknown as { meta: { description: string } }).meta
      .description;
    expect(description.toLowerCase()).toContain('deprecated');
    expect(description.toLowerCase()).toContain('plan');
    expect(description.toLowerCase()).toContain('open');
  });
});
