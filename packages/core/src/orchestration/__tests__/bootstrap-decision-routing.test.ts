/**
 * Unit tests for bootstrap.ts decision routing — T11185.
 *
 * Verifies that buildBrainState() prefers BRAIN brain_decisions table
 * over the legacy .cleo/decision-log.jsonl ledger blob when loading
 * recent decisions for agent startup context.
 *
 * @task T11185
 * @epic T10520
 * @saga T10516
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state — all mutable refs survive vi.mock hoisting
// ---------------------------------------------------------------------------

const {
  mockExistsSync,
  mockReadFileSync,
  mockFindDecisions,
  mockLoadSessions,
  mockQueryTasks,
  mockGetMetaValue,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockFindDecisions: vi.fn(),
  mockLoadSessions: vi.fn(() => Promise.resolve([])),
  mockQueryTasks: vi.fn(() => Promise.resolve({ tasks: [] })),
  mockGetMetaValue: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

vi.mock('../../store/memory-accessor.js', () => ({
  getBrainAccessor: vi.fn(() =>
    Promise.resolve({
      findDecisions: mockFindDecisions,
    }),
  ),
}));

vi.mock('../../store/data-accessor.js', () => ({
  getTaskAccessor: vi.fn(() =>
    Promise.resolve({
      queryTasks: mockQueryTasks,
      loadSessions: mockLoadSessions,
      getMetaValue: mockGetMetaValue,
    }),
  ),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { buildBrainState } from '../bootstrap.js';

const PROJECT_ROOT = '/tmp/mock-project';

describe('buildBrainState — decision routing (T11185)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
    mockFindDecisions.mockResolvedValue([]);
  });

  // ── BRAIN-primary path ──────────────────────────────────────────────

  describe('BRAIN decisions preferred', () => {
    it('uses BRAIN decisions when brain_decisions has entries', async () => {
      mockFindDecisions.mockResolvedValue([
        {
          id: 'D001',
          decision: 'Use TypeScript strict mode',
          rationale: 'Catches more errors at compile time',
          createdAt: '2026-05-27 12:00:00',
        },
        {
          id: 'D002',
          decision: 'Adopt SQLite for local state',
          rationale: 'Embedded, fast, no server needed',
          createdAt: '2026-05-27 13:00:00',
        },
      ]);

      const brain = await buildBrainState(PROJECT_ROOT, { speed: 'full' });

      expect(brain.recentDecisions).toBeDefined();
      expect(brain.recentDecisions).toHaveLength(2);
      expect(brain.recentDecisions![0].id).toBe('D001');
      expect(brain.recentDecisions![0].decision).toBe('Use TypeScript strict mode');
    });

    it('does NOT fall back to ledger blob when BRAIN has entries', async () => {
      mockFindDecisions.mockResolvedValue([
        {
          id: 'D010',
          decision: 'BRAIN decision',
          rationale: 'From brain_decisions',
          createdAt: '2026-05-27 12:00:00',
        },
      ]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ id: 'old-1', decision: 'Ledger decision', timestamp: '2026-05-26' }) + '\n',
      );

      const brain = await buildBrainState(PROJECT_ROOT, { speed: 'full' });

      expect(brain.recentDecisions).toHaveLength(1);
      expect(brain.recentDecisions![0].id).toBe('D010');
      expect(brain.recentDecisions![0].decision).toBe('BRAIN decision');
    });
  });

  // ── Fallback path ───────────────────────────────────────────────────

  describe('ledger blob fallback', () => {
    it('falls back to decision-log.jsonl when BRAIN is empty', async () => {
      mockFindDecisions.mockResolvedValue([]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ id: 'dec-abc', decision: 'Fallback decision', timestamp: '2026-05-26' }) + '\n' +
        JSON.stringify({ id: 'dec-def', decision: 'Another fallback', timestamp: '2026-05-27' }) + '\n',
      );

      const brain = await buildBrainState(PROJECT_ROOT, { speed: 'full' });

      expect(brain.recentDecisions).toHaveLength(2);
      expect(brain.recentDecisions![0].id).toBe('dec-abc');
      expect(brain.recentDecisions![0].decision).toBe('Fallback decision');
    });

    it('falls back to decision-log.jsonl when BRAIN accessor throws', async () => {
      mockFindDecisions.mockRejectedValue(new Error('BRAIN DB unavailable'));
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ id: 'ledger-only', decision: 'Ledger rescue', timestamp: '2026-05-27' }) + '\n',
      );

      const brain = await buildBrainState(PROJECT_ROOT, { speed: 'full' });

      expect(brain.recentDecisions).toHaveLength(1);
      expect(brain.recentDecisions![0].id).toBe('ledger-only');
    });

    it('handles missing ledger blob gracefully when BRAIN is empty', async () => {
      mockFindDecisions.mockResolvedValue([]);
      mockExistsSync.mockReturnValue(false);

      const brain = await buildBrainState(PROJECT_ROOT, { speed: 'full' });

      expect(brain.recentDecisions).toBeUndefined();
    });
  });

  // ── Speed tiers ─────────────────────────────────────────────────────

  describe('speed tier behavior', () => {
    it('skips decision loading on fast speed tier', async () => {
      mockFindDecisions.mockResolvedValue([
        { id: 'D001', decision: 'Should not be loaded', rationale: 'x', createdAt: '2026-01-01' },
      ]);

      const brain = await buildBrainState(PROJECT_ROOT, { speed: 'fast' });

      expect(brain.recentDecisions).toBeUndefined();
    });
  });

  // ── Malformed ledger lines ──────────────────────────────────────────

  describe('malformed ledger lines', () => {
    it('skips malformed JSON lines in the ledger blob', async () => {
      mockFindDecisions.mockResolvedValue([]);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        'not json\n' +
        JSON.stringify({ id: 'dec-valid', decision: 'Valid one', timestamp: '2026-05-27' }) + '\n' +
        '{broken\n',
      );

      const brain = await buildBrainState(PROJECT_ROOT, { speed: 'full' });

      expect(brain.recentDecisions).toHaveLength(1);
      expect(brain.recentDecisions![0].id).toBe('dec-valid');
    });
  });
});
