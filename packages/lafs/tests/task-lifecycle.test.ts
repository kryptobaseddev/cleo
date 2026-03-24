/**
 * Tests for A2A Task Lifecycle (T099)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { TaskState, Message } from '@a2a-js/sdk';
import type { LAFSEnvelope } from '../src/types.js';
import {
  TERMINAL_STATES,
  INTERRUPTED_STATES,
  VALID_TRANSITIONS,
  isValidTransition,
  isTerminalState,
  isInterruptedState,
  InvalidStateTransitionError,
  TaskImmutabilityError,
  TaskNotFoundError,
  TaskRefinementError,
  TaskManager,
  attachLafsEnvelope,
} from '../src/a2a/task-lifecycle.js';

// ============================================================================
// Helper: create a Message object
// ============================================================================

function createMessage(role: 'user' | 'agent', text: string): Message {
  return {
    kind: 'message',
    messageId: `msg-${Date.now()}`,
    role,
    parts: [{ kind: 'text', text }],
  };
}

// ============================================================================
// State Constants
// ============================================================================

describe('State constants', () => {
  it('TERMINAL_STATES should contain exactly 4 states', () => {
    expect(TERMINAL_STATES.size).toBe(4);
    expect(TERMINAL_STATES.has('completed')).toBe(true);
    expect(TERMINAL_STATES.has('failed')).toBe(true);
    expect(TERMINAL_STATES.has('canceled')).toBe(true);
    expect(TERMINAL_STATES.has('rejected')).toBe(true);
  });

  it('TERMINAL_STATES should not contain non-terminal states', () => {
    expect(TERMINAL_STATES.has('submitted')).toBe(false);
    expect(TERMINAL_STATES.has('working')).toBe(false);
    expect(TERMINAL_STATES.has('input-required')).toBe(false);
    expect(TERMINAL_STATES.has('auth-required')).toBe(false);
  });

  it('INTERRUPTED_STATES should contain input-required and auth-required', () => {
    expect(INTERRUPTED_STATES.size).toBe(2);
    expect(INTERRUPTED_STATES.has('input-required')).toBe(true);
    expect(INTERRUPTED_STATES.has('auth-required')).toBe(true);
  });

  it('VALID_TRANSITIONS should have entries for all 9 states', () => {
    const allStates: TaskState[] = [
      'submitted', 'working', 'input-required', 'completed',
      'canceled', 'failed', 'rejected', 'auth-required', 'unknown',
    ];
    for (const state of allStates) {
      expect(VALID_TRANSITIONS.has(state)).toBe(true);
    }
  });

  it('terminal states should have empty outgoing sets', () => {
    for (const state of TERMINAL_STATES) {
      expect(VALID_TRANSITIONS.get(state)!.size).toBe(0);
    }
  });
});

// ============================================================================
// State Functions
// ============================================================================

describe('State functions', () => {
  describe('isValidTransition', () => {
    it('submitted -> working is valid', () => {
      expect(isValidTransition('submitted', 'working')).toBe(true);
    });

    it('working -> completed is valid', () => {
      expect(isValidTransition('working', 'completed')).toBe(true);
    });

    it('working -> input-required is valid', () => {
      expect(isValidTransition('working', 'input-required')).toBe(true);
    });

    it('input-required -> working is valid', () => {
      expect(isValidTransition('input-required', 'working')).toBe(true);
    });

    it('completed -> working is invalid (terminal)', () => {
      expect(isValidTransition('completed', 'working')).toBe(false);
    });

    it('submitted -> completed is invalid (must go through working)', () => {
      expect(isValidTransition('submitted', 'completed')).toBe(false);
    });

    it('auth-required -> working is valid', () => {
      expect(isValidTransition('auth-required', 'working')).toBe(true);
    });

    it('unknown -> any state is valid', () => {
      const states: TaskState[] = ['submitted', 'working', 'completed', 'failed', 'canceled'];
      for (const state of states) {
        expect(isValidTransition('unknown', state)).toBe(true);
      }
    });
  });

  describe('isTerminalState', () => {
    it('should return true for terminal states', () => {
      expect(isTerminalState('completed')).toBe(true);
      expect(isTerminalState('failed')).toBe(true);
      expect(isTerminalState('canceled')).toBe(true);
      expect(isTerminalState('rejected')).toBe(true);
    });

    it('should return false for non-terminal states', () => {
      expect(isTerminalState('submitted')).toBe(false);
      expect(isTerminalState('working')).toBe(false);
    });
  });

  describe('isInterruptedState', () => {
    it('should return true for interrupted states', () => {
      expect(isInterruptedState('input-required')).toBe(true);
      expect(isInterruptedState('auth-required')).toBe(true);
    });

    it('should return false for non-interrupted states', () => {
      expect(isInterruptedState('working')).toBe(false);
      expect(isInterruptedState('completed')).toBe(false);
    });
  });
});

// ============================================================================
// TaskManager
// ============================================================================

describe('TaskManager', () => {
  let manager: TaskManager;

  beforeEach(() => {
    manager = new TaskManager();
  });

  describe('createTask', () => {
    it('should create task with generated id and contextId', () => {
      const task = manager.createTask();
      expect(task.id).toBeDefined();
      expect(task.contextId).toBeDefined();
      expect(task.kind).toBe('task');
      expect(task.status.state).toBe('submitted');
    });

    it('should use provided contextId', () => {
      const task = manager.createTask({ contextId: 'ctx-123' });
      expect(task.contextId).toBe('ctx-123');
    });

    it('should include metadata when provided', () => {
      const task = manager.createTask({ metadata: { key: 'value' } });
      expect(task.metadata).toEqual({ key: 'value' });
    });

    it('should include timestamp in status', () => {
      const task = manager.createTask();
      expect(task.status.timestamp).toBeDefined();
    });

    it('should create refinement task with referenceTaskIds metadata', () => {
      const base = manager.createTask({ contextId: 'ctx-ref' });
      const refined = manager.createTask({
        contextId: 'ctx-ref',
        referenceTaskIds: [base.id],
      });
      expect(refined.metadata).toBeDefined();
      expect(refined.metadata?.['referenceTaskIds']).toEqual([base.id]);
    });

    it('should infer contextId from referenced task when omitted', () => {
      const base = manager.createTask({ contextId: 'ctx-derived' });
      const refined = manager.createTask({ referenceTaskIds: [base.id] });
      expect(refined.contextId).toBe('ctx-derived');
    });

    it('should throw TaskRefinementError for unknown reference task', () => {
      expect(() => manager.createTask({ referenceTaskIds: ['missing-task'] })).toThrow(
        TaskRefinementError
      );
    });

    it('should throw TaskRefinementError for cross-context reference', () => {
      const base = manager.createTask({ contextId: 'ctx-a' });
      expect(() =>
        manager.createTask({
          contextId: 'ctx-b',
          referenceTaskIds: [base.id],
        })
      ).toThrow(TaskRefinementError);
    });
  });

  describe('createRefinedTask', () => {
    it('should create task referencing parent tasks', () => {
      const parentA = manager.createTask({ contextId: 'ctx-parent' });
      const parentB = manager.createTask({ contextId: 'ctx-parent' });

      const refined = manager.createRefinedTask([parentA.id, parentB.id], {
        parallelFollowUp: true,
      });

      expect(refined.contextId).toBe('ctx-parent');
      expect(refined.metadata?.['referenceTaskIds']).toEqual([parentA.id, parentB.id]);
      expect(refined.metadata?.['parallelFollowUp']).toBe(true);
    });
  });

  describe('getTask', () => {
    it('should return task by id', () => {
      const created = manager.createTask();
      const fetched = manager.getTask(created.id);
      expect(fetched.id).toBe(created.id);
    });

    it('should throw TaskNotFoundError for unknown id', () => {
      expect(() => manager.getTask('nonexistent')).toThrow(TaskNotFoundError);
    });

    it('should return a clone (not reference)', () => {
      const created = manager.createTask();
      const fetched = manager.getTask(created.id);
      expect(fetched).not.toBe(created);
      expect(fetched).toEqual(created);
    });
  });

  describe('updateTaskStatus', () => {
    it('should transition submitted -> working', () => {
      const task = manager.createTask();
      const updated = manager.updateTaskStatus(task.id, 'working');
      expect(updated.status.state).toBe('working');
    });

    it('should include message in status when provided', () => {
      const task = manager.createTask();
      const message = createMessage('agent', 'Processing...');
      const updated = manager.updateTaskStatus(task.id, 'working', message);
      expect(updated.status.message).toBeDefined();
      expect(updated.status.message?.parts[0]).toEqual({
        kind: 'text',
        text: 'Processing...',
      });
    });

    it('should throw InvalidStateTransitionError for invalid transition', () => {
      const task = manager.createTask();
      expect(() => manager.updateTaskStatus(task.id, 'completed')).toThrow(
        InvalidStateTransitionError
      );
    });

    it('should throw TaskImmutabilityError for terminal state', () => {
      const task = manager.createTask();
      manager.updateTaskStatus(task.id, 'working');
      manager.updateTaskStatus(task.id, 'completed');
      expect(() => manager.updateTaskStatus(task.id, 'working')).toThrow(
        TaskImmutabilityError
      );
    });

    it('should throw TaskNotFoundError for unknown task', () => {
      expect(() => manager.updateTaskStatus('nonexistent', 'working')).toThrow(
        TaskNotFoundError
      );
    });
  });

  describe('addArtifact', () => {
    it('should add artifact to working task', () => {
      const task = manager.createTask();
      manager.updateTaskStatus(task.id, 'working');

      const updated = manager.addArtifact(task.id, {
        artifactId: 'art-1',
        parts: [{ kind: 'text', text: 'result' }],
      });

      expect(updated.artifacts).toHaveLength(1);
      expect(updated.artifacts![0]!.artifactId).toBe('art-1');
    });

    it('should throw TaskImmutabilityError for completed task', () => {
      const task = manager.createTask();
      manager.updateTaskStatus(task.id, 'working');
      manager.updateTaskStatus(task.id, 'completed');

      expect(() =>
        manager.addArtifact(task.id, {
          artifactId: 'art-1',
          parts: [{ kind: 'text', text: 'result' }],
        })
      ).toThrow(TaskImmutabilityError);
    });
  });

  describe('addHistory', () => {
    it('should add message to task history', () => {
      const task = manager.createTask();
      manager.updateTaskStatus(task.id, 'working');

      const msg = createMessage('user', 'Hello');
      const updated = manager.addHistory(task.id, msg);

      expect(updated.history).toHaveLength(1);
      expect(updated.history![0]!.role).toBe('user');
    });

    it('should throw TaskImmutabilityError for terminal task', () => {
      const task = manager.createTask();
      manager.updateTaskStatus(task.id, 'rejected');

      expect(() => manager.addHistory(task.id, createMessage('user', 'Hello'))).toThrow(
        TaskImmutabilityError
      );
    });
  });

  describe('cancelTask', () => {
    it('should transition to canceled', () => {
      const task = manager.createTask();
      const canceled = manager.cancelTask(task.id);
      expect(canceled.status.state).toBe('canceled');
    });

    it('should throw for already completed task', () => {
      const task = manager.createTask();
      manager.updateTaskStatus(task.id, 'working');
      manager.updateTaskStatus(task.id, 'completed');
      expect(() => manager.cancelTask(task.id)).toThrow(TaskImmutabilityError);
    });
  });

  describe('getTasksByContext', () => {
    it('should return tasks grouped by contextId', () => {
      const t1 = manager.createTask({ contextId: 'ctx-A' });
      manager.createTask({ contextId: 'ctx-A' });
      manager.createTask({ contextId: 'ctx-B' });

      const ctxATasks = manager.getTasksByContext('ctx-A');
      expect(ctxATasks).toHaveLength(2);
      expect(ctxATasks.every(t => t.contextId === 'ctx-A')).toBe(true);
    });

    it('should return empty array for unknown context', () => {
      expect(manager.getTasksByContext('unknown')).toEqual([]);
    });
  });

  describe('listTasks', () => {
    it('should list all tasks', () => {
      manager.createTask();
      manager.createTask();
      manager.createTask();

      const result = manager.listTasks();
      expect(result.tasks).toHaveLength(3);
    });

    it('should filter by contextId', () => {
      manager.createTask({ contextId: 'ctx-A' });
      manager.createTask({ contextId: 'ctx-A' });
      manager.createTask({ contextId: 'ctx-B' });

      const result = manager.listTasks({ contextId: 'ctx-A' });
      expect(result.tasks).toHaveLength(2);
    });

    it('should filter by state', () => {
      const t1 = manager.createTask();
      const t2 = manager.createTask();
      manager.createTask();
      manager.updateTaskStatus(t1.id, 'working');
      manager.updateTaskStatus(t2.id, 'working');

      const result = manager.listTasks({ state: 'working' });
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks.every(t => t.status.state === 'working')).toBe(true);
    });

    it('should paginate with limit and pageToken', () => {
      for (let i = 0; i < 5; i++) {
        manager.createTask();
      }

      const page1 = manager.listTasks({ limit: 2 });
      expect(page1.tasks).toHaveLength(2);
      expect(page1.nextPageToken).toBeDefined();

      const page2 = manager.listTasks({ limit: 2, pageToken: page1.nextPageToken });
      expect(page2.tasks).toHaveLength(2);
      expect(page2.nextPageToken).toBeDefined();

      const page3 = manager.listTasks({ limit: 2, pageToken: page2.nextPageToken });
      expect(page3.tasks).toHaveLength(1);
      expect(page3.nextPageToken).toBeUndefined();
    });
  });

  describe('isTerminal', () => {
    it('should return true for completed task', () => {
      const task = manager.createTask();
      manager.updateTaskStatus(task.id, 'working');
      manager.updateTaskStatus(task.id, 'completed');
      expect(manager.isTerminal(task.id)).toBe(true);
    });

    it('should return false for working task', () => {
      const task = manager.createTask();
      manager.updateTaskStatus(task.id, 'working');
      expect(manager.isTerminal(task.id)).toBe(false);
    });
  });
});

// ============================================================================
// attachLafsEnvelope
// ============================================================================

describe('attachLafsEnvelope', () => {
  it('should create a LAFS artifact and add it to the task', () => {
    const manager = new TaskManager();
    const task = manager.createTask();
    manager.updateTaskStatus(task.id, 'working');

    const envelope: LAFSEnvelope = {
      $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
      _meta: {
        specVersion: '1.2.3',
        schemaVersion: '1.0.0',
        timestamp: new Date().toISOString(),
        operation: 'test.run',
        requestId: 'req-001',
        transport: 'http',
        strict: true,
        mvi: 'minimal',
        contextVersion: 1,
      },
      success: true,
      result: { data: 'test' },
    };

    const updated = attachLafsEnvelope(manager, task.id, envelope);
    expect(updated.artifacts).toHaveLength(1);

    const artifact = updated.artifacts![0]!;
    expect(artifact.name).toBe('lafs_response');
    expect(artifact.parts[0]!.kind).toBe('data');
    expect(artifact.metadata!['x-lafs-version']).toBe('2.0.0');
  });
});
