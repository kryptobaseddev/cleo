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

import { describe, it, expect } from 'vitest';
import { formatSuccess, formatError } from '../output.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { createPage } from '../pagination.js';
import { createGatewayMeta } from '../../mcp/lib/gateway-meta.js';

/**
 * Canonical LAFS success envelope shape.
 * All TS CLI output must match this structure.
 */
const GOLDEN_SUCCESS_SHAPE = {
  $schema: 'string',
  _meta: {
    specVersion: 'string',
    schemaVersion: 'string',
    timestamp: 'string',
    operation: 'string',
    requestId: 'string',
    transport: 'string',
    strict: 'boolean',
    mvi: 'string',
    contextVersion: 'number',
  },
  success: 'boolean',
  result: 'any',
};

/**
 * Canonical LAFS error envelope shape.
 */
const GOLDEN_ERROR_SHAPE = {
  $schema: 'string',
  _meta: {
    specVersion: 'string',
    schemaVersion: 'string',
    timestamp: 'string',
    operation: 'string',
    requestId: 'string',
    transport: 'string',
    strict: 'boolean',
    mvi: 'string',
    contextVersion: 'number',
  },
  success: 'boolean',
  result: 'null',
  error: {
    code: 'string',
    message: 'string',
    category: 'string',
    retryable: 'boolean',
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
      expect(parsed._meta.transport).toBe('cli');
      expect(parsed._meta.strict).toBe(true);
      expect(parsed.success).toBe(true);
    });

    it('tasks.list envelope matches golden shape', () => {
      const json = formatSuccess(
        { tasks: [], total: 0 },
        undefined,
        'tasks.list',
      );
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
      expect(parsed._meta.operation).toBe('cli.output');
    });
  });

  describe('Error envelope shape', () => {
    it('NOT_FOUND error matches golden shape', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task T999 not found');
      const json = formatError(err, 'tasks.show');
      const parsed = JSON.parse(json);
      assertShape(parsed, GOLDEN_ERROR_SHAPE);
      expect(parsed.success).toBe(false);
      expect(parsed.result).toBeNull();
    });

    it('VALIDATION_ERROR error matches golden shape', () => {
      const err = new CleoError(ExitCode.VALIDATION_ERROR, 'Invalid field');
      const json = formatError(err, 'tasks.add');
      const parsed = JSON.parse(json);
      assertShape(parsed, GOLDEN_ERROR_SHAPE);
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
      const json = formatSuccess(
        { tasks: [] },
        undefined,
        { operation: 'tasks.list', page },
      );
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
      const meta = createGatewayMeta('cleo_query', 'tasks', 'list', Date.now());
      expect(meta.specVersion).toBe('1.2.3');
      expect(meta.schemaVersion).toBe('2026.2.1');
      expect(meta.transport).toBe('sdk');
      expect(meta.strict).toBe(true);
      expect(meta.mvi).toBe('standard');
      expect(meta.contextVersion).toBe(1);
      expect(meta.gateway).toBe('cleo_query');
      expect(meta.domain).toBe('tasks');
      expect(meta.operation).toBe('list');
      expect(typeof meta.duration_ms).toBe('number');
      expect(typeof meta.requestId).toBe('string');
    });
  });

  describe('Stable field values', () => {
    it('$schema URL is stable', () => {
      const json = formatSuccess({ ok: true });
      const parsed = JSON.parse(json);
      expect(parsed.$schema).toBe('https://lafs.dev/schemas/v1/envelope.schema.json');
    });

    it('specVersion is stable', () => {
      const json = formatSuccess({ ok: true });
      const parsed = JSON.parse(json);
      expect(parsed._meta.specVersion).toBe('1.2.3');
    });

    it('schemaVersion is stable', () => {
      const json = formatSuccess({ ok: true });
      const parsed = JSON.parse(json);
      expect(parsed._meta.schemaVersion).toBe('2026.2.1');
    });

    it('CLI transport is cli', () => {
      const json = formatSuccess({ ok: true });
      const parsed = JSON.parse(json);
      expect(parsed._meta.transport).toBe('cli');
    });

    it('SDK transport is sdk', () => {
      const meta = createGatewayMeta('q', 'd', 'op', Date.now());
      expect(meta.transport).toBe('sdk');
    });
  });
});
