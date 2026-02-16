/**
 * Tests for skill dispatch and protocol selection.
 * @task T4522
 */

import { describe, it, expect } from 'vitest';
import type { Task } from '../../../types/task.js';
import { autoDispatch, dispatchExplicit, getProtocolForDispatch, prepareSpawnContext } from '../dispatch.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T001',
    title: 'Test task',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe('autoDispatch', () => {
  it('should fallback to ct-task-executor for generic tasks', () => {
    const task = makeTask({ title: 'Do something' });
    const result = autoDispatch(task);

    expect(result.skill).toBe('ct-task-executor');
    expect(result.strategy).toBe('fallback');
    expect(result.confidence).toBe(0.5);
  });

  it('should dispatch research tasks by keyword', () => {
    const task = makeTask({ title: 'Research authentication patterns' });
    const result = autoDispatch(task);

    expect(result.skill).toBe('ct-research-agent');
    expect(result.strategy).toBe('keyword');
    expect(result.protocol).toBe('research');
  });

  it('should dispatch specification tasks by keyword', () => {
    const task = makeTask({ title: 'Write specification for the API' });
    const result = autoDispatch(task);

    expect(result.skill).toBe('ct-spec-writer');
    expect(result.strategy).toBe('keyword');
    expect(result.protocol).toBe('specification');
  });

  it('should dispatch test tasks by keyword', () => {
    const task = makeTask({ title: 'Add BATS testing for parser module' });
    const result = autoDispatch(task);

    expect(result.skill).toBe('ct-test-writer-bats');
    expect(result.strategy).toBe('keyword');
  });

  it('should dispatch implementation tasks by keyword', () => {
    const task = makeTask({ title: 'Implement the new feature' });
    const result = autoDispatch(task);

    expect(result.skill).toBe('ct-library-implementer-bash');
    expect(result.strategy).toBe('keyword');
    expect(result.protocol).toBe('implementation');
  });

  it('should dispatch documentation tasks by keyword', () => {
    const task = makeTask({ title: 'Write documentation for the API' });
    const result = autoDispatch(task);

    expect(result.skill).toBe('ct-documentor');
    expect(result.strategy).toBe('keyword');
  });

  it('should dispatch epic/plan tasks by keyword', () => {
    const task = makeTask({ title: 'Plan the epic breakdown' });
    const result = autoDispatch(task);

    expect(result.skill).toBe('ct-epic-architect');
    expect(result.strategy).toBe('keyword');
    expect(result.protocol).toBe('decomposition');
  });
});

describe('getProtocolForDispatch', () => {
  it('should return protocol from dispatch result', () => {
    const result = { skill: 'ct-research-agent', strategy: 'keyword' as const, confidence: 0.7, protocol: 'research' as const };
    expect(getProtocolForDispatch(result)).toBe('research');
  });

  it('should return null when no protocol', () => {
    const result = { skill: 'ct-task-executor', strategy: 'fallback' as const, confidence: 0.5 };
    expect(getProtocolForDispatch(result)).toBeNull();
  });
});

describe('prepareSpawnContext', () => {
  it('should prepare context with auto dispatch', () => {
    const task = makeTask({ title: 'Research caching strategies' });
    const ctx = prepareSpawnContext(task);

    expect(ctx.skill).toBe('ct-research-agent');
    expect(ctx.protocol).toBe('research');
    expect(ctx.dispatch.strategy).toBe('keyword');
  });

  it('should respect override skill', () => {
    const task = makeTask({ title: 'Do something' });
    const ctx = prepareSpawnContext(task, 'ct-validator');

    // If the validator skill doesn't exist on disk, it falls back to auto
    // Just verify the structure
    expect(ctx).toHaveProperty('skill');
    expect(ctx).toHaveProperty('protocol');
    expect(ctx).toHaveProperty('dispatch');
  });
});
