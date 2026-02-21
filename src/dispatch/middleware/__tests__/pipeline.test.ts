import { describe, it, expect, vi } from 'vitest';
import { compose } from '../pipeline.js';
import { DispatchRequest, DispatchResponse, Middleware, DispatchNext } from '../../types.js';

describe('Middleware Pipeline (compose)', () => {
  const mockReq: DispatchRequest = {
    gateway: 'query',
    domain: 'tasks',
    operation: 'show',
    source: 'cli',
    requestId: 'test-id',
  };

  it('should pass through when empty', async () => {
    const pipeline = compose([]);
    const result = await pipeline(mockReq, async () => ({
      _meta: { gateway: 'query', domain: 'tasks', operation: 'show', timestamp: '', duration_ms: 0, source: 'cli', requestId: '' },
      success: true,
      data: 'final'
    }));
    expect(result.data).toBe('final');
  });

  it('should execute middleware in order', async () => {
    const order: number[] = [];
    
    const m1: Middleware = async (req, next) => {
      order.push(1);
      const res = await next();
      order.push(4);
      return res;
    };
    
    const m2: Middleware = async (req, next) => {
      order.push(2);
      const res = await next();
      order.push(3);
      return res;
    };

    const pipeline = compose([m1, m2]);
    await pipeline(mockReq, async () => {
      return { _meta: {} as any, success: true };
    });

    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('should allow short-circuiting', async () => {
    const m1: Middleware = async (req, next) => {
      return { _meta: {} as any, success: false, error: { code: 'SHORT_CIRCUIT', message: 'stopped' } };
    };
    
    const m2: Middleware = async (req, next) => {
      // Should not be called
      return next();
    };

    const pipeline = compose([m1, m2]);
    const finalNext = vi.fn();
    
    const res = await pipeline(mockReq, finalNext);
    
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('SHORT_CIRCUIT');
    expect(finalNext).not.toHaveBeenCalled();
  });
});
