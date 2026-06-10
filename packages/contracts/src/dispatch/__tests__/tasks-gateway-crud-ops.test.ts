/**
 * Registry regression tests for the E1-GATEWAY-CRUD epic (T11556).
 *
 *  - T11784: `tasks.update` OperationDef.params enumerates EVERY mutable field
 *    declared in `TASKS_UPDATE_INPUT_SCHEMA`, and carries the inline
 *    input/output schemas — so dispatch introspection (`--describe`, the SDK
 *    `describeOperation`) no longer hides the real update surface behind a
 *    `taskId`-only param list.
 *  - T11786: the three bulk task mutate ops (`reorder-rank`, `bulk-move`,
 *    `assignee`) are registered as `mutate` ops with the expected required
 *    params and inline output schemas.
 *  - T11785: the first streaming task op (`tasks.subscribe`) is registered as a
 *    `query` op flagged `streaming: true`.
 *
 * @task T11784
 * @task T11785
 * @task T11786
 * @epic T11556
 */

import { describe, expect, it } from 'vitest';
import { TASKS_UPDATE_INPUT_SCHEMA } from '../../operations/tasks.js';
import { OPERATIONS } from '../operations-registry.js';

function findOp(gateway: 'query' | 'mutate', operation: string) {
  return OPERATIONS.find(
    (o) => o.domain === 'tasks' && o.gateway === gateway && o.operation === operation,
  );
}

describe('T11784 — tasks.update OperationDef params parity', () => {
  const update = findOp('mutate', 'update');

  it('registers tasks.update as a mutate op', () => {
    expect(update).toBeDefined();
  });

  it('enumerates every mutable field from TASKS_UPDATE_INPUT_SCHEMA', () => {
    const schemaFields = Object.keys(
      (TASKS_UPDATE_INPUT_SCHEMA.properties ?? {}) as Record<string, unknown>,
    );
    const paramNames = new Set((update?.params ?? []).map((p) => p.name));
    // Every schema property must be a declared param (no silent-dropped fields).
    for (const field of schemaFields) {
      expect(paramNames.has(field), `tasks.update param "${field}" missing from OperationDef`).toBe(
        true,
      );
    }
    // taskId is the only required param.
    expect(update?.requiredParams).toEqual(['taskId']);
    expect((update?.params ?? []).filter((p) => p.required).map((p) => p.name)).toEqual(['taskId']);
  });

  it('carries the inline input + output schemas', () => {
    expect(update?.inputSchema?.operation).toBe('tasks.update');
    expect(update?.outputSchema?.operation).toBe('tasks.update');
    // The output contract points at the bare-string updated-id pointer.
    expect(update?.outputSchema?.fieldPointers).toContain('/data/updated/0');
  });
});

describe('T11786 — bulk task mutate ops', () => {
  it('registers tasks.reorder-rank with orderedIds required + output schema', () => {
    const op = findOp('mutate', 'reorder-rank');
    expect(op).toBeDefined();
    expect(op?.requiredParams).toEqual(['orderedIds']);
    expect(op?.outputSchema?.operation).toBe('tasks.reorder-rank');
    expect(op?.outputSchema?.fieldPointers).toContain('/data/ranked/0');
  });

  it('registers tasks.bulk-move with taskIds required + output schema', () => {
    const op = findOp('mutate', 'bulk-move');
    expect(op).toBeDefined();
    expect(op?.requiredParams).toEqual(['taskIds']);
    expect(op?.outputSchema?.operation).toBe('tasks.bulk-move');
    expect(op?.outputSchema?.fieldPointers).toContain('/data/moved/0');
  });

  it('registers tasks.assignee with taskId required + output schema', () => {
    const op = findOp('mutate', 'assignee');
    expect(op).toBeDefined();
    expect(op?.requiredParams).toEqual(['taskId']);
    expect(op?.outputSchema?.operation).toBe('tasks.assignee');
    expect(op?.outputSchema?.fieldPointers).toContain('/data/assignee');
  });
});

describe('T11785 — streaming task op', () => {
  it('registers tasks.subscribe as a query op flagged streaming', () => {
    const op = findOp('query', 'subscribe');
    expect(op).toBeDefined();
    expect(op?.streaming).toBe(true);
    // No required params — subscribe is open by default (optional root/ticks scope).
    expect(op?.requiredParams).toEqual([]);
    const paramNames = (op?.params ?? []).map((p) => p.name);
    expect(paramNames).toContain('root');
    expect(paramNames).toContain('ticks');
  });
});
