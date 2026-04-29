/**
 * Tests for {@link checkExplainVerification} extracted to Core (T1541).
 *
 * Mirrors the existing verify-explain.test.ts integration coverage at
 * `packages/cleo/src/cli/commands/__tests__/verify-explain.test.ts` but
 * tests the Core function directly — without touching the dispatch layer.
 *
 * Test matrix:
 *   1. Happy path: all gates pass → gates[] with "pass" state, evidence[],
 *      no blockers, explanation contains "PASSED"
 *   2. Partial state: 5 gates pending → blockers[] lists them all
 *   3. Stale evidence: revalidation failure → [STALE] in explanation,
 *      E_EVIDENCE_STALE in blockers[]
 *   4. Done task: status=done → done-lock blocker
 *   5. Legacy atom-array evidence: normalised correctly
 *   6. Missing evidence (gate with no atoms): skipped in evidence[]
 *   7. Back-compat: gatesMap / evidenceMap mirrors raw gate state
 *
 * @task T1541
 * @task T1013
 * @adr ADR-051
 * @adr ADR-057
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock checkRevalidateEvidence before importing the module under test
// ---------------------------------------------------------------------------

// checkRevalidateEvidence(projectRoot: string, params: { evidence: GateEvidence }) -> result
const mockCheckRevalidateEvidence = vi.fn(
  async (
    _projectRoot: string,
    _params: { evidence: unknown },
  ): Promise<{
    stillValid: boolean;
    failedAtoms: Array<{
      atom: import('@cleocode/contracts').EvidenceAtom;
      reason: string;
    }>;
  }> => ({
    stillValid: true,
    failedAtoms: [],
  }),
);

vi.mock('../../../validation/ops.js', () => ({
  checkRevalidateEvidence: (projectRoot: string, params: { evidence: unknown }) =>
    mockCheckRevalidateEvidence(projectRoot, params),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { checkExplainVerification, type GateStatusRawData } from '../explain.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUIRED_GATES = [
  'implemented',
  'testsPassed',
  'qaPassed',
  'documented',
  'securityPassed',
  'cleanupDone',
];

const CAPTURED_AT = '2026-04-19T12:00:00.000Z';
const CAPTURED_BY = 'agent-verify';
const PROJECT_ROOT = '/mock/project';
const TASK_ID = 'T1541';

/** All 6 gates passing with canonical GateEvidence objects. */
function makeAllPassedData(taskId = TASK_ID): GateStatusRawData {
  return {
    taskId,
    title: 'T1541 slice',
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
            { kind: 'files', files: [{ path: 'src/explain.ts', sha256: 'f'.repeat(64) }] },
          ],
          capturedAt: CAPTURED_AT,
          capturedBy: CAPTURED_BY,
        },
        testsPassed: {
          atoms: [{ kind: 'tool', tool: 'pnpm-test', exitCode: 0, stdoutTail: '10 passed' }],
          capturedAt: CAPTURED_AT,
          capturedBy: CAPTURED_BY,
        },
        qaPassed: {
          atoms: [
            { kind: 'tool', tool: 'biome', exitCode: 0, stdoutTail: 'ok' },
            { kind: 'tool', tool: 'tsc', exitCode: 0, stdoutTail: 'ok' },
          ],
          capturedAt: CAPTURED_AT,
          capturedBy: CAPTURED_BY,
        },
        documented: {
          atoms: [{ kind: 'url', url: 'https://example.com/spec' }],
          capturedAt: CAPTURED_AT,
          capturedBy: CAPTURED_BY,
        },
        securityPassed: {
          atoms: [{ kind: 'note', note: 'no network surface' }],
          capturedAt: CAPTURED_AT,
          capturedBy: CAPTURED_BY,
        },
        cleanupDone: {
          atoms: [{ kind: 'note', note: 'removed dead branches' }],
          capturedAt: CAPTURED_AT,
          capturedBy: CAPTURED_BY,
        },
      },
      lastUpdated: CAPTURED_AT,
    },
    requiredGates: REQUIRED_GATES,
    missingGates: [],
  };
}

/** Only `implemented` passes; the other 5 are pending (null). */
function makePartialData(taskId = TASK_ID): GateStatusRawData {
  return {
    taskId,
    title: 'Partial task',
    status: 'pending',
    verification: {
      passed: false,
      round: 1,
      gates: {
        implemented: true,
        testsPassed: null as unknown as boolean,
        qaPassed: null as unknown as boolean,
        documented: null as unknown as boolean,
        securityPassed: null as unknown as boolean,
        cleanupDone: null as unknown as boolean,
      },
      evidence: {
        implemented: {
          atoms: [
            { kind: 'commit', sha: 'abc1234def5678', shortSha: 'abc1234' },
            { kind: 'files', files: [{ path: 'a.ts', sha256: 'f'.repeat(64) }] },
          ],
          capturedAt: CAPTURED_AT,
          capturedBy: CAPTURED_BY,
        },
      },
      lastUpdated: CAPTURED_AT,
    },
    requiredGates: REQUIRED_GATES,
    missingGates: ['testsPassed', 'qaPassed', 'documented', 'securityPassed', 'cleanupDone'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkExplainVerification — happy path (all gates pass)', () => {
  beforeEach(() => {
    mockCheckRevalidateEvidence.mockResolvedValue({ stillValid: true, failedAtoms: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns gates[] with "pass" state for every required gate', async () => {
    const result = await checkExplainVerification(makeAllPassedData(), PROJECT_ROOT, TASK_ID);
    expect(Array.isArray(result.gates)).toBe(true);
    expect(result.gates).toHaveLength(6);
    for (const g of result.gates) {
      expect(g.state).toBe('pass');
      expect(typeof g.timestamp).toBe('string');
      expect(g.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    const names = result.gates.map((g) => g.name).sort();
    expect(names).toEqual(REQUIRED_GATES.slice().sort());
  });

  it('returns evidence[] with 6 entries when all gates have evidence', async () => {
    const result = await checkExplainVerification(makeAllPassedData(), PROJECT_ROOT, TASK_ID);
    expect(result.evidence).toHaveLength(6);
    const impl = result.evidence.find((e) => e.gate === 'implemented');
    expect(impl).toBeDefined();
    expect(impl?.stillValid).toBe(true);
    expect(impl?.failedAtoms).toHaveLength(0);
    expect(impl?.capturedAt).toBe(CAPTURED_AT);
    expect(impl?.capturedBy).toBe(CAPTURED_BY);
    const kinds = impl?.atoms.map((a) => a.kind).sort();
    expect(kinds).toEqual(['commit', 'files']);
  });

  it('returns empty blockers[] and explanation contains "PASSED"', async () => {
    const result = await checkExplainVerification(makeAllPassedData(), PROJECT_ROOT, TASK_ID);
    expect(result.blockers).toHaveLength(0);
    expect(result.explanation).toContain('All required gates PASSED');
  });

  it('returns back-compat gatesMap / evidenceMap', async () => {
    const result = await checkExplainVerification(makeAllPassedData(), PROJECT_ROOT, TASK_ID);
    expect(result.gatesMap.implemented).toBe(true);
    expect(result.gatesMap.testsPassed).toBe(true);
    expect(result.evidenceMap.implemented).toBeDefined();
  });

  it('sets passed=true and round=1', async () => {
    const result = await checkExplainVerification(makeAllPassedData(), PROJECT_ROOT, TASK_ID);
    expect(result.passed).toBe(true);
    expect(result.round).toBe(1);
  });
});

describe('checkExplainVerification — partial state (5 gates pending)', () => {
  beforeEach(() => {
    mockCheckRevalidateEvidence.mockResolvedValue({ stillValid: true, failedAtoms: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns blockers[] listing every missing gate', async () => {
    const result = await checkExplainVerification(makePartialData(), PROJECT_ROOT, TASK_ID);
    expect(result.blockers.length).toBeGreaterThanOrEqual(5);
    expect(result.blockers.some((b) => b.includes('testsPassed'))).toBe(true);
    expect(result.blockers.some((b) => b.includes('qaPassed'))).toBe(true);
    expect(
      result.blockers.every((b) => /cleo verify/.test(b) || /stale/i.test(b) || /done/i.test(b)),
    ).toBe(true);
  });

  it('returns 5 pending gates in gates[]', async () => {
    const result = await checkExplainVerification(makePartialData(), PROJECT_ROOT, TASK_ID);
    const pending = result.gates.filter((g) => g.state === 'pending');
    expect(pending).toHaveLength(5);
  });

  it('returns null timestamps for pending gates', async () => {
    const result = await checkExplainVerification(makePartialData(), PROJECT_ROOT, TASK_ID);
    const pending = result.gates.filter((g) => g.state === 'pending');
    for (const g of pending) {
      expect(g.timestamp).toBeNull();
    }
  });

  it('returns explanation containing "PENDING"', async () => {
    const result = await checkExplainVerification(makePartialData(), PROJECT_ROOT, TASK_ID);
    expect(result.explanation).toContain('PENDING');
  });

  it('preserves back-compat: null gate values flow through gatesMap unchanged', async () => {
    const result = await checkExplainVerification(makePartialData(), PROJECT_ROOT, TASK_ID);
    expect(result.gatesMap.implemented).toBe(true);
    expect(result.gatesMap.testsPassed).toBeNull();
  });
});

describe('checkExplainVerification — stale evidence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces stale evidence in blockers[] and explanation with [STALE]', async () => {
    // Only the `implemented` gate has a files atom — simulate its staleness.
    // checkRevalidateEvidence(projectRoot, params) — second arg carries .evidence.atoms.
    mockCheckRevalidateEvidence.mockImplementation(async (_projectRoot, params) => {
      const evidence = (params as { evidence?: { atoms?: unknown[] } }).evidence;
      const atoms = evidence?.atoms ?? [];
      const hasFilesAtom = atoms.some((a) => (a as { kind?: string }).kind === 'files');
      if (hasFilesAtom) {
        return {
          stillValid: false,
          failedAtoms: [
            {
              atom: atoms[0] as import('@cleocode/contracts').EvidenceAtom,
              reason: 'File modified since verify: src/explain.ts (sha256 mismatch)',
            },
          ],
        };
      }
      return { stillValid: true, failedAtoms: [] };
    });

    const result = await checkExplainVerification(makeAllPassedData(), PROJECT_ROOT, TASK_ID);

    expect(result.blockers.some((b) => /stale/i.test(b) && b.includes('implemented'))).toBe(true);
    expect(result.blockers.some((b) => b.includes('E_EVIDENCE_STALE'))).toBe(true);

    const impl = result.evidence.find((e) => e.gate === 'implemented');
    expect(impl?.stillValid).toBe(false);
    expect(impl?.failedAtoms.length).toBeGreaterThan(0);

    expect(result.explanation).toContain('[STALE]');
    expect(result.explanation).toContain('BLOCKED');
  });
});

describe('checkExplainVerification — done task', () => {
  beforeEach(() => {
    mockCheckRevalidateEvidence.mockResolvedValue({ stillValid: true, failedAtoms: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds done-lock blocker when status is "done"', async () => {
    const data = makeAllPassedData();
    data.status = 'done';
    const result = await checkExplainVerification(data, PROJECT_ROOT, TASK_ID);
    expect(result.blockers.some((b) => /already done/i.test(b))).toBe(true);
    expect(result.blockers.some((b) => /ADR-051/.test(b))).toBe(true);
  });
});

describe('checkExplainVerification — legacy atom-array evidence', () => {
  beforeEach(() => {
    mockCheckRevalidateEvidence.mockResolvedValue({ stillValid: true, failedAtoms: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalises legacy bare-array evidence (capturedBy=unknown, capturedAt=lastUpdated)', async () => {
    const data = makeAllPassedData();
    // Replace implemented evidence with a legacy atom array.
    (data.verification!.evidence as Record<string, unknown>).implemented = [
      { kind: 'commit', sha: 'deadbeef01234567', shortSha: 'deadbeef' },
    ];
    const result = await checkExplainVerification(data, PROJECT_ROOT, TASK_ID);
    const impl = result.evidence.find((e) => e.gate === 'implemented');
    expect(impl).toBeDefined();
    expect(impl?.capturedBy).toBe('unknown');
    expect(impl?.capturedAt).toBe(CAPTURED_AT); // falls back to lastUpdated
    expect(impl?.atoms[0]?.kind).toBe('commit');
  });
});

describe('checkExplainVerification — missing evidence', () => {
  beforeEach(() => {
    mockCheckRevalidateEvidence.mockResolvedValue({ stillValid: true, failedAtoms: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips evidence[] entry for a gate that has no evidence object', async () => {
    const data = makePartialData();
    // The partial fixture has evidence only for `implemented`.
    const result = await checkExplainVerification(data, PROJECT_ROOT, TASK_ID);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.gate).toBe('implemented');
  });
});
