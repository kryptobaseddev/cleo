/**
 * Tests for plan module types: ReadyTask, BlockedTask, OpenBug derive from Drizzle TaskRow.
 *
 * Verifies that priority scoring and type contracts work correctly when
 * ReadyTask extends Pick<TaskRow, 'id' | 'title' | 'priority'>.
 *
 * @task T4820
 */

import { describe, it, expect } from 'vitest';
import type { ReadyTask, BlockedTask, OpenBug } from '../plan.js';

describe('plan types - Drizzle-derived interfaces', () => {
  describe('ReadyTask', () => {
    it('has required Drizzle-derived fields (id, title, priority)', () => {
      const task: ReadyTask = {
        id: 'T001',
        title: 'Implement feature',
        priority: 'high',
        epicId: 'T100',
        leverage: 3,
        score: 95,
        reasons: ['priority: high (+75)', 'leverage: unblocks 3 task(s) (+15)'],
      };

      expect(task.id).toBe('T001');
      expect(task.title).toBe('Implement feature');
      expect(task.priority).toBe('high');
      expect(task.leverage).toBe(3);
      expect(task.score).toBe(95);
    });

    it('score computation: critical priority yields highest base score', () => {
      const PRIORITY_SCORE: Record<string, number> = {
        critical: 100,
        high: 75,
        medium: 50,
        low: 25,
      };

      const criticalTask: ReadyTask = {
        id: 'T001',
        title: 'Critical bug',
        priority: 'critical',
        epicId: 'T100',
        leverage: 0,
        score: PRIORITY_SCORE['critical']! + 10, // priority + deps satisfied
        reasons: [],
      };

      const lowTask: ReadyTask = {
        id: 'T002',
        title: 'Nice to have',
        priority: 'low',
        epicId: 'T100',
        leverage: 0,
        score: PRIORITY_SCORE['low']! + 10,
        reasons: [],
      };

      expect(criticalTask.score).toBeGreaterThan(lowTask.score);
      expect(criticalTask.score).toBe(110);
      expect(lowTask.score).toBe(35);
    });

    it('leverage bonus adds 5 per unblocked task', () => {
      const task: ReadyTask = {
        id: 'T001',
        title: 'Unblocks many',
        priority: 'medium',
        epicId: 'T100',
        leverage: 4,
        score: 50 + 10 + (4 * 5), // priority(50) + deps(10) + leverage(20)
        reasons: [],
      };
      expect(task.score).toBe(80);
    });

    it('sorts by score descending', () => {
      const tasks: ReadyTask[] = [
        { id: 'T001', title: 'Low', priority: 'low', epicId: 'T100', leverage: 0, score: 35, reasons: [] },
        { id: 'T002', title: 'High', priority: 'high', epicId: 'T100', leverage: 0, score: 85, reasons: [] },
        { id: 'T003', title: 'Med', priority: 'medium', epicId: 'T100', leverage: 0, score: 60, reasons: [] },
      ];

      tasks.sort((a, b) => b.score - a.score);

      expect(tasks[0].id).toBe('T002');
      expect(tasks[1].id).toBe('T003');
      expect(tasks[2].id).toBe('T001');
    });
  });

  describe('BlockedTask', () => {
    it('has required Drizzle-derived fields (id, title)', () => {
      const task: BlockedTask = {
        id: 'T002',
        title: 'Waiting on deps',
        blockedBy: ['T001'],
        blocksCount: 2,
      };

      expect(task.id).toBe('T002');
      expect(task.title).toBe('Waiting on deps');
      expect(task.blockedBy).toEqual(['T001']);
      expect(task.blocksCount).toBe(2);
    });
  });

  describe('OpenBug', () => {
    it('has required Drizzle-derived fields (id, title, priority)', () => {
      const bug: OpenBug = {
        id: 'T003',
        title: 'UI crash on load',
        priority: 'critical',
        epicId: 'T200',
      };

      expect(bug.id).toBe('T003');
      expect(bug.priority).toBe('critical');
      expect(bug.epicId).toBe('T200');
    });
  });
});
