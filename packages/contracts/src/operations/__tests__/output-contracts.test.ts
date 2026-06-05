/**
 * Tests for the per-operation OUTPUT contract SSoT (T11692 / DHQ-057).
 *
 * Pins the proof-set of OUTPUT contracts and — critically — encodes the exact
 * shape fact that produced the bug: `tasks.show` returns the task under `task`,
 * so the canonical pointer is `/data/task/title`, NOT `/data/title`.
 *
 * Also validates that mutation contracts reflect the MinimalMutateEnvelope
 * shape (string[] ids, NOT object arrays) and that tasks.find uses the
 * { results, total } wrapper (NOT a bare array).
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

    it('notes that view may be null', () => {
      expect(show.shapeNote).toContain('null');
    });
  });

  describe('mutation envelopes — MinimalMutateEnvelope (string[] ids, T9931)', () => {
    it('tasks.add surfaces the created task ID as a bare string at /data/created/0', () => {
      const add = OUTPUT_CONTRACTS['tasks.add'] as OperationOutputContract;
      // Correct: /data/created/0 → "T11692" (string), NOT /data/created/0/id
      expect(add.fieldPointers).toContain('/data/created/0');
      expect(add.fieldPointers).not.toContain('/data/created/0/id');
      // Schema must reflect string[] items, not object[]
      const schema = add.dataSchema as {
        required?: string[];
        properties?: Record<string, { items?: { type?: string } }>;
      };
      expect(schema.required).toEqual(
        expect.arrayContaining(['count', 'created', 'updated', 'deleted']),
      );
      expect(schema.properties?.created?.items?.type).toBe('string');
      expect(schema.properties?.updated?.items?.type).toBe('string');
      expect(schema.properties?.deleted?.items?.type).toBe('string');
    });

    it('tasks.update / tasks.complete surface the changed task ID at /data/updated/0 (string)', () => {
      for (const op of ['tasks.update', 'tasks.complete']) {
        const c = OUTPUT_CONTRACTS[op] as OperationOutputContract;
        // Correct: /data/updated/0 → "T11692" (string), NOT /data/updated/0/id
        expect(c.fieldPointers).toContain('/data/updated/0');
        expect(c.fieldPointers).not.toContain('/data/updated/0/id');
        const schema = c.dataSchema as {
          properties?: Record<string, { items?: { type?: string } }>;
        };
        expect(schema.properties?.updated?.items?.type).toBe('string');
      }
    });

    it('tasks.add-batch dry-run pointers point to root /data/wouldCreate and /data/insertedCount', () => {
      const batch = OUTPUT_CONTRACTS['tasks.add-batch'] as OperationOutputContract;
      // Correct: root-level, NOT /data/dryRunSummary/wouldCreate
      expect(batch.fieldPointers).toContain('/data/wouldCreate');
      expect(batch.fieldPointers).toContain('/data/insertedCount');
      expect(batch.fieldPointers).not.toContain('/data/dryRunSummary/wouldCreate');
      expect(batch.fieldPointers).not.toContain('/data/dryRunSummary/insertedCount');
      // shapeNote should clarify they are NOT under dryRunSummary
      expect(batch.shapeNote).toContain('/data/wouldCreate');
    });
  });

  it('tasks.find data is a wrapper object with /data/results (array) and /data/total', () => {
    const find = OUTPUT_CONTRACTS['tasks.find'] as OperationOutputContract;
    // Correct: wrapper object, NOT a bare array
    expect((find.dataSchema as { type?: string }).type).toBe('object');
    // Correct pointers
    expect(find.fieldPointers).toContain('/data/results/0/id');
    expect(find.fieldPointers).toContain('/data/total');
    // Wrong pointers must NOT appear
    expect(find.fieldPointers).not.toContain('/data/0/id');
    expect(find.shapeNote).toContain('/data/results');
  });
});
