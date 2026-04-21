/**
 * Tests for the T1013 `cleo verify --explain` slice.
 *
 * Covers both the CLI command wiring (packages/cleo/src/cli/commands/verify.ts)
 * and the dispatch handler enrichment (packages/cleo/src/dispatch/domains/check.ts
 * operation `verify.explain`).
 *
 * Test matrix:
 *   1. CLI command exposes `--explain` flag
 *   2. `--explain` routes to `check.verify.explain` (read-only)
 *   3. `--explain` response includes `gates[]` with all ADR-051 gate names
 *      and ISO timestamps
 *   4. `--explain` response includes `evidence[]` with atom kinds and
 *      re-validation status
 *   5. `--explain` response includes `blockers[]` for incomplete tasks
 *   6. Without `--explain` the CLI dispatches `gate.status` — shape is the
 *      legacy pass/fail summary and does NOT carry explain-only fields
 *   7. Stale evidence (file hash mismatch) surfaces in `blockers[]`
 *   8. Write paths (`--gate`, `--all`, `--reset`) still ignore `--explain`
 *
 * @task T1013
 * @task T1006
 * @adr ADR-051
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchResponse, DomainHandler, Gateway } from '../../../dispatch/types.js';

// ---------------------------------------------------------------------------
// Top-level module mocks — must precede any imports that transitively load
// the dispatch layer so vitest hoists them correctly.
// ---------------------------------------------------------------------------

vi.mock('../../../dispatch/lib/engine.js', () => ({
  // Full validate-engine surface referenced by CheckHandler
  validateSchemaOp: vi.fn(),
  validateTaskOp: vi.fn(),
  validateManifestOp: vi.fn(),
  validateOutput: vi.fn(),
  validateComplianceSummary: vi.fn(),
  validateComplianceViolations: vi.fn(),
  validateComplianceRecord: vi.fn(),
  validateTestStatus: vi.fn(),
  validateTestCoverage: vi.fn(),
  validateTestRun: vi.fn(),
  validateCoherenceCheck: vi.fn(),
  validateProtocol: vi.fn(),
  validateProtocolConsensus: vi.fn(),
  validateProtocolContribution: vi.fn(),
  validateProtocolDecomposition: vi.fn(),
  validateProtocolImplementation: vi.fn(),
  validateProtocolSpecification: vi.fn(),
  validateProtocolResearch: vi.fn(),
  validateProtocolArchitectureDecision: vi.fn(),
  validateProtocolValidation: vi.fn(),
  validateProtocolTesting: vi.fn(),
  validateProtocolRelease: vi.fn(),
  validateProtocolArtifactPublish: vi.fn(),
  validateProtocolProvenance: vi.fn(),
  validateGateVerify: vi.fn(),
  systemArchiveStats: vi.fn(),
}));

/**
 * revalidateEvidence mock — lets individual tests drive staleness detection.
 *
 * Default: always stillValid=true, mirroring happy-path behavior where all
 * captured evidence still matches filesystem/git state.
 */
const mockRevalidateEvidence = vi.fn(async () => ({
  stillValid: true,
  failedAtoms: [] as Array<{
    atom: import('@cleocode/contracts').EvidenceAtom;
    reason: string;
  }>,
}));

vi.mock('@cleocode/core/internal', async () => {
  const actual =
    await vi.importActual<typeof import('@cleocode/core/internal')>('@cleocode/core/internal');
  return {
    ...actual,
    getProjectRoot: vi.fn(() => '/mock/project'),
    getLogger: vi.fn(() => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    })),
    revalidateEvidence: (...args: Parameters<typeof mockRevalidateEvidence>) =>
      mockRevalidateEvidence(...args),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { CheckHandler } from '../../../dispatch/domains/check.js';
import { validateGateVerify } from '../../../dispatch/lib/engine.js';
import { verifyCommand } from '../verify.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fully-populated `validateGateVerify` happy-path mock result with
 * real-shaped evidence (GateEvidence, not legacy arrays).
 *
 * Captured evidence covers all 6 ADR-051 gates so tests can assert on the
 * canonical gate name set.
 */
function makeVerifyResultAllPassed(taskId = 'T1013') {
  const capturedAt = '2026-04-19T12:00:00.000Z';
  const capturedBy = 'agent-verify';
  return {
    success: true,
    data: {
      taskId,
      title: 'T1013 slice',
      status: 'pending',
      verification: {
        passed: true,
        round: 1,
        gates: {
          implemented: true,
          testsPassed: true,
          qaPassed: true,
          documented: true,
          securityPassed: true,
          cleanupDone: true,
        },
        evidence: {
          implemented: {
            atoms: [
              { kind: 'commit', sha: 'abc1234def5678', shortSha: 'abc1234' },
              {
                kind: 'files',
                files: [
                  { path: 'packages/cleo/src/cli/commands/verify.ts', sha256: 'f'.repeat(64) },
                ],
              },
            ],
            capturedAt,
            capturedBy,
          },
          testsPassed: {
            atoms: [
              {
                kind: 'tool',
                tool: 'pnpm-test',
                exitCode: 0,
                stdoutTail: '12 passed',
              },
            ],
            capturedAt,
            capturedBy,
          },
          qaPassed: {
            atoms: [
              { kind: 'tool', tool: 'biome', exitCode: 0, stdoutTail: 'ok' },
              { kind: 'tool', tool: 'tsc', exitCode: 0, stdoutTail: 'ok' },
            ],
            capturedAt,
            capturedBy,
          },
          documented: {
            atoms: [{ kind: 'url', url: 'https://example.com/spec' }],
            capturedAt,
            capturedBy,
          },
          securityPassed: {
            atoms: [{ kind: 'note', note: 'no network surface' }],
            capturedAt,
            capturedBy,
          },
          cleanupDone: {
            atoms: [{ kind: 'note', note: 'removed dead branches' }],
            capturedAt,
            capturedBy,
          },
        },
        failureLog: [],
        lastUpdated: capturedAt,
      },
      requiredGates: [
        'implemented',
        'testsPassed',
        'qaPassed',
        'documented',
        'securityPassed',
        'cleanupDone',
      ],
      missingGates: [],
    },
  };
}

/**
 * Happy-path partial state — `implemented` passes, all others pending.
 * Used to assert blockers[] is populated for incomplete tasks.
 */
function makeVerifyResultPartial(taskId = 'T1013') {
  const capturedAt = '2026-04-19T12:00:00.000Z';
  return {
    success: true,
    data: {
      taskId,
      title: 'Partial task',
      status: 'pending',
      verification: {
        passed: false,
        round: 1,
        gates: {
          implemented: true,
          testsPassed: null,
          qaPassed: null,
          documented: null,
          securityPassed: null,
          cleanupDone: null,
        },
        evidence: {
          implemented: {
            atoms: [
              { kind: 'commit', sha: 'abc1234def5678', shortSha: 'abc1234' },
              {
                kind: 'files',
                files: [{ path: 'a.ts', sha256: 'f'.repeat(64) }],
              },
            ],
            capturedAt,
            capturedBy: 'agent-verify',
          },
        },
        failureLog: [],
        lastUpdated: capturedAt,
      },
      requiredGates: [
        'implemented',
        'testsPassed',
        'qaPassed',
        'documented',
        'securityPassed',
        'cleanupDone',
      ],
      missingGates: ['testsPassed', 'qaPassed', 'documented', 'securityPassed', 'cleanupDone'],
    },
  };
}

// ---------------------------------------------------------------------------
// 1. CLI command surface
// ---------------------------------------------------------------------------

describe('verifyCommand — CLI flag surface (T1013)', () => {
  it('exposes --explain as a boolean flag on `cleo verify`', () => {
    const explainArg = verifyCommand.args?.explain;
    expect(explainArg).toBeDefined();
    expect(explainArg?.type).toBe('boolean');
    expect(explainArg?.description).toMatch(/blocker|evidence|explain/i);
  });

  it('still exposes the legacy write flags (gate, all, reset, evidence)', () => {
    const args = verifyCommand.args ?? {};
    expect(args.gate).toBeDefined();
    expect(args.all).toBeDefined();
    expect(args.reset).toBeDefined();
    expect(args.evidence).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Dispatch routing — --explain vs gate.status vs gate.set
// ---------------------------------------------------------------------------

/**
 * Captures what {@link verifyCommand.run} dispatches so we can assert routing.
 *
 * The CLI adapter isn't directly mockable at module scope without tearing
 * down real dispatcher internals, so we install a targeted spy on the
 * Dispatcher#dispatch prototype instead.
 */
async function runVerifyCommand(cliArgs: Record<string, unknown>): Promise<{
  gateway: Gateway;
  domain: string;
  operation: string;
  params: Record<string, unknown>;
}> {
  let captured: {
    gateway: Gateway;
    domain: string;
    operation: string;
    params: Record<string, unknown>;
  } | null = null;

  const adapter = await import('../../../dispatch/adapters/cli.js');
  const spy = vi
    .spyOn(adapter, 'dispatchFromCli')
    .mockImplementation(
      async (
        gateway: Gateway,
        domain: string,
        operation: string,
        params?: Record<string, unknown>,
      ): Promise<DispatchResponse> => {
        captured = {
          gateway,
          domain,
          operation,
          params: (params ?? {}) as Record<string, unknown>,
        };
        return {
          meta: { gateway, domain, operation, startTime: 0, durationMs: 0 } as never,
          success: true,
          data: {},
        };
      },
    );

  try {
    await verifyCommand.run?.({
      args: cliArgs as never,
      cmd: verifyCommand as never,
      rawArgs: [] as never,
    } as never);
  } finally {
    spy.mockRestore();
  }

  if (!captured) {
    throw new Error('dispatchFromCli was not invoked');
  }
  return captured;
}

describe('verifyCommand — dispatch routing (T1013)', () => {
  it('routes to check.verify.explain (query) when --explain is passed', async () => {
    const captured = await runVerifyCommand({
      taskId: 'T1013',
      explain: true,
      value: 'true',
    });
    expect(captured.gateway).toBe('query');
    expect(captured.domain).toBe('check');
    expect(captured.operation).toBe('verify.explain');
    expect(captured.params.taskId).toBe('T1013');
  });

  it('routes to check.gate.status (query) when --explain is absent', async () => {
    const captured = await runVerifyCommand({
      taskId: 'T1013',
      value: 'true',
    });
    expect(captured.gateway).toBe('query');
    expect(captured.domain).toBe('check');
    expect(captured.operation).toBe('gate.status');
  });

  it('routes to check.gate.set (mutate) when a write flag is passed, ignoring --explain', async () => {
    const captured = await runVerifyCommand({
      taskId: 'T1013',
      gate: 'implemented',
      explain: true,
      value: 'true',
      evidence: 'commit:abc1234;files:a.ts',
    });
    expect(captured.gateway).toBe('mutate');
    expect(captured.operation).toBe('gate.set');
    expect(captured.params.gate).toBe('implemented');
    expect(captured.params.evidence).toBe('commit:abc1234;files:a.ts');
  });
});

// ---------------------------------------------------------------------------
// 3. Dispatch handler — verify.explain response shape
// ---------------------------------------------------------------------------

describe('CheckHandler.verify.explain — response shape (T1013)', () => {
  let handler: DomainHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRevalidateEvidence.mockResolvedValue({ stillValid: true, failedAtoms: [] });
    handler = new CheckHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns gates[] containing every ADR-051 required gate with ISO timestamps', async () => {
    vi.mocked(validateGateVerify).mockResolvedValue(makeVerifyResultAllPassed());

    const result = await handler.query?.('verify.explain', { taskId: 'T1013' });
    expect(result?.success).toBe(true);
    const data = result?.data as {
      gates: Array<{ name: string; state: 'pass' | 'fail' | 'pending'; timestamp: string | null }>;
    };
    expect(Array.isArray(data.gates)).toBe(true);
    const names = data.gates.map((g) => g.name).sort();
    expect(names).toEqual(
      [
        'cleanupDone',
        'documented',
        'implemented',
        'qaPassed',
        'securityPassed',
        'testsPassed',
      ].sort(),
    );
    // Every passed gate must carry an ISO timestamp (T832 audit trail).
    for (const g of data.gates) {
      expect(g.state).toBe('pass');
      expect(typeof g.timestamp).toBe('string');
      expect(g.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it('returns evidence[] with atom kinds and stillValid=true when evidence matches filesystem', async () => {
    vi.mocked(validateGateVerify).mockResolvedValue(makeVerifyResultAllPassed());

    const result = await handler.query?.('verify.explain', { taskId: 'T1013' });
    expect(result?.success).toBe(true);
    const data = result?.data as {
      evidence: Array<{
        gate: string;
        atoms: Array<{ kind: string }>;
        stillValid: boolean;
        failedAtoms: unknown[];
        capturedAt: string;
        capturedBy: string;
      }>;
    };
    expect(Array.isArray(data.evidence)).toBe(true);
    expect(data.evidence.length).toBe(6);

    // implemented gate carries both a commit and a files atom
    const implemented = data.evidence.find((e) => e.gate === 'implemented');
    expect(implemented).toBeDefined();
    expect(implemented?.stillValid).toBe(true);
    expect(implemented?.failedAtoms).toHaveLength(0);
    const kinds = implemented?.atoms.map((a) => a.kind).sort();
    expect(kinds).toEqual(['commit', 'files']);
    expect(implemented?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(implemented?.capturedBy).toBe('agent-verify');
  });

  it('returns blockers[] listing every unmet required gate for incomplete tasks', async () => {
    vi.mocked(validateGateVerify).mockResolvedValue(makeVerifyResultPartial());

    const result = await handler.query?.('verify.explain', { taskId: 'T1013' });
    expect(result?.success).toBe(true);
    const data = result?.data as {
      blockers: string[];
      gates: Array<{ name: string; state: string }>;
    };
    expect(Array.isArray(data.blockers)).toBe(true);
    // 5 unmet gates → at least 5 blocker lines
    expect(data.blockers.length).toBeGreaterThanOrEqual(5);
    expect(data.blockers.some((b) => b.includes('testsPassed'))).toBe(true);
    expect(data.blockers.some((b) => b.includes('qaPassed'))).toBe(true);
    // Each blocker should point at the fix command
    expect(
      data.blockers.every((b) => /cleo verify/.test(b) || /stale/i.test(b) || /done/i.test(b)),
    ).toBe(true);

    // Pending gates should be reflected as 'pending' state in gates[]
    const pending = data.gates.filter((g) => g.state === 'pending');
    expect(pending.length).toBe(5);
  });

  it('surfaces stale evidence in blockers[] when revalidateEvidence reports file drift', async () => {
    // Mock revalidation to fail for the `implemented` gate's files atom
    mockRevalidateEvidence.mockImplementation(async (ev) => {
      const hasFilesAtom = ev.atoms.some((a) => a.kind === 'files');
      if (hasFilesAtom) {
        return {
          stillValid: false,
          failedAtoms: [
            {
              atom: ev.atoms[0],
              reason: 'File modified since verify: a.ts (expected ffffffff, got 00000000)',
            },
          ],
        };
      }
      return { stillValid: true, failedAtoms: [] };
    });

    vi.mocked(validateGateVerify).mockResolvedValue(makeVerifyResultAllPassed());

    const result = await handler.query?.('verify.explain', { taskId: 'T1013' });
    expect(result?.success).toBe(true);
    const data = result?.data as {
      blockers: string[];
      evidence: Array<{ gate: string; stillValid: boolean; failedAtoms: unknown[] }>;
      explanation: string;
    };
    // stale gates produce E_EVIDENCE_STALE blockers
    expect(data.blockers.some((b) => /stale/i.test(b) && b.includes('implemented'))).toBe(true);
    expect(data.blockers.some((b) => /E_EVIDENCE_STALE/.test(b))).toBe(true);
    // the evidence[] entry carries the stillValid=false signal
    const impl = data.evidence.find((e) => e.gate === 'implemented');
    expect(impl?.stillValid).toBe(false);
    expect(impl?.failedAtoms.length).toBeGreaterThan(0);
    // explanation adds the [STALE] tag for visual callers
    expect(data.explanation).toContain('[STALE]');
  });

  it('returns blockers[] with a done-lock message when the task is already completed', async () => {
    const doneResult = makeVerifyResultAllPassed();
    doneResult.data.status = 'done';
    vi.mocked(validateGateVerify).mockResolvedValue(doneResult);

    const result = await handler.query?.('verify.explain', { taskId: 'T1013' });
    expect(result?.success).toBe(true);
    const data = result?.data as { blockers: string[] };
    expect(data.blockers.some((b) => /already done/i.test(b))).toBe(true);
  });

  it('preserves the legacy gatesMap / evidenceMap object-form for back-compat consumers', async () => {
    vi.mocked(validateGateVerify).mockResolvedValue(makeVerifyResultPartial());

    const result = await handler.query?.('verify.explain', { taskId: 'T1013' });
    expect(result?.success).toBe(true);
    const data = result?.data as {
      gatesMap: Record<string, boolean | null>;
      evidenceMap: Record<string, unknown>;
    };
    expect(data.gatesMap.implemented).toBe(true);
    // Null (unset) values flow through unchanged.
    expect(data.gatesMap.testsPassed).toBeNull();
    expect(data.evidenceMap.implemented).toBeDefined();
  });

  it('propagates E_NOT_FOUND from the underlying gate.status engine call', async () => {
    vi.mocked(validateGateVerify).mockResolvedValue({
      success: false,
      error: { code: 'E_NOT_FOUND', message: 'Task not found' },
    });
    const result = await handler.query?.('verify.explain', { taskId: 'T9999' });
    expect(result?.success).toBe(false);
    expect(result?.error?.code).toBe('E_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// 4. Backward compatibility — without --explain, gate.status shape is
//    UNCHANGED (no blockers[], no gates[], no evidence[] arrays).
// ---------------------------------------------------------------------------

describe('CheckHandler.gate.status — unchanged by T1013', () => {
  let handler: DomainHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CheckHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the legacy pass/fail summary shape (no T1013 arrays)', async () => {
    vi.mocked(validateGateVerify).mockResolvedValue(makeVerifyResultPartial());

    const result = await handler.query?.('gate.status', { taskId: 'T1013' });
    expect(result?.success).toBe(true);
    const data = result?.data as Record<string, unknown>;
    // gate.status MUST expose the raw verification object, NOT the T1013 arrays
    expect(data['verification']).toBeDefined();
    expect(Array.isArray(data['blockers'])).toBe(false);
    expect(data['blockers']).toBeUndefined();
    // `gates` on gate.status is the legacy object (not an array of records)
    // — the raw engine result surfaces it inside `verification.gates`.
    const verification = data['verification'] as Record<string, unknown>;
    expect(verification['gates']).toBeDefined();
    expect(Array.isArray(verification['gates'])).toBe(false);
  });
});
