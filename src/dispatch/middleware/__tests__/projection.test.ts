import { describe, it, expect } from 'vitest';
import {
  isOperationAllowed,
  createProjectionContext,
  createProjectionMiddleware,
} from '../projection.js';
import type { DispatchRequest, DispatchResponse } from '../../types.js';

describe('isOperationAllowed', () => {
  it('should allow tasks at all tiers', () => {
    expect(isOperationAllowed('tasks', 'minimal')).toBe(true);
    expect(isOperationAllowed('tasks', 'standard')).toBe(true);
    expect(isOperationAllowed('tasks', 'orchestrator')).toBe(true);
  });

  it('should allow session at all tiers', () => {
    expect(isOperationAllowed('session', 'minimal')).toBe(true);
    expect(isOperationAllowed('session', 'standard')).toBe(true);
    expect(isOperationAllowed('session', 'orchestrator')).toBe(true);
  });

  it('should allow admin at all tiers', () => {
    expect(isOperationAllowed('admin', 'minimal')).toBe(true);
    expect(isOperationAllowed('admin', 'standard')).toBe(true);
    expect(isOperationAllowed('admin', 'orchestrator')).toBe(true);
  });

  it('should deny orchestrate at minimal tier', () => {
    expect(isOperationAllowed('orchestrate', 'minimal')).toBe(false);
  });

  it('should deny orchestrate at standard tier', () => {
    expect(isOperationAllowed('orchestrate', 'standard')).toBe(false);
  });

  it('should allow orchestrate at orchestrator tier', () => {
    expect(isOperationAllowed('orchestrate', 'orchestrator')).toBe(true);
  });

  it('should deny memory at minimal tier', () => {
    expect(isOperationAllowed('memory', 'minimal')).toBe(false);
  });

  it('should allow memory at standard tier', () => {
    expect(isOperationAllowed('memory', 'standard')).toBe(true);
  });

  it('should deny nexus at minimal and standard tiers', () => {
    expect(isOperationAllowed('nexus', 'minimal')).toBe(false);
    expect(isOperationAllowed('nexus', 'standard')).toBe(false);
  });

  it('should allow nexus at orchestrator tier', () => {
    expect(isOperationAllowed('nexus', 'orchestrator')).toBe(true);
  });
});

describe('createProjectionContext', () => {
  it('should default to standard tier', () => {
    const ctx = createProjectionContext();
    expect(ctx.tier).toBe('standard');
    expect(ctx.config.allowedDomains).toContain('memory');
  });

  it('should resolve minimal tier from params', () => {
    const ctx = createProjectionContext({ _mviTier: 'minimal' });
    expect(ctx.tier).toBe('minimal');
    expect(ctx.config.allowedDomains).toEqual(['tasks', 'session', 'admin']);
  });

  it('should resolve orchestrator tier from params', () => {
    const ctx = createProjectionContext({ _mviTier: 'orchestrator' });
    expect(ctx.tier).toBe('orchestrator');
    expect(ctx.config.allowedDomains).toContain('orchestrate');
  });

  it('should fall back to standard for invalid tier', () => {
    const ctx = createProjectionContext({ _mviTier: 'invalid' });
    expect(ctx.tier).toBe('standard');
  });
});

describe('createProjectionMiddleware', () => {
  function makeRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
    return {
      gateway: 'query',
      domain: 'tasks',
      operation: 'show',
      params: {},
      source: 'mcp',
      requestId: 'test-req-1',
      ...overrides,
    };
  }

  function makeSuccessResponse(data: unknown = {}): DispatchResponse {
    return {
      _meta: {
        gateway: 'query',
        domain: 'tasks',
        operation: 'show',
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        source: 'mcp',
        requestId: 'test-req-1',
      },
      success: true,
      data,
    };
  }

  it('should pass through allowed domain at default tier', async () => {
    const middleware = createProjectionMiddleware();
    const req = makeRequest({ domain: 'tasks' });
    const expected = makeSuccessResponse({ id: 'T1' });
    const result = await middleware(req, async () => expected);
    expect(result.success).toBe(true);
  });

  it('should block disallowed domain at minimal tier', async () => {
    const middleware = createProjectionMiddleware();
    const req = makeRequest({
      domain: 'orchestrate',
      params: { _mviTier: 'minimal' },
    });
    const result = await middleware(req, async () => makeSuccessResponse());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_OPERATION');
    expect(result.error?.message).toContain('minimal');
  });

  it('should remove _mviTier from params before calling next', async () => {
    const middleware = createProjectionMiddleware();
    const params = { _mviTier: 'standard', query: 'test' };
    const req = makeRequest({ params });
    let capturedParams: Record<string, unknown> | undefined;
    await middleware(req, async () => {
      capturedParams = req.params;
      return makeSuccessResponse();
    });
    expect(capturedParams).toBeDefined();
    expect(capturedParams!['_mviTier']).toBeUndefined();
    expect(capturedParams!['query']).toBe('test');
  });

  it('should apply field exclusions to response data', async () => {
    const middleware = createProjectionMiddleware();
    const req = makeRequest({ params: { _mviTier: 'minimal' } });
    const data = { id: 'T1', title: 'Test', notes: ['n1'], auditLog: [] };
    const result = await middleware(req, async () => makeSuccessResponse(data));
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: 'T1', title: 'Test' });
  });

  it('should not apply exclusions at orchestrator tier', async () => {
    const middleware = createProjectionMiddleware();
    const req = makeRequest({ params: { _mviTier: 'orchestrator' } });
    const data = { id: 'T1', notes: ['n1'], auditLog: ['log1'] };
    const result = await middleware(req, async () => makeSuccessResponse(data));
    expect(result.success).toBe(true);
    expect(result.data).toEqual(data);
  });

  it('should not modify error responses', async () => {
    const middleware = createProjectionMiddleware();
    const req = makeRequest({ params: { _mviTier: 'minimal' } });
    const errorResponse: DispatchResponse = {
      _meta: {
        gateway: 'query',
        domain: 'tasks',
        operation: 'show',
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        source: 'mcp',
        requestId: 'test-req-1',
      },
      success: false,
      error: { code: 'E_NOT_FOUND', message: 'Not found' },
    };
    const result = await middleware(req, async () => errorResponse);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND');
  });
});

describe('MCP compact default for tasks.list', () => {
  function makeRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
    return {
      gateway: 'query',
      domain: 'tasks',
      operation: 'list',
      params: {},
      source: 'mcp',
      requestId: 'test-compact-1',
      ...overrides,
    };
  }

  function makeSuccessResponse(data: unknown = {}): DispatchResponse {
    return {
      _meta: {
        gateway: 'query',
        domain: 'tasks',
        operation: 'list',
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        source: 'mcp',
        requestId: 'test-compact-1',
      },
      success: true,
      data,
    };
  }

  it('should inject compact: true for MCP tasks.list', async () => {
    const middleware = createProjectionMiddleware();
    const req = makeRequest();
    let capturedParams: Record<string, unknown> | undefined;
    await middleware(req, async () => {
      capturedParams = req.params;
      return makeSuccessResponse();
    });
    expect(capturedParams!['compact']).toBe(true);
  });

  it('should NOT inject compact for CLI tasks.list', async () => {
    const middleware = createProjectionMiddleware();
    const req = makeRequest({ source: 'cli' });
    let capturedParams: Record<string, unknown> | undefined;
    await middleware(req, async () => {
      capturedParams = req.params;
      return makeSuccessResponse();
    });
    expect(capturedParams!['compact']).toBeUndefined();
  });

  it('should NOT override explicit compact: false', async () => {
    const middleware = createProjectionMiddleware();
    const req = makeRequest({ params: { compact: false } });
    let capturedParams: Record<string, unknown> | undefined;
    await middleware(req, async () => {
      capturedParams = req.params;
      return makeSuccessResponse();
    });
    expect(capturedParams!['compact']).toBe(false);
  });

  it('should NOT inject compact for non-list operations', async () => {
    const middleware = createProjectionMiddleware();
    const req = makeRequest({ operation: 'show' });
    let capturedParams: Record<string, unknown> | undefined;
    await middleware(req, async () => {
      capturedParams = req.params;
      return makeSuccessResponse();
    });
    expect(capturedParams!['compact']).toBeUndefined();
  });

  it('should NOT inject compact for non-tasks domains', async () => {
    const middleware = createProjectionMiddleware();
    const req = makeRequest({ domain: 'session', operation: 'list' });
    let capturedParams: Record<string, unknown> | undefined;
    await middleware(req, async () => {
      capturedParams = req.params;
      return makeSuccessResponse();
    });
    expect(capturedParams!['compact']).toBeUndefined();
  });
});
