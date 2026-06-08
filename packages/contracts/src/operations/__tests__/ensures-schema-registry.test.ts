/**
 * Tests for the ensures-schema Zod registry (T11762 ST-1 · T11900).
 *
 * Behavior-parity guard: every input the deleted bespoke validators
 * (`validateDecompositionTaskTree` / `validateIvtrEvidenceOutput`,
 * `packages/playbooks/src/runtime.ts:794-902`) REJECTED must still be rejected
 * here, with the FIRST Zod issue message equal to the SUFFIX of the original
 * violation string (the part after the `ensures.schema[<name>] on <nodeId>: `
 * prefix that ST-2's runtime wrapper re-applies). Every input they ACCEPTED must
 * still parse. The ACs call out: empty array, missing title, empty acceptance,
 * `{}` evidence, numeric evidence.
 *
 * @task T11900
 * @epic T11762
 */

import { describe, expect, it } from 'vitest';
import {
  ENSURES_SCHEMA_REGISTRY,
  type EnsuresSchemaSpec,
  evidenceSchema,
  LEGACY_PASSTHROUGH_SCHEMA_NAMES,
  passthroughSchema,
  taskTreeSchema,
} from '../ensures-schema-registry.js';

/** First Zod issue message for a failing parse (or `undefined` if it parsed). */
function firstIssueMessage(schema: typeof taskTreeSchema, value: unknown): string | undefined {
  const result = schema.safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

describe('ensures-schema-registry — registry DATA', () => {
  it('registers the two strict schemas plus every legacy passthrough name', () => {
    // T11762 ST-2 (R1): the two strict ports (`task_tree`, `evidence`) PLUS the
    // legacy starter `.cantbook` schema names — registered with passthrough so
    // the fail-closed flip does not regress the shipped playbooks.
    expect([...ENSURES_SCHEMA_REGISTRY.keys()].sort()).toEqual(
      ['task_tree', 'evidence', ...LEGACY_PASSTHROUGH_SCHEMA_NAMES].sort(),
    );
  });

  it('each strict spec carries name, contextKey (= name by default), and a schema', () => {
    for (const name of ['task_tree', 'evidence'] as const) {
      const spec = ENSURES_SCHEMA_REGISTRY.get(name) as EnsuresSchemaSpec;
      expect(spec).toBeDefined();
      expect(spec.name).toBe(name);
      expect(spec.contextKey).toBe(name);
      expect(typeof spec.schema.safeParse).toBe('function');
    }
  });

  it('every legacy passthrough name is registered with the passthrough schema', () => {
    // R1: passthrough accepts ANY value (including `undefined`) so the historical
    // "silently skipped" behavior is preserved EXACTLY.
    for (const name of LEGACY_PASSTHROUGH_SCHEMA_NAMES) {
      const spec = ENSURES_SCHEMA_REGISTRY.get(name) as EnsuresSchemaSpec;
      expect(spec).toBeDefined();
      expect(spec.name).toBe(name);
      expect(spec.schema).toBe(passthroughSchema);
      expect(spec.schema.safeParse(undefined).success).toBe(true);
      expect(spec.schema.safeParse({ anything: 1 }).success).toBe(true);
      expect(spec.schema.safeParse(42).success).toBe(true);
    }
  });
});

describe('ensures-schema-registry — task_tree (ports validateDecompositionTaskTree)', () => {
  it('accepts a minimal valid task tree', () => {
    expect(taskTreeSchema.safeParse([{ title: 'Build X', acceptance: ['does X'] }]).success).toBe(
      true,
    );
  });

  it('accepts a tree with optional id/parentId/depends populated', () => {
    expect(
      taskTreeSchema.safeParse([
        { title: 'Root', acceptance: ['ac1'], id: 'T1' },
        { title: 'Child', acceptance: ['ac2', 'ac3'], id: 'T2', parentId: 'T1', depends: ['T1'] },
      ]).success,
    ).toBe(true);
  });

  it('rejects a non-array (parity: "task_tree must be a non-empty array")', () => {
    expect(firstIssueMessage(taskTreeSchema, 'not-an-array')).toBe(
      'task_tree must be a non-empty array',
    );
  });

  it('rejects an EMPTY ARRAY (parity: empty-array message)', () => {
    expect(firstIssueMessage(taskTreeSchema, [])).toBe(
      'task_tree is an empty array — decomposition produced no tasks',
    );
  });

  it('rejects a MISSING TITLE (parity: "title must be a non-empty string")', () => {
    expect(firstIssueMessage(taskTreeSchema, [{ acceptance: ['ac1'] }])).toBe(
      'title must be a non-empty string',
    );
  });

  it('rejects a whitespace-only title (parity: same non-empty-title message)', () => {
    expect(firstIssueMessage(taskTreeSchema, [{ title: '   ', acceptance: ['ac1'] }])).toBe(
      'title must be a non-empty string',
    );
  });

  it('rejects an EMPTY ACCEPTANCE array (parity: non-empty-acceptance message)', () => {
    expect(firstIssueMessage(taskTreeSchema, [{ title: 'X', acceptance: [] }])).toBe(
      'must have a non-empty acceptance array',
    );
  });

  it('rejects an acceptance array with no non-empty strings (parity message)', () => {
    expect(firstIssueMessage(taskTreeSchema, [{ title: 'X', acceptance: ['   ', ''] }])).toBe(
      'acceptance array contains no non-empty strings',
    );
  });
});

describe('ensures-schema-registry — evidence (ports validateIvtrEvidenceOutput)', () => {
  it('accepts a non-empty string', () => {
    expect(evidenceSchema.safeParse('commit:abc123').success).toBe(true);
  });

  it('accepts a non-empty array', () => {
    expect(evidenceSchema.safeParse(['atom']).success).toBe(true);
  });

  it('accepts an object with at least one key', () => {
    expect(evidenceSchema.safeParse({ commit: 'abc' }).success).toBe(true);
  });

  it('rejects null/undefined (parity: must-be-present message)', () => {
    expect(firstIssueMessage(evidenceSchema, null)).toBe(
      'evidence must be present (non-null, non-undefined)',
    );
    expect(firstIssueMessage(evidenceSchema, undefined)).toBe(
      'evidence must be present (non-null, non-undefined)',
    );
  });

  it('rejects an empty / whitespace-only string (parity message)', () => {
    expect(firstIssueMessage(evidenceSchema, '')).toBe('evidence string must not be empty');
    expect(firstIssueMessage(evidenceSchema, '   ')).toBe('evidence string must not be empty');
  });

  it('rejects an empty array (parity message)', () => {
    expect(firstIssueMessage(evidenceSchema, [])).toBe('evidence array must not be empty');
  });

  it('rejects an EMPTY OBJECT {} (parity: at-least-one-key message)', () => {
    expect(firstIssueMessage(evidenceSchema, {})).toBe(
      'evidence object must have at least one key (got {})',
    );
  });

  it('rejects NUMERIC evidence (parity: wrong-type message with typeof)', () => {
    expect(firstIssueMessage(evidenceSchema, 42)).toBe(
      'evidence must be a string, array, or object (got number)',
    );
  });

  it('rejects boolean evidence (parity: wrong-type message with typeof)', () => {
    expect(firstIssueMessage(evidenceSchema, true)).toBe(
      'evidence must be a string, array, or object (got boolean)',
    );
  });
});
