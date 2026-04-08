/**
 * T4697: Golden parity test — compare TS CLI output with expected LAFS envelope structure.
 *
 * This golden test snapshots the expected shape of LAFS envelopes
 * and asserts the TS CLI output matches. It ensures the LAFS envelope
 * structure is stable across versions.
 *
 * @task T4697
 * @epic T4663
 */

import { ExitCode } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { CleoError } from '../../../core/src/errors.js';
import {
  formatSuccess as _formatSuccess,
  type FormatOptions,
  formatError,
} from '../../../core/src/output.js';

/**
 * Wrapper that passes options through to formatSuccess.
 *
 * @remarks
 * Previously forced mvi='full' to get the old full LAFS envelope shape.
 * After ADR-039 the canonical CliEnvelope shape is always emitted regardless
 * of mvi level, so this wrapper is now a thin pass-through. Kept for test
 * readability and as a call-site for asserting on the canonical shape.
 */
function formatSuccess<T>(
  data: T,
  message?: string,
  operationOrOpts?: string | FormatOptions,
): string {
  const opts: FormatOptions =
    typeof operationOrOpts === 'string'
      ? { operation: operationOrOpts }
      : (operationOrOpts ?? {});
  return _formatSuccess(data, message, opts);
}

import { createPage } from '../../../core/src/pagination.js';
import { createGatewayMeta } from '../dispatch/lib/gateway-meta.js';

/**
 * Canonical CLI success envelope shape (ADR-039).
 * All TS CLI output must match this structure: {success, data, meta, page?}.
 */
const GOLDEN_SUCCESS_SHAPE = {
  success: 'boolean',
  data: 'any',
  meta: {
    operation: 'string',
    requestId: 'string',
    duration_ms: 'number',
    timestamp: 'string',
  },
};

/**
 * Canonical CLI error envelope shape (ADR-039).
 * All CLI error output must match: {success, error, meta}.
 */
const GOLDEN_ERROR_SHAPE = {
  success: 'boolean',
  error: {
    code: 'any',
    message: 'string',
  },
  meta: {
    operation: 'string',
    requestId: 'string',
    duration_ms: 'number',
    timestamp: 'string',
  },
};

/**
 * Assert an object matches a golden shape template.
 * 'any' means any value (including null, arrays, objects).
 * 'null' means the value should be null.
 * Other strings are typeof checks.
 */
function assertShape(obj: unknown, shape: Record<string, unknown>, path = ''): void {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error(`Expected object at ${path || 'root'}, got ${typeof obj}`);
  }

  const record = obj as Record<string, unknown>;
  for (const [key, expectedType] of Object.entries(shape)) {
    const fullPath = path ? `${path}.${key}` : key;
    expect(record).toHaveProperty(key);

    if (expectedType === 'any') {
      // Any value is acceptable
      continue;
    }
    if (expectedType === 'null') {
      expect(record[key]).toBeNull();
      continue;
    }
    if (typeof expectedType === 'object' && expectedType !== null) {
      assertShape(record[key], expectedType as Record<string, unknown>, fullPath);
      continue;
    }
    expect(typeof record[key]).toBe(expectedType);
  }
}

describe('Golden Parity: LAFS Envelope Structure (T4697)', () => {
  describe('Success envelope shape', () => {
    it('tasks.show envelope matches golden shape', () => {
      const json = formatSuccess(
        { task: { id: 'T001', title: 'Test', status: 'pending' } },
        undefined,
        'tasks.show',
      );
      const parsed = JSON.parse(json);
      assertShape(parsed, GOLDEN_SUCCESS_SHAPE);
      expect(parsed.meta.operation).toBe('tasks.show');
      expect(parsed.success).toBe(true);
    });

    it('tasks.list envelope matches golden shape', () => {
      const json = formatSuccess({ tasks: [], total: 0 }, undefined, 'tasks.list');
      const parsed = JSON.parse(json);
      assertShape(parsed, GOLDEN_SUCCESS_SHAPE);
    });

    it('tasks.add envelope matches golden shape', () => {
      const json = formatSuccess(
        { task: { id: 'T002', title: 'New task' } },
        'Task created',
        'tasks.add',
      );
      const parsed = JSON.parse(json);
      assertShape(parsed, GOLDEN_SUCCESS_SHAPE);
      expect(parsed.message).toBe('Task created');
    });

    it('system.dash envelope matches golden shape', () => {
      const json = formatSuccess(
        { project: { name: 'cleo' }, stats: { total: 50 } },
        undefined,
        'system.dash',
      );
      const parsed = JSON.parse(json);
      assertShape(parsed, GOLDEN_SUCCESS_SHAPE);
    });

    it('session.status envelope matches golden shape', () => {
      const json = formatSuccess(
        { session: { id: 'sess-1', status: 'active' } },
        undefined,
        'session.status',
      );
      const parsed = JSON.parse(json);
      assertShape(parsed, GOLDEN_SUCCESS_SHAPE);
    });

    it('cli.output (default) envelope matches golden shape', () => {
      const json = formatSuccess({ data: 'test' });
      const parsed = JSON.parse(json);
      assertShape(parsed, GOLDEN_SUCCESS_SHAPE);
      expect(parsed.meta.operation).toBe('cli.output');
    });
  });

  describe('Error envelope shape', () => {
    it('NOT_FOUND error matches golden shape', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task T999 not found');
      const json = formatError(err, 'tasks.show');
      const parsed = JSON.parse(json);
      assertShape(parsed, GOLDEN_ERROR_SHAPE);
      expect(parsed.success).toBe(false);
      expect(parsed.meta.operation).toBe('tasks.show');
    });

    it('VALIDATION_ERROR error matches golden shape', () => {
      const err = new CleoError(ExitCode.VALIDATION_ERROR, 'Invalid field');
      const json = formatError(err, 'tasks.add');
      const parsed = JSON.parse(json);
      assertShape(parsed, GOLDEN_ERROR_SHAPE);
      // error.category is now carried in the error object
      expect(parsed.error.category).toBe('VALIDATION');
    });

    it('error with details matches golden shape', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task not found', {
        fix: 'Use cleo find',
        alternatives: [{ action: 'List', command: 'cleo list' }],
      });
      const json = formatError(err, 'tasks.show');
      const parsed = JSON.parse(json);
      assertShape(parsed, GOLDEN_ERROR_SHAPE);
      expect(parsed.error.details).toBeDefined();
      expect(parsed.error.details.fix).toBe('Use cleo find');
    });
  });

  describe('Paginated envelope shape', () => {
    it('envelope with page field has correct structure', () => {
      const page = createPage({ total: 100, limit: 20, offset: 0 });
      const json = formatSuccess({ tasks: [] }, undefined, { operation: 'tasks.list', page });
      const parsed = JSON.parse(json);
      assertShape(parsed, GOLDEN_SUCCESS_SHAPE);
      expect(parsed.page).toBeDefined();
      expect(parsed.page.mode).toBe('offset');
      expect(parsed.page.hasMore).toBe(true);
      expect(parsed.page.total).toBe(100);
    });
  });

  describe('Gateway meta shape', () => {
    it('gateway meta matches expected fields', () => {
      const meta = createGatewayMeta('query', 'tasks', 'list', Date.now());
      expect(meta.specVersion).toBe('1.2.3');
      expect(meta.schemaVersion).toBe('2026.2.1');
      expect(meta.transport).toBe('sdk');
      expect(meta.strict).toBe(true);
      expect(meta.mvi).toBe('minimal');
      expect(meta.contextVersion).toBe(1);
      expect(meta.gateway).toBe('query');
      expect(meta.domain).toBe('tasks');
      expect(meta.operation).toBe('list');
      expect(typeof meta.duration_ms).toBe('number');
      expect(typeof meta.requestId).toBe('string');
    });
  });

  describe('Canonical CLI envelope field values (ADR-039)', () => {
    it('success envelope has top-level success=true', () => {
      const json = formatSuccess({ ok: true });
      const parsed = JSON.parse(json);
      expect(parsed.success).toBe(true);
    });

    it('success envelope has data field (not result)', () => {
      const json = formatSuccess({ value: 42 });
      const parsed = JSON.parse(json);
      expect(parsed.data).toBeDefined();
      expect(parsed.data.value).toBe(42);
      expect(parsed.result).toBeUndefined();
    });

    it('success envelope has meta field (not _meta)', () => {
      const json = formatSuccess({ ok: true });
      const parsed = JSON.parse(json);
      expect(parsed.meta).toBeDefined();
      expect(typeof parsed.meta.operation).toBe('string');
      expect(typeof parsed.meta.requestId).toBe('string');
      expect(typeof parsed.meta.timestamp).toBe('string');
      expect(typeof parsed.meta.duration_ms).toBe('number');
      // Legacy fields must be absent
      expect(parsed._meta).toBeUndefined();
      expect(parsed._m).toBeUndefined();
      expect(parsed.ok).toBeUndefined();
      expect(parsed.r).toBeUndefined();
    });

    it('default operation is cli.output', () => {
      const json = formatSuccess({ ok: true });
      const parsed = JSON.parse(json);
      expect(parsed.meta.operation).toBe('cli.output');
    });

    it('operation is set from options', () => {
      const json = formatSuccess({ ok: true }, undefined, 'tasks.show');
      const parsed = JSON.parse(json);
      expect(parsed.meta.operation).toBe('tasks.show');
    });
  });
});
