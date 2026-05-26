/**
 * Contract tests for operation-aware LAFS envelope validation.
 *
 * @task T10610
 * @saga T10538
 */

import { describe, expect, it } from 'vitest';
import type { LAFSEnvelope } from '../lafs.js';
import {
  E_LAFS_OPERATION_ERROR_SHAPE,
  E_LAFS_OPERATION_RESULT_SCHEMA,
  E_LAFS_OPERATION_UNREGISTERED,
  validateOperationEnvelope,
} from '../operation-envelope-validation.js';
import { tasksTreeResultSchema } from '../workgraph.js';

const baseMeta: LAFSEnvelope['_meta'] = {
  specVersion: '1.0.0',
  schemaVersion: '1.0.0',
  timestamp: '2026-05-26T10:00:00.000Z',
  operation: 'tasks.frontier',
  requestId: 'req-T10610',
  transport: 'cli',
  strict: true,
  mvi: 'standard',
  contextVersion: 1,
};

function successEnvelope(
  operation: string,
  result: NonNullable<LAFSEnvelope['result']>,
): LAFSEnvelope {
  return {
    $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
    _meta: { ...baseMeta, operation },
    success: true,
    result,
    error: null,
  };
}

function failureEnvelope(operation = 'tasks.frontier'): LAFSEnvelope {
  return {
    $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
    _meta: { ...baseMeta, operation },
    success: false,
    result: null,
    error: {
      code: 'E_CONTRACT',
      message: 'contract failed',
      category: 'CONTRACT',
      retryable: false,
      retryAfterMs: null,
      details: { taskId: 'T10610' },
      agentAction: 'stop',
    },
  };
}

const frontierResult = {
  rootId: 'T10538',
  groups: { ready: [], blocked: [], blockedBy: [] },
};

describe('operation-aware LAFS envelope validation', () => {
  it('checks _meta.operation against the canonical operations registry', () => {
    const valid = validateOperationEnvelope(successEnvelope('tasks.frontier', frontierResult));
    expect(valid.valid).toBe(true);
    expect(valid.operation?.domain).toBe('tasks');
    expect(valid.operation?.operation).toBe('frontier');

    const invalid = validateOperationEnvelope(
      successEnvelope('tasks.not-a-real-operation', frontierResult),
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.issues).toContainEqual(
      expect.objectContaining({
        path: '/_meta/operation',
        code: E_LAFS_OPERATION_UNREGISTERED,
      }),
    );
  });

  it('validates successful payloads against the operation result schema', () => {
    const invalid = validateOperationEnvelope(
      successEnvelope('tasks.frontier', { rootId: 'T10538', groups: { ready: [] } }),
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.resultSchemaOperation).toBe('tasks.frontier');
    expect(invalid.issues.some((issue) => issue.code === E_LAFS_OPERATION_RESULT_SCHEMA)).toBe(
      true,
    );

    const valid = validateOperationEnvelope(successEnvelope('tasks.frontier', frontierResult));
    expect(valid.valid).toBe(true);
    expect(valid.resultSchemaOperation).toBe('tasks.frontier');
  });

  it('enforces canonical error-envelope shape before result schemas', () => {
    const validFailure = validateOperationEnvelope(failureEnvelope());
    expect(validFailure.valid).toBe(true);
    expect(validFailure.resultSchemaOperation).toBe('tasks.frontier');

    const invalidFailure = validateOperationEnvelope({
      ...failureEnvelope(),
      result: frontierResult,
    });
    expect(invalidFailure.valid).toBe(false);
    expect(invalidFailure.issues).toContainEqual(
      expect.objectContaining({
        path: '/result',
        code: E_LAFS_OPERATION_ERROR_SHAPE,
      }),
    );
  });

  it('rejects relation groups edges in hierarchy tree result contracts', () => {
    const result = tasksTreeResultSchema.safeParse({
      rootId: 'T10538',
      nodes: [],
      edges: [{ fromId: 'T10538', toId: 'T10545', kind: 'groups', source: 'relation' }],
      pageInfo: { hasMore: false },
    });
    expect(result.success).toBe(false);

    const envelope = validateOperationEnvelope(
      successEnvelope('tasks.tree', {
        rootId: 'T10538',
        nodes: [],
        edges: [{ fromId: 'T10538', toId: 'T10545', kind: 'groups', source: 'relation' }],
        pageInfo: { hasMore: false },
      }),
    );
    expect(envelope.valid).toBe(false);
    expect(envelope.issues.some((issue) => issue.code === E_LAFS_OPERATION_RESULT_SCHEMA)).toBe(
      true,
    );
  });
});
