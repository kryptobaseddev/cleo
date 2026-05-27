/**
 * Tests for dispatch idempotency middleware.
 *
 * Verifies that mutating retry requests with the same idempotency key return a
 * persisted audit-log response without invoking the downstream handler again.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse } from '../../types.js';

const { mockAll, mockPrepare, mockGetDb } = vi.hoisted(() => {
  const mockAll = vi.fn();
  const mockPrepare = vi.fn(() => ({ all: mockAll }));
  const mockGetDb = vi.fn().mockResolvedValue({});
  return { mockAll, mockPrepare, mockGetDb };
});

vi.mock('../../../../../core/src/internal.js', () => ({
  getDb: mockGetDb,
  getNativeDb: vi.fn(() => ({ prepare: mockPrepare })),
  getProjectInfoSync: vi.fn(() => ({ projectHash: 'proj-1' })),
}));

import { createIdempotency } from '../idempotency.js';

function makeRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    gateway: 'mutate',
    domain: 'admin',
    operation: 'scaffold-hub',
    params: { idempotencyKey: 'retry-123' },
    source: 'cli',
    requestId: 'req-retry',
    ...overrides,
  };
}

function makeResponse(overrides: Partial<DispatchResponse> = {}): DispatchResponse {
  return {
    meta: {
      gateway: 'mutate',
      domain: 'admin',
      operation: 'scaffold-hub',
      timestamp: '2026-05-25T00:00:00.000Z',
      duration_ms: 1,
      source: 'cli',
      requestId: 'req-original',
    },
    success: true,
    data: { applied: true },
    ...overrides,
  };
}

describe('createIdempotency middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAll.mockReturnValue([]);
  });

  it('passes through requests without an idempotency key', async () => {
    const middleware = createIdempotency();
    const response = makeResponse();
    const next = vi.fn().mockResolvedValue(response);

    const result = await middleware(makeRequest({ params: {} }), next);

    expect(result).toBe(response);
    expect(next).toHaveBeenCalledOnce();
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it('short-circuits duplicate mutating requests from the audit log', async () => {
    const persisted = { success: true, data: { applied: true, path: '.cleo' } };
    mockAll.mockReturnValue([
      {
        afterJson: JSON.stringify(persisted),
        detailsJson: JSON.stringify({ idempotencyKey: 'retry-123' }),
      },
    ]);
    const middleware = createIdempotency();
    const next = vi.fn().mockResolvedValue(makeResponse({ data: { applied: false } }));

    const result = await middleware(makeRequest(), next);

    expect(next).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data).toEqual(persisted.data);
    expect(result.meta.requestId).toBe('req-retry');
    expect(result.meta.idempotentReplay).toBe(true);
    expect(result.meta.idempotencyKey).toBe('retry-123');
  });

  it('rejects reuse of an idempotency key with different parameters', async () => {
    const persisted = { success: true, data: { applied: true, path: '.cleo' } };
    mockAll.mockReturnValue([
      {
        afterJson: JSON.stringify(persisted),
        detailsJson: JSON.stringify({ idempotencyKey: 'retry-123', title: 'original' }),
      },
    ]);
    const middleware = createIdempotency();
    const next = vi.fn().mockResolvedValue(makeResponse({ data: { applied: false } }));

    const result = await middleware(
      makeRequest({ params: { idempotencyKey: 'retry-123', title: 'changed' } }),
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_IDEMPOTENCY_KEY_CONFLICT');
  });
});
