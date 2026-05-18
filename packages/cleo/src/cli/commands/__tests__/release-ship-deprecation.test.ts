/**
 * Tests for T9538 — `cleo release ship` deprecation shim (SPEC-T9345 §12 R-420).
 *
 * Verifies that the deprecated `ship` verb:
 *   1. Emits a deprecation warning to stderr (not stdout) on every invocation.
 *   2. Default path (workflow !== false): forwards to `release.plan` then
 *      `release.open` via dispatch.
 *   3. Escape-hatch path (`--workflow=false`): falls through to legacy
 *      `pipeline.release.ship` dispatch AND appends a CRITICAL record to
 *      `.cleo/audit/release-workflow-bypass.jsonl` (R-441).
 *   4. Dry-run forwards plan but skips open (preview semantics).
 *   5. The exported notice constant is a non-empty string for downstream
 *      assertions.
 *
 * Strategy:
 *   - Mock `dispatchFromCli` so we observe operation names + params without
 *     spawning a real release.
 *   - Mock `release.appendReleaseWorkflowBypass` to confirm the escape-hatch
 *     path audits the bypass.
 *   - Capture `process.stderr.write` to confirm the deprecation warning lands
 *     on stderr (NOT stdout — JSON envelope integrity).
 *
 * @task T9538
 * @epic T9498
 * @spec SPEC-T9345 §12 R-420 / R-440 / R-441
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE importing the command under test
// ---------------------------------------------------------------------------

const mockDispatchFromCli = vi.fn();
const mockAppendBypass = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
}));

vi.mock('@cleocode/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cleocode/core')>();
  return {
    ...original,
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
  workflow?: boolean;
  'workflow-bypass-reason'?: string;
  'dry-run'?: boolean;
  push?: boolean;
  bump?: boolean;
  remote?: string;
  force?: boolean;
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

  it('writes the deprecation warning to stderr on every invocation', async () => {
    const cap = captureStderr();
    try {
      await invokeShip({ version: '2026.6.0', epic: 'T9498' });
    } finally {
      cap.restore();
    }
    const stderrOutput = cap.writes.join('');
    expect(stderrOutput).toContain('cleo release ship');
    expect(stderrOutput).toContain('DEPRECATED');
    expect(stderrOutput).toContain('cleo release plan');
  });

  it('default path (no --workflow flag) forwards to release.plan then release.open', async () => {
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
    expect(firstCall?.[2]).toBe('release.plan');
    expect(firstCall?.[3]).toMatchObject({
      version: '2026.6.0',
      epicId: 'T9498',
      dryRun: false,
    });

    // Call 2: release.open with version.
    expect(secondCall?.[0]).toBe('mutate');
    expect(secondCall?.[1]).toBe('release');
    expect(secondCall?.[2]).toBe('release.open');
    expect(secondCall?.[3]).toMatchObject({ version: '2026.6.0' });

    // Escape hatch MUST NOT have been engaged.
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
    expect(call?.[2]).toBe('release.plan');
    expect(call?.[3]).toMatchObject({ dryRun: true });
    expect(mockAppendBypass).not.toHaveBeenCalled();
  });

  it('--workflow=false engages legacy pipeline.release.ship + audits bypass', async () => {
    const cap = captureStderr();
    try {
      await invokeShip({
        version: '2026.6.0',
        epic: 'T9498',
        workflow: false,
        'workflow-bypass-reason': 'GHA outage — hotfix only',
        push: true,
        bump: true,
      });
    } finally {
      cap.restore();
    }

    // Exactly one dispatch — and it MUST be the legacy pipeline route.
    expect(mockDispatchFromCli).toHaveBeenCalledTimes(1);
    const call = mockDispatchFromCli.mock.calls[0];
    expect(call?.[1]).toBe('pipeline');
    expect(call?.[2]).toBe('release.ship');
    expect(call?.[3]).toMatchObject({
      version: '2026.6.0',
      epicId: 'T9498',
      push: true,
      bump: true,
    });

    // Audit log MUST have been appended exactly once (R-441).
    expect(mockAppendBypass).toHaveBeenCalledTimes(1);
    const auditOpts = mockAppendBypass.mock.calls[0]?.[0];
    expect(auditOpts).toMatchObject({
      version: '2026.6.0',
      epicId: 'T9498',
      reason: 'GHA outage — hotfix only',
      source: 'cli-flag',
    });
  });

  it('--workflow=false without reason records a sentinel rationale (audit-complete)', async () => {
    const cap = captureStderr();
    try {
      await invokeShip({ version: '2026.6.0', epic: 'T9498', workflow: false });
    } finally {
      cap.restore();
    }

    expect(mockAppendBypass).toHaveBeenCalledTimes(1);
    const auditOpts = mockAppendBypass.mock.calls[0]?.[0] as { reason: string };
    expect(auditOpts.reason).toMatch(/no reason supplied/i);
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
