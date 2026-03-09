/**
 * Tests for the protocol enforcement middleware.
 *
 * Verifies that createProtocolEnforcement() correctly delegates to
 * ProtocolEnforcer.enforceProtocol() and adapts types between
 * DispatchRequest/DispatchResponse and DomainRequest/DomainResponse.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse } from '../../types.js';

// Mock the ProtocolEnforcer class — must use a real class so `new` works
const mockEnforceProtocol = vi.fn();
const mockConstructor = vi.fn();

vi.mock('../../../mcp/lib/protocol-enforcement.js', () => {
  return {
    ProtocolEnforcer: class MockProtocolEnforcer {
      constructor(strictMode: boolean) {
        mockConstructor(strictMode);
      }
      enforceProtocol = mockEnforceProtocol;
    },
  };
});

import { createProtocolEnforcement } from '../protocol-enforcement.js';

function makeRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    gateway: 'query',
    domain: 'tasks',
    operation: 'list',
    params: {},
    source: 'mcp',
    requestId: 'req-001',
    ...overrides,
  };
}

function makeResponse(overrides: Partial<DispatchResponse> = {}): DispatchResponse {
  return {
    _meta: {
      gateway: 'query',
      domain: 'tasks',
      operation: 'list',
      timestamp: new Date().toISOString(),
      duration_ms: 5,
      source: 'mcp',
      requestId: 'req-001',
    },
    success: true,
    data: { tasks: [] },
    ...overrides,
  };
}

describe('createProtocolEnforcement middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes query requests through via enforcer', async () => {
    const response = makeResponse();
    mockEnforceProtocol.mockResolvedValue(response);

    const middleware = createProtocolEnforcement();
    const req = makeRequest({ gateway: 'query' });
    const next = vi.fn().mockResolvedValue(response);

    const result = await middleware(req, next);

    expect(mockEnforceProtocol).toHaveBeenCalledOnce();
    expect(mockEnforceProtocol).toHaveBeenCalledWith(req, next);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ tasks: [] });
  });

  it('passes non-validated mutate requests through', async () => {
    const response = makeResponse({
      _meta: {
        gateway: 'mutate',
        domain: 'tasks',
        operation: 'update',
        timestamp: new Date().toISOString(),
        duration_ms: 10,
        source: 'mcp',
        requestId: 'req-002',
      },
    });
    mockEnforceProtocol.mockResolvedValue(response);

    const middleware = createProtocolEnforcement();
    const req = makeRequest({ gateway: 'mutate', operation: 'update', requestId: 'req-002' });
    const next = vi.fn().mockResolvedValue(response);

    const result = await middleware(req, next);

    expect(result.success).toBe(true);
  });

  it('returns enforcement error for violated mutate operations', async () => {
    const errorResponse: DispatchResponse = {
      _meta: {
        gateway: 'mutate',
        domain: 'tasks',
        operation: 'complete',
        timestamp: new Date().toISOString(),
        duration_ms: 15,
      } as DispatchResponse['_meta'],
      success: false,
      error: {
        code: 'E_PROTOCOL_IMPLEMENTATION',
        exitCode: 65,
        message: 'Protocol violation: implementation',
        details: {
          violations: [{ requirement: 'IMPL-001', severity: 'error', message: 'Missing tests' }],
          score: 80,
        },
        fix: 'Add tests before completing',
      },
    };
    mockEnforceProtocol.mockResolvedValue(errorResponse);

    const middleware = createProtocolEnforcement(true);
    const req = makeRequest({
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'complete',
      requestId: 'req-003',
      source: 'mcp',
    });
    const next = vi.fn();

    const result = await middleware(req, next);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_PROTOCOL_IMPLEMENTATION');
    // Verify _meta gets backfilled with source and requestId from req
    expect(result._meta.source).toBe('mcp');
    expect(result._meta.requestId).toBe('req-003');
  });

  it('backfills _meta.source and _meta.requestId when missing from enforcer response', async () => {
    // Simulate enforcer returning a DomainResponse (no source/requestId on _meta)
    const domainStyleResponse = {
      _meta: {
        gateway: 'mutate',
        domain: 'pipeline',
        operation: 'manifest.append',
        timestamp: new Date().toISOString(),
        duration_ms: 8,
      },
      success: false,
      error: {
        code: 'E_PROTOCOL_RESEARCH',
        message: 'Protocol violation',
      },
    };
    mockEnforceProtocol.mockResolvedValue(domainStyleResponse);

    const middleware = createProtocolEnforcement();
    const req = makeRequest({
      gateway: 'mutate',
      domain: 'pipeline',
      operation: 'manifest.append',
      source: 'cli',
      requestId: 'req-004',
    });
    const next = vi.fn();

    const result = await middleware(req, next);

    expect(result._meta.source).toBe('cli');
    expect(result._meta.requestId).toBe('req-004');
  });

  it('passes strictMode to ProtocolEnforcer constructor', () => {
    createProtocolEnforcement(false);
    expect(mockConstructor).toHaveBeenCalledWith(false);

    createProtocolEnforcement(true);
    expect(mockConstructor).toHaveBeenCalledWith(true);
  });

  it('preserves full response when _meta already has source and requestId', async () => {
    const fullResponse = makeResponse({
      _meta: {
        gateway: 'mutate',
        domain: 'tasks',
        operation: 'complete',
        timestamp: new Date().toISOString(),
        duration_ms: 12,
        source: 'mcp',
        requestId: 'req-005',
      },
      data: { completed: true },
    });
    mockEnforceProtocol.mockResolvedValue(fullResponse);

    const middleware = createProtocolEnforcement();
    const req = makeRequest({ gateway: 'mutate', operation: 'complete', requestId: 'req-005' });
    const next = vi.fn();

    const result = await middleware(req, next);

    expect(result).toBe(fullResponse); // Same object reference — no wrapping needed
    expect(result.data).toEqual({ completed: true });
  });
});
