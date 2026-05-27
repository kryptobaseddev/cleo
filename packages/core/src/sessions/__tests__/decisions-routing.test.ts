/**
 * Unit tests for sessions/decisions.ts routing — T11185.
 *
 * Verifies:
 *  - getDecisionLog() prefers BRAIN brain_decisions, falls back to
 *    .cleo/audit/decisions.jsonl ledger blob, and deduplicates by content.
 *  - recordDecision() dual-writes to BRAIN decision-store + audit ledger.
 *
 * @task T11185
 * @epic T10520
 * @saga T10516
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock refs — all mutable refs survive vi.mock hoisting
// ---------------------------------------------------------------------------

const {
  mockExistsSync,
  mockReadFileSync,
  mockAppendFileSync,
  mockMkdirSync,
  mockFindDecisions,
  mockStoreDecision,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockAppendFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockFindDecisions: vi.fn(),
  mockStoreDecision: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  appendFileSync: mockAppendFileSync,
  mkdirSync: mockMkdirSync,
}));

vi.mock('node:crypto', () => ({
  randomBytes: vi.fn(() => ({
    toString: vi.fn(() => 'deadbeef'),
  })),
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => 'mockhash1234'),
  })),
}));

vi.mock('../../store/memory-accessor.js', () => ({
  getBrainAccessor: vi.fn(() =>
    Promise.resolve({
      findDecisions: mockFindDecisions,
    }),
  ),
}));

vi.mock('../../memory/decisions.js', () => ({
  storeDecision: (...args: unknown[]) => mockStoreDecision(...args),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { getDecisionLog, recordDecision } from '../decisions.js';

const PROJECT_ROOT = '/tmp/mock-project';

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('');
  mockAppendFileSync.mockReturnValue(undefined);
  mockMkdirSync.mockReturnValue(undefined);
  mockFindDecisions.mockResolvedValue([]);
  mockStoreDecision.mockResolvedValue({ id: 'D099' });
});

// =========================================================================
// getDecisionLog
// =========================================================================

describe('getDecisionLog — BRAIN + ledger routing (T11185)', () => {
  // ── BRAIN-primary path ──────────────────────────────────────────────

  describe('BRAIN preferred', () => {
    it('returns BRAIN decisions when brain_decisions has entries', async () => {
      mockFindDecisions.mockResolvedValue([
        {
          id: 'D042',
          decision: 'Adopt biome over prettier',
          rationale: 'Faster, integrated linting',
          createdAt: '2026-05-27 10:00:00',
          alternativesJson: JSON.stringify(['prettier', 'oxc']),
        },
      ]);

      const result = await getDecisionLog(PROJECT_ROOT, { taskId: 'T11185' });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('D042');
      expect(result[0].decision).toBe('Adopt biome over prettier');
    });

    it('returns decisions from BRAIN scoped to taskId via contextTaskId', async () => {
      mockFindDecisions.mockResolvedValue([
        {
          id: 'D050',
          decision: 'Task-specific decision',
          rationale: 'Only for T99999',
          createdAt: '2026-05-27 10:00:00',
          contextTaskId: 'T99999',
          alternativesJson: null,
        },
      ]);

      const result = await getDecisionLog(PROJECT_ROOT, { taskId: 'T99999' });

      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe('T99999');
      expect(mockFindDecisions).toHaveBeenCalledWith({ contextTaskId: 'T99999' });
    });
  });

  // ── Deduplication ───────────────────────────────────────────────────

  describe('deduplication', () => {
    it('deduplicates by content (decision + rationale) between BRAIN and ledger', async () => {
      mockFindDecisions.mockResolvedValue([
        {
          id: 'D001',
          decision: 'Shared decision',
          rationale: 'Present in both sources',
          createdAt: '2026-05-27 10:00:00',
          alternativesJson: null,
        },
      ]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          id: 'dec-old',
          sessionId: 'ses-1',
          taskId: 'T11185',
          decision: 'Shared decision',
          rationale: 'Present in both sources',
          timestamp: '2026-05-26',
        }) + '\n',
      );

      const result = await getDecisionLog(PROJECT_ROOT, {});

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('D001');
    });

    it('keeps unique ledger entries alongside BRAIN entries', async () => {
      mockFindDecisions.mockResolvedValue([
        {
          id: 'D010',
          decision: 'BRAIN-only',
          rationale: 'Only in brain_decisions',
          createdAt: '2026-05-27 10:00:00',
          alternativesJson: null,
        },
      ]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          id: 'dec-unique',
          sessionId: 'ses-1',
          taskId: 'T11185',
          decision: 'Ledger-only',
          rationale: 'Only in audit ledger',
          timestamp: '2026-05-26',
        }) + '\n',
      );

      const result = await getDecisionLog(PROJECT_ROOT, {});

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('D010');
      expect(result[1].id).toBe('dec-unique');
    });
  });

  // ── Fallback ────────────────────────────────────────────────────────

  describe('ledger fallback', () => {
    it('falls back to ledger when BRAIN accessor throws', async () => {
      mockFindDecisions.mockRejectedValue(new Error('DB down'));
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          id: 'dec-fallback',
          sessionId: 'ses-1',
          taskId: 'T11185',
          decision: 'Ledger rescue',
          rationale: 'BRAIN was down',
          timestamp: '2026-05-27',
        }) + '\n',
      );

      const result = await getDecisionLog(PROJECT_ROOT, {});

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('dec-fallback');
    });

    it('returns empty array when both BRAIN and ledger are empty', async () => {
      mockFindDecisions.mockResolvedValue([]);
      mockExistsSync.mockReturnValue(false);

      const result = await getDecisionLog(PROJECT_ROOT, {});

      expect(result).toHaveLength(0);
    });

    it('filters ledger entries by sessionId', async () => {
      mockFindDecisions.mockResolvedValue([]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          id: 'dec-a',
          sessionId: 'ses-target',
          taskId: 'T1',
          decision: 'Target',
          rationale: 'Matches',
          timestamp: '2026-05-27',
        }) + '\n' +
        JSON.stringify({
          id: 'dec-b',
          sessionId: 'ses-other',
          taskId: 'T1',
          decision: 'Other',
          rationale: 'No match',
          timestamp: '2026-05-27',
        }) + '\n',
      );

      const result = await getDecisionLog(PROJECT_ROOT, { sessionId: 'ses-target' });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('dec-a');
    });

    it('filters ledger entries by taskId', async () => {
      mockFindDecisions.mockResolvedValue([]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          id: 'dec-x',
          sessionId: 'ses-1',
          taskId: 'T11185',
          decision: 'Matches task',
          rationale: '',
          timestamp: '2026-05-27',
        }) + '\n' +
        JSON.stringify({
          id: 'dec-y',
          sessionId: 'ses-1',
          taskId: 'T99999',
          decision: 'Wrong task',
          rationale: '',
          timestamp: '2026-05-27',
        }) + '\n',
      );

      const result = await getDecisionLog(PROJECT_ROOT, { taskId: 'T11185' });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('dec-x');
    });

    it('skips malformed JSON lines in ledger', async () => {
      mockFindDecisions.mockResolvedValue([]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        'not json at all\n' +
        JSON.stringify({ id: 'dec-valid', sessionId: 'ses-1', taskId: 'T1', decision: 'OK', rationale: '', timestamp: '2026-05-27' }) + '\n' +
        '{broken\n',
      );

      const result = await getDecisionLog(PROJECT_ROOT, {});

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('dec-valid');
    });
  });
});

// =========================================================================
// recordDecision
// =========================================================================

describe('recordDecision — dual-write BRAIN + ledger (T11185)', () => {
  it('writes to both BRAIN decision-store and audit ledger', async () => {
    mockStoreDecision.mockResolvedValue({ id: 'D042' });

    const result = await recordDecision(PROJECT_ROOT, {
      sessionId: 'ses-test',
      taskId: 'T11185',
      decision: 'Test dual-write',
      rationale: 'Should hit both stores',
      alternatives: ['opt-a', 'opt-b'],
    });

    expect(mockStoreDecision).toHaveBeenCalledTimes(1);
    expect(mockStoreDecision).toHaveBeenCalledWith(
      PROJECT_ROOT,
      expect.objectContaining({
        type: 'technical',
        decision: 'Test dual-write',
        rationale: 'Should hit both stores',
        confidence: 'medium',
        outcome: 'pending',
        contextTaskId: 'T11185',
        alternatives: ['opt-a', 'opt-b'],
      }),
    );

    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = mockAppendFileSync.mock.calls[0][1];
    expect(writtenContent).toContain('D042:');
    expect(writtenContent).toContain('Test dual-write');

    expect(result.id).toContain('D042:');
    expect(result.decision).toBe('Test dual-write');
    expect(result.alternatives).toEqual(['opt-a', 'opt-b']);
  });

  it('writes to ledger even when BRAIN store fails', async () => {
    mockStoreDecision.mockRejectedValue(new Error('BRAIN write failed'));

    const result = await recordDecision(PROJECT_ROOT, {
      sessionId: 'ses-test',
      taskId: 'T11185',
      decision: 'Ledger-only fallback',
      rationale: 'BRAIN is down',
    });

    expect(mockStoreDecision).toHaveBeenCalledTimes(1);
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = mockAppendFileSync.mock.calls[0][1];
    expect(writtenContent).not.toContain('D0');
    expect(writtenContent).toContain('Ledger-only fallback');

    expect(result.id).toContain('dec-');
    expect(result.id).not.toContain('D0');
  });

  it('rejects missing required fields', async () => {
    await expect(recordDecision(PROJECT_ROOT, {
      sessionId: '',
      taskId: '',
      decision: '',
      rationale: '',
    })).rejects.toThrow('sessionId, taskId, decision, and rationale are required');

    expect(mockStoreDecision).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });
});
