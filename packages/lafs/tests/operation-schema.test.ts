/**
 * Tests for describeOperation() in packages/lafs/src/discovery.ts
 *
 * Validates that the LAFS operation introspection function correctly maps
 * registry OperationDef entries to OperationSchema output.
 *
 * @task T340
 * @epic T335
 */

import { describe, expect, it } from 'vitest';
import { describeOperation } from '../src/discovery.js';
import type { RegistryOperationDef } from '../src/discovery.js';

// ---------------------------------------------------------------------------
// Minimal stubs that satisfy RegistryOperationDef
// ---------------------------------------------------------------------------

const tasksAddDef: RegistryOperationDef = {
  gateway: 'mutate',
  domain: 'tasks',
  operation: 'add',
  description: 'tasks.add (mutate)',
  requiredParams: ['title'],
  // No params array — should fall back to STATIC_PARAMS_TABLE
};

const tasksCompleteDef: RegistryOperationDef = {
  gateway: 'mutate',
  domain: 'tasks',
  operation: 'complete',
  description: 'tasks.complete (mutate)',
  requiredParams: ['taskId'],
};

const tasksShowDef: RegistryOperationDef = {
  gateway: 'query',
  domain: 'tasks',
  operation: 'show',
  description: 'tasks.show (query)',
  requiredParams: ['taskId'],
};

const unknownDef: RegistryOperationDef = {
  gateway: 'query',
  domain: 'session',
  operation: 'status',
  description: 'session.status (query)',
  requiredParams: [],
};

const defWithFullParams: RegistryOperationDef = {
  gateway: 'query',
  domain: 'tasks',
  operation: 'list',
  description: 'tasks.list (query)',
  requiredParams: [],
  params: [
    { name: 'parent', type: 'string', required: false, description: 'Filter by parent task ID' },
    {
      name: 'status',
      type: 'string',
      required: false,
      description: 'Filter by task status',
      enum: ['pending', 'active', 'done', 'blocked', 'cancelled'] as const,
    },
    {
      name: 'limit',
      type: 'number',
      required: false,
      description: 'Maximum number of tasks to return',
      hidden: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// describeOperation tests
// ---------------------------------------------------------------------------

describe('describeOperation()', () => {
  // -------------------------------------------------------------------------
  // Basic structure
  // -------------------------------------------------------------------------

  it('returns correct operation key for tasks.add', () => {
    const schema = describeOperation(tasksAddDef);
    expect(schema.operation).toBe('tasks.add');
  });

  it('returns correct gateway for mutate operation', () => {
    const schema = describeOperation(tasksAddDef);
    expect(schema.gateway).toBe('mutate');
  });

  it('returns correct gateway for query operation', () => {
    const schema = describeOperation(tasksShowDef);
    expect(schema.gateway).toBe('query');
  });

  it('returns description verbatim', () => {
    const schema = describeOperation(tasksAddDef);
    expect(schema.description).toBe('tasks.add (mutate)');
  });

  // -------------------------------------------------------------------------
  // Param resolution — static table fallback
  // -------------------------------------------------------------------------

  it('tasks.add: falls back to static params table when def.params is absent', () => {
    const schema = describeOperation(tasksAddDef);
    expect(schema.params.length).toBeGreaterThan(0);
  });

  it('tasks.add: params include title, parent, priority, type, size, description, acceptance', () => {
    const schema = describeOperation(tasksAddDef);
    const names = schema.params.map((p) => p.name);
    for (const expected of ['title', 'parent', 'priority', 'type', 'size', 'description', 'acceptance']) {
      expect(names).toContain(expected);
    }
  });

  it('tasks.add: priority param has enum [low, medium, high, critical]', () => {
    const schema = describeOperation(tasksAddDef);
    const priority = schema.params.find((p) => p.name === 'priority');
    expect(priority?.enum).toEqual(['low', 'medium', 'high', 'critical']);
  });

  it('tasks.add: title param is required', () => {
    const schema = describeOperation(tasksAddDef);
    const title = schema.params.find((p) => p.name === 'title');
    expect(title?.required).toBe(true);
  });

  it('tasks.add: parent param is optional', () => {
    const schema = describeOperation(tasksAddDef);
    const parent = schema.params.find((p) => p.name === 'parent');
    expect(parent?.required).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Param resolution — registry params take precedence
  // -------------------------------------------------------------------------

  it('uses registry params when present (tasks.list)', () => {
    const schema = describeOperation(defWithFullParams);
    const names = schema.params.map((p) => p.name);
    expect(names).toContain('parent');
    expect(names).toContain('status');
  });

  it('strips hidden params from output', () => {
    const schema = describeOperation(defWithFullParams);
    const names = schema.params.map((p) => p.name);
    // `limit` is marked hidden in the test def — should not appear
    expect(names).not.toContain('limit');
  });

  it('preserves enum on status param from registry', () => {
    const schema = describeOperation(defWithFullParams);
    const status = schema.params.find((p) => p.name === 'status');
    expect(status?.enum).toContain('pending');
    expect(status?.enum).toContain('done');
  });

  // -------------------------------------------------------------------------
  // Gates — includeGates=true (default)
  // -------------------------------------------------------------------------

  it('includes gates by default (includeGates=true)', () => {
    const schema = describeOperation(tasksAddDef);
    expect(schema.gates).toBeDefined();
  });

  it('tasks.add gates include anti-hallucination', () => {
    const schema = describeOperation(tasksAddDef);
    const gateNames = (schema.gates ?? []).map((g) => g.name);
    expect(gateNames).toContain('anti-hallucination');
  });

  it('tasks.add gates include acceptance-criteria-format', () => {
    const schema = describeOperation(tasksAddDef);
    const gateNames = (schema.gates ?? []).map((g) => g.name);
    expect(gateNames).toContain('acceptance-criteria-format');
  });

  it('tasks.complete gates include dependency-check', () => {
    const schema = describeOperation(tasksCompleteDef);
    const gateNames = (schema.gates ?? []).map((g) => g.name);
    expect(gateNames).toContain('dependency-check');
  });

  it('tasks.complete gates include verification-required', () => {
    const schema = describeOperation(tasksCompleteDef);
    const gateNames = (schema.gates ?? []).map((g) => g.name);
    expect(gateNames).toContain('verification-required');
  });

  it('tasks.complete gates include children-completion', () => {
    const schema = describeOperation(tasksCompleteDef);
    const gateNames = (schema.gates ?? []).map((g) => g.name);
    expect(gateNames).toContain('children-completion');
  });

  it('tasks.show gate is task-exists', () => {
    const schema = describeOperation(tasksShowDef);
    const gateNames = (schema.gates ?? []).map((g) => g.name);
    expect(gateNames).toContain('task-exists');
  });

  it('unknown operation returns empty gates array', () => {
    const schema = describeOperation(unknownDef);
    expect(schema.gates).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Gates — includeGates=false
  // -------------------------------------------------------------------------

  it('omits gates when includeGates=false', () => {
    const schema = describeOperation(tasksAddDef, { includeGates: false });
    expect(schema.gates).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Examples — includeExamples=false (default)
  // -------------------------------------------------------------------------

  it('omits examples by default', () => {
    const schema = describeOperation(tasksAddDef);
    expect(schema.examples).toBeUndefined();
  });

  it('includes examples when includeExamples=true for tasks.add', () => {
    const schema = describeOperation(tasksAddDef, { includeExamples: true });
    expect(schema.examples).toBeDefined();
    expect((schema.examples ?? []).length).toBeGreaterThan(0);
  });

  it('examples for unknown operation are empty array when includeExamples=true', () => {
    const schema = describeOperation(unknownDef, { includeExamples: true });
    expect(schema.examples).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Gate shape integrity
  // -------------------------------------------------------------------------

  it('each gate has name, errorCode, description, and triggers', () => {
    const schema = describeOperation(tasksAddDef);
    for (const gate of schema.gates ?? []) {
      expect(typeof gate.name).toBe('string');
      expect(gate.name.length).toBeGreaterThan(0);
      expect(typeof gate.errorCode).toBe('string');
      expect(gate.errorCode.startsWith('E_')).toBe(true);
      expect(typeof gate.description).toBe('string');
      expect(Array.isArray(gate.triggers)).toBe(true);
      expect(gate.triggers.length).toBeGreaterThan(0);
    }
  });
});
