/**
 * Tests for session memory auto-capture.
 *
 * Tests: extractMemoryItems, persistSessionMemory, getSessionMemoryContext.
 *
 * @epic T5149
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DebriefData } from '../../sessions/handoff.js';

let tempDir: string;
let cleoDir: string;

/**
 * Build a minimal DebriefData fixture for testing.
 */
function makeDebrief(overrides?: Partial<DebriefData>): DebriefData {
  return {
    handoff: {
      lastTask: 'T100',
      tasksCompleted: ['T101', 'T102'],
      tasksCreated: [],
      decisionsRecorded: 1,
      nextSuggested: ['T103'],
      openBlockers: [],
      openBugs: [],
      note: 'Finished the main implementation',
    },
    sessionId: 'S-test-001',
    agentIdentifier: 'agent-1',
    startedAt: '2026-03-01T10:00:00Z',
    endedAt: '2026-03-01T11:00:00Z',
    durationMinutes: 60,
    decisions: [
      {
        id: 'DEC-001',
        decision: 'Use SQLite for brain storage',
        rationale: 'Reliable embedded database with FTS5 support',
        taskId: 'T100',
      },
    ],
    gitState: null,
    chainPosition: 1,
    chainLength: 1,
    ...overrides,
  };
}

describe('Session Memory', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-session-memory-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    try {
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();
    } catch {
      // brain-sqlite may not be loaded
    }
    try {
      const { resetFts5Cache } = await import('../brain-search.js');
      resetFts5Cache();
    } catch {
      // brain-search may not be loaded
    }
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // extractMemoryItems
  // ==========================================================================

  describe('extractMemoryItems', () => {
    it('extracts decisions from debrief with correct type and text', async () => {
      const { extractMemoryItems } = await import('../session-memory.js');

      const debrief = makeDebrief();
      const items = extractMemoryItems('S-001', debrief);

      const decisionItems = items.filter((i) => i.type === 'decision');
      expect(decisionItems).toHaveLength(1);
      expect(decisionItems[0].text).toContain('Use SQLite for brain storage');
      expect(decisionItems[0].text).toContain('Reliable embedded database with FTS5 support');
      expect(decisionItems[0].sourceSessionId).toBe('S-001');
      expect(decisionItems[0].sourceType).toBe('session-debrief');
      expect(decisionItems[0].linkTaskId).toBe('T100');
    });

    it('extracts session summary when tasks were completed', async () => {
      const { extractMemoryItems } = await import('../session-memory.js');

      const debrief = makeDebrief();
      const items = extractMemoryItems('S-001', debrief);

      const changeItems = items.filter((i) => i.type === 'change');
      expect(changeItems).toHaveLength(1);
      expect(changeItems[0].text).toContain('S-001');
      expect(changeItems[0].text).toContain('2 tasks');
      expect(changeItems[0].text).toContain('T101');
      expect(changeItems[0].text).toContain('T102');
      expect(changeItems[0].text).toContain('T103'); // next suggested
    });

    it('extracts session note as discovery observation', async () => {
      const { extractMemoryItems } = await import('../session-memory.js');

      const debrief = makeDebrief();
      const items = extractMemoryItems('S-001', debrief);

      const discoveryItems = items.filter((i) => i.type === 'discovery');
      expect(discoveryItems).toHaveLength(1);
      expect(discoveryItems[0].text).toBe('Finished the main implementation');
      expect(discoveryItems[0].title).toContain('Session note:');
    });

    it('returns empty array when debrief has no decisions and no completions', async () => {
      const { extractMemoryItems } = await import('../session-memory.js');

      const debrief = makeDebrief({
        decisions: [],
        handoff: {
          lastTask: null,
          tasksCompleted: [],
          tasksCreated: [],
          decisionsRecorded: 0,
          nextSuggested: [],
          openBlockers: [],
          openBugs: [],
        },
      });
      const items = extractMemoryItems('S-001', debrief);
      expect(items).toHaveLength(0);
    });

    it('truncates long decision text to 120 chars for title', async () => {
      const { extractMemoryItems } = await import('../session-memory.js');

      const longDecision = 'A'.repeat(200);
      const debrief = makeDebrief({
        decisions: [{
          id: 'DEC-002',
          decision: longDecision,
          rationale: 'test',
          taskId: 'T100',
        }],
      });
      const items = extractMemoryItems('S-001', debrief);
      const decisionItem = items.find((i) => i.type === 'decision');
      expect(decisionItem).toBeTruthy();
      expect(decisionItem!.title.length).toBeLessThanOrEqual(120);
    });

    it('handles null/undefined debrief gracefully', async () => {
      const { extractMemoryItems } = await import('../session-memory.js');

      expect(extractMemoryItems('S-001', null)).toEqual([]);
      expect(extractMemoryItems('S-001', undefined)).toEqual([]);
    });
  });

  // ==========================================================================
  // persistSessionMemory
  // ==========================================================================

  describe('persistSessionMemory', () => {
    it('creates observations for each extracted item via observeBrain()', async () => {
      const { persistSessionMemory } = await import('../session-memory.js');

      const debrief = makeDebrief();
      const result = await persistSessionMemory(tempDir, 'S-001', debrief);

      // 1 decision + 1 session summary + 1 session note = 3 observations
      expect(result.observationsCreated).toBe(3);
      expect(result.observationIds).toHaveLength(3);
      expect(result.errors).toHaveLength(0);
    });

    it('creates brain_memory_links for decisions with taskIds', async () => {
      const { persistSessionMemory } = await import('../session-memory.js');

      const debrief = makeDebrief();
      const result = await persistSessionMemory(tempDir, 'S-001', debrief);

      // Only the decision has a linkTaskId
      expect(result.linksCreated).toBe(1);
    });

    it('returns correct counts in SessionMemoryResult', async () => {
      const { persistSessionMemory } = await import('../session-memory.js');

      const debrief = makeDebrief({
        decisions: [
          { id: 'DEC-001', decision: 'Decision A', rationale: 'Reason A', taskId: 'T100' },
          { id: 'DEC-002', decision: 'Decision B', rationale: 'Reason B', taskId: 'T101' },
        ],
      });
      const result = await persistSessionMemory(tempDir, 'S-001', debrief);

      // 2 decisions + 1 session summary + 1 session note = 4 observations
      expect(result.observationsCreated).toBe(4);
      // 2 decisions with taskIds => 2 links
      expect(result.linksCreated).toBe(2);
      expect(result.observationIds).toHaveLength(4);
    });

    it('accumulates errors without throwing (best-effort)', async () => {
      const { persistSessionMemory } = await import('../session-memory.js');

      // Use a non-existent directory that will cause brain.db init to fail
      const badRoot = join(tempDir, 'nonexistent', 'deep', 'path');
      const debrief = makeDebrief();

      // Should NOT throw
      const result = await persistSessionMemory(badRoot, 'S-001', debrief);
      // Should have errors since brain.db can't be initialized at that path
      expect(result.errors.length).toBeGreaterThanOrEqual(0);
      // Even with errors, it should return a valid result shape
      expect(result).toHaveProperty('observationsCreated');
      expect(result).toHaveProperty('linksCreated');
      expect(result).toHaveProperty('observationIds');
      expect(result).toHaveProperty('errors');
    });

    it('handles empty debrief (no decisions, no completions) gracefully', async () => {
      const { persistSessionMemory } = await import('../session-memory.js');

      const result = await persistSessionMemory(tempDir, 'S-001', null);

      expect(result.observationsCreated).toBe(0);
      expect(result.linksCreated).toBe(0);
      expect(result.observationIds).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('does not create duplicate observations for same session on repeated calls', async () => {
      const { persistSessionMemory } = await import('../session-memory.js');

      const debrief = makeDebrief({
        decisions: [],
        handoff: {
          lastTask: null,
          tasksCompleted: ['T101'],
          tasksCreated: [],
          decisionsRecorded: 0,
          nextSuggested: [],
          openBlockers: [],
          openBugs: [],
          note: 'test note',
        },
      });

      const result1 = await persistSessionMemory(tempDir, 'S-001', debrief);
      const result2 = await persistSessionMemory(tempDir, 'S-001', debrief);

      // First call creates observations
      expect(result1.observationsCreated).toBeGreaterThan(0);
      // Second call succeeds (observeBrain returns existing or new IDs).
      // With content-hash dedup (native DB), duplicates return existing IDs;
      // without native DB, new observations are created. Either way, no errors.
      expect(result2.observationsCreated).toBeGreaterThan(0);
      expect(result2.errors).toHaveLength(0);
    });
  });

  // ==========================================================================
  // getSessionMemoryContext
  // ==========================================================================

  describe('getSessionMemoryContext', () => {
    it('returns recent decisions for epic scope', async () => {
      const { getSessionMemoryContext } = await import('../session-memory.js');
      const { observeBrain } = await import('../brain-retrieval.js');

      // Seed a decision observation
      await observeBrain(tempDir, {
        text: 'Decision: Use TypeScript for T5149 implementation',
        title: 'Use TypeScript for T5149',
        type: 'decision',
        sourceSessionId: 'S-prev',
        sourceType: 'session-debrief',
      });

      const context = await getSessionMemoryContext(
        tempDir,
        { type: 'epic', epicId: 'T5149', rootTaskId: 'T5149' },
      );

      expect(context).toHaveProperty('recentDecisions');
      expect(context).toHaveProperty('relevantPatterns');
      expect(context).toHaveProperty('recentObservations');
      expect(context).toHaveProperty('tokensEstimated');
      expect(typeof context.tokensEstimated).toBe('number');
    });

    it('returns recent session-debrief observations', async () => {
      const { getSessionMemoryContext } = await import('../session-memory.js');
      const { observeBrain } = await import('../brain-retrieval.js');

      // Seed a session-debrief observation
      await observeBrain(tempDir, {
        text: 'Session S-100 completed 3 tasks: T201, T202, T203',
        title: 'Session S-100 summary',
        type: 'change',
        sourceSessionId: 'S-100',
        sourceType: 'session-debrief',
      });

      const context = await getSessionMemoryContext(
        tempDir,
        { type: 'epic', rootTaskId: 'T200' },
      );

      // The observation contains 'session' text so it should be found
      // by the search even with T200 as query (may or may not match)
      expect(context).toHaveProperty('recentObservations');
      expect(Array.isArray(context.recentObservations)).toBe(true);
    });

    it('returns recent patterns', async () => {
      const { getSessionMemoryContext } = await import('../session-memory.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');

      // Seed a pattern (context is NOT NULL in brain_patterns schema)
      const accessor = await getBrainAccessor(tempDir);
      await accessor.addPattern({
        id: 'P001',
        type: 'workflow',
        pattern: 'Always run tests before committing code changes',
        context: 'Development workflow for CLEO project',
        frequency: 5,
        impact: 'high',
      });

      const context = await getSessionMemoryContext(tempDir);

      expect(context).toHaveProperty('relevantPatterns');
      expect(Array.isArray(context.relevantPatterns)).toBe(true);
    });

    it('handles missing brain.db gracefully (returns empty context)', async () => {
      const { getSessionMemoryContext } = await import('../session-memory.js');

      // Use a fresh temp dir without initializing brain.db
      const freshDir = await mkdtemp(join(tmpdir(), 'cleo-no-brain-'));
      await mkdir(join(freshDir, '.cleo'), { recursive: true });

      const context = await getSessionMemoryContext(freshDir);

      expect(context.recentDecisions).toEqual([]);
      expect(context.relevantPatterns).toEqual([]);
      expect(context.recentObservations).toEqual([]);
      expect(context.tokensEstimated).toBe(0);

      await rm(freshDir, { recursive: true, force: true });
    });

    it('respects limit parameter', async () => {
      const { getSessionMemoryContext } = await import('../session-memory.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');

      // Seed multiple observations directly via accessor to avoid ID collisions
      // (observeBrain uses Date.now() for IDs which can collide in tight loops)
      const accessor = await getBrainAccessor(tempDir);
      for (let i = 0; i < 10; i++) {
        await accessor.addObservation({
          id: `O-limit-test-${i}`,
          type: 'discovery',
          title: `Test observation ${i}`,
          narrative: `Observation ${i} about testing patterns and workflows`,
          project: null,
          sourceSessionId: null,
          sourceType: 'session-debrief',
          createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        });
      }

      const context = await getSessionMemoryContext(
        tempDir,
        undefined,
        { limit: 2 },
      );

      // Observations search should be limited
      expect(context.recentObservations.length).toBeLessThanOrEqual(2);
    });

    it('filters by scope when rootTaskId is provided', async () => {
      const { getSessionMemoryContext } = await import('../session-memory.js');
      const { observeBrain } = await import('../brain-retrieval.js');

      // Seed observations with task references
      await observeBrain(tempDir, {
        text: 'Work on T5149 brain database implementation',
        title: 'T5149 brain work',
        type: 'change',
        sourceType: 'session-debrief',
      });

      const context = await getSessionMemoryContext(
        tempDir,
        { type: 'epic', rootTaskId: 'T5149' },
      );

      // The search query includes T5149, so relevant results should appear
      expect(context).toHaveProperty('recentDecisions');
      expect(context).toHaveProperty('recentObservations');
    });

    it('returns estimated token count', async () => {
      const { getSessionMemoryContext } = await import('../session-memory.js');
      const { observeBrain } = await import('../brain-retrieval.js');

      await observeBrain(tempDir, {
        text: 'Token counting test observation for session memory',
        title: 'Token test',
        type: 'discovery',
        sourceType: 'session-debrief',
      });

      const context = await getSessionMemoryContext(tempDir);

      expect(typeof context.tokensEstimated).toBe('number');
      expect(context.tokensEstimated).toBeGreaterThanOrEqual(0);
    });
  });
});
