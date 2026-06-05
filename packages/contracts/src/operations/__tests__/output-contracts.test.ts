/**
 * Tests for the per-operation OUTPUT contract SSoT (T11692 / DHQ-057).
 *
 * Pins the proof-set of OUTPUT contracts and — critically — encodes the exact
 * shape fact that produced the bug: `tasks.show` returns the task under `task`,
 * so the canonical pointer is `/data/task/title`, NOT `/data/title`.
 *
 * @task T11692
 * @epic T11679
 */

import { describe, expect, it } from 'vitest';
import type { OperationOutputContract } from '../output-contract.js';
import { OUTPUT_CONTRACTS } from '../output-contracts-data.js';

describe('operations/output-contracts (T11692 · DHQ-057)', () => {
  it('registers the high-traffic proof-set operations', () => {
    for (const op of [
      'tasks.show',
      'tasks.list',
      'tasks.find',
      'tasks.add',
      'tasks.add-batch',
      'tasks.update',
      'tasks.complete',
    ]) {
      expect(OUTPUT_CONTRACTS[op], `missing output contract for ${op}`).toBeDefined();
    }
  });

  it('keys every entry by its own operation id', () => {
    for (const [key, contract] of Object.entries(OUTPUT_CONTRACTS)) {
      expect(contract.operation).toBe(key);
    }
  });

  describe('tasks.show — the operation that bit us', () => {
    const show = OUTPUT_CONTRACTS['tasks.show'] as OperationOutputContract;

    it('encodes that the task is nested under `task` (data schema)', () => {
      const schema = show.dataSchema as {
        required?: string[];
        properties?: Record<string, { properties?: Record<string, unknown> }>;
      };
      expect(schema.required).toContain('task');
      // The title lives under task.properties.title — NOT at the data root.
      expect(schema.properties?.task?.properties).toHaveProperty('title');
      expect(schema.properties).not.toHaveProperty('title');
    });

    it('lists /data/task/title as a valid --field pointer and NOT /data/title', () => {
      expect(show.fieldPointers).toContain('/data/task/title');
      expect(show.fieldPointers).not.toContain('/data/title');
    });

    it('carries a shapeNote steering agents away from /data/<field>', () => {
      expect(show.shapeNote).toBeTruthy();
      expect(show.shapeNote).toContain('/data/task/');
    });
  });

  describe('mutation envelopes (T9931 / T10608 reference pattern)', () => {
    it('tasks.add surfaces the created id at /data/created/0/id', () => {
      const add = OUTPUT_CONTRACTS['tasks.add'] as OperationOutputContract;
      expect(add.fieldPointers).toContain('/data/created/0/id');
      const schema = add.dataSchema as { required?: string[] };
      expect(schema.required).toEqual(
        expect.arrayContaining(['created', 'updated', 'deleted', 'affectedCount']),
      );
    });

    it('tasks.update / tasks.complete surface the changed task at /data/updated/0', () => {
      for (const op of ['tasks.update', 'tasks.complete']) {
        const c = OUTPUT_CONTRACTS[op] as OperationOutputContract;
        expect(c.fieldPointers).toContain('/data/updated/0/id');
      }
    });
  });

  it('tasks.find data IS the array (pointers index /data/0, not /data/tasks)', () => {
    const find = OUTPUT_CONTRACTS['tasks.find'] as OperationOutputContract;
    expect((find.dataSchema as { type?: string }).type).toBe('array');
    expect(find.fieldPointers).toContain('/data/0/id');
  });
});
