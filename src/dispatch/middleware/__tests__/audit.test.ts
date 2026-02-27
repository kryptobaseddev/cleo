/**
 * Tests for the audit middleware (Pino + SQLite dual-write).
 *
 * createAudit() writes structured audit entries to:
 *   1. Pino logger (subsystem: 'audit')
 *   2. SQLite audit_log table
 *
 * @task T4844
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DispatchRequest, DispatchResponse } from '../../types.js';

// Hoist mock functions so vi.mock factories can reference them
const {
  mockLogInfo,
  mockLogWarn,
  mockLogError,
  mockInsertRun,
  mockInsertValues,
  mockInsert,
} = vi.hoisted(() => {
  const mockInsertRun = vi.fn().mockResolvedValue(undefined);
  const mockInsertValues = vi.fn(() => ({ run: mockInsertRun }));
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));
  return {
    mockLogInfo: vi.fn(),
    mockLogWarn: vi.fn(),
    mockLogError: vi.fn(),
    mockInsertRun,
    mockInsertValues,
    mockInsert,
  };
});

// Mock Pino logger
vi.mock('../../../core/logger.js', () => ({
  getLogger: vi.fn(() => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  })),
}));

// Mock the dispatch lib/config so auditLog is enabled
vi.mock('../../lib/config.js', () => ({
  getConfig: vi.fn(() => ({ auditLog: true })),
}));

// Mock data-accessor for session lookup (avoids DB reads)
vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn().mockResolvedValue({
    loadSessions: vi.fn().mockResolvedValue({ sessions: [] }),
  }),
}));

// Mock SQLite writes
vi.mock('../../../store/sqlite.js', () => ({
  getDb: vi.fn().mockResolvedValue({
    insert: mockInsert,
  }),
}));

vi.mock('../../../store/schema.js', () => ({
  auditLog: { _: 'mock_audit_log_table' },
}));

import { createAudit } from '../audit.js';

describe('createAudit middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Drain fire-and-forget promises from previous test before clearing
    await new Promise(resolve => setTimeout(resolve, 100));
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  function makeRequest(overrides?: Partial<DispatchRequest>): DispatchRequest {
    return {
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'add',
      params: { taskId: 'T100', title: 'Test task' },
      source: 'mcp',
      requestId: 'req-001',
      ...overrides,
    };
  }

  function makeResponse(overrides?: Partial<DispatchResponse>): DispatchResponse {
    return {
      _meta: {
        gateway: 'mutate',
        domain: 'tasks',
        operation: 'add',
        timestamp: new Date().toISOString(),
        duration_ms: 10,
        source: 'mcp',
        requestId: 'req-001',
      },
      success: true,
      data: { taskId: 'T100' },
      ...overrides,
    };
  }

  it('should pass through to next and return the response', async () => {
    const middleware = createAudit();
    const response = makeResponse();
    const next = vi.fn(() => Promise.resolve(response));
    const request = makeRequest();

    const result = await middleware(request, next);

    expect(next).toHaveBeenCalledOnce();
    expect(result).toBe(response);
  });

  it('should log mutations via Pino', async () => {
    const middleware = createAudit();
    const response = makeResponse();
    const next = vi.fn(() => Promise.resolve(response));
    const request = makeRequest();

    await middleware(request, next);

    // Wait for fire-and-forget promises
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockLogInfo).toHaveBeenCalledOnce();
    const [logObj, logMsg] = mockLogInfo.mock.calls[0]!;
    expect(logObj.domain).toBe('tasks');
    expect(logObj.operation).toBe('add');
    expect(logObj.success).toBe(true);
    expect(logMsg).toContain('tasks.add');
  });

  it('should write mutations to SQLite', async () => {
    const middleware = createAudit();
    const response = makeResponse();
    const next = vi.fn(() => Promise.resolve(response));
    const request = makeRequest();

    await middleware(request, next);

    // Wait for fire-and-forget promises
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockInsert).toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalled();
    const insertedValues = mockInsertValues.mock.calls[0]![0];
    expect(insertedValues.domain).toBe('tasks');
    expect(insertedValues.operation).toBe('add');
    expect(insertedValues.success).toBe(1);
    expect(insertedValues.gateway).toBe('mutate');
  });

  it('should NOT audit query operations (non-grade session)', async () => {
    const middleware = createAudit();
    const response = makeResponse({ _meta: { ...makeResponse()._meta, gateway: 'query' } });
    const next = vi.fn(() => Promise.resolve(response));
    const request = makeRequest({ gateway: 'query' });

    await middleware(request, next);

    // Wait for fire-and-forget promises
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockLogInfo).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('should not block the pipeline if SQLite write fails', async () => {
    mockInsertRun.mockRejectedValueOnce(new Error('Disk full'));

    const middleware = createAudit();
    const response = makeResponse();
    const next = vi.fn(() => Promise.resolve(response));
    const request = makeRequest();

    const result = await middleware(request, next);

    // Wait for fire-and-forget promises
    await new Promise(resolve => setTimeout(resolve, 50));

    // Pipeline should still return the response
    expect(result).toBe(response);
    // Pino log should still have been written
    expect(mockLogInfo).toHaveBeenCalled();
  });

  it('should include error message for failed mutations', async () => {
    const middleware = createAudit();
    const response = makeResponse({
      success: false,
      error: { code: 'E_NOT_FOUND', message: 'Task not found', exitCode: 4 },
    });
    const next = vi.fn(() => Promise.resolve(response));
    const request = makeRequest();

    await middleware(request, next);

    // Wait for fire-and-forget promises
    await new Promise(resolve => setTimeout(resolve, 50));

    // Check Pino log includes failure info
    const [logObj] = mockLogInfo.mock.calls[0]!;
    expect(logObj.success).toBe(false);
    expect(logObj.exitCode).toBe(4);

    // Check SQLite insert includes error
    const insertedValues = mockInsertValues.mock.calls[0]![0];
    expect(insertedValues.errorMessage).toBe('Task not found');
    expect(insertedValues.success).toBe(0);
  });
});
