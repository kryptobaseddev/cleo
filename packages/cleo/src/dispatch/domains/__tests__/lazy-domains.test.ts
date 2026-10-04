/**
 * The CLI's lazy domain handlers mirror `createDomainHandlers` (T13126).
 *
 * The CLI dispatcher registers one {@link LazyDomainHandler} per domain so a
 * command loads only its own domain module. These tests pin that the lazy map
 * covers exactly the eager map's domains, that each proxy reaches the same
 * handler class, and that a failed load is not cached.
 *
 * @task T13126
 */

import { describe, expect, it, vi } from 'vitest';
import type { DispatchResponse, DomainHandler } from '../../types.js';
import { dispatchMeta } from '../_meta.js';
import { createDomainHandlers } from '../index.js';
import { createLazyDomainHandlers, DOMAIN_LOADERS, LazyDomainHandler } from '../lazy.js';

/** A well-formed successful response for the stub handlers below. */
function ok(data: Record<string, unknown>): DispatchResponse {
  return { success: true, data, meta: dispatchMeta('query', 'tasks', 'show', Date.now()) };
}

/** A stub handler whose query and mutate answer `response`. */
function stubHandler(response: DispatchResponse): DomainHandler {
  return {
    query: vi.fn(async () => response),
    mutate: vi.fn(async () => response),
    getSupportedOperations: () => ({ query: [], mutate: [] }),
  };
}

describe('createLazyDomainHandlers (T13126)', () => {
  it('registers exactly the domains createDomainHandlers registers, in the same order', () => {
    expect([...createLazyDomainHandlers().keys()]).toEqual([...createDomainHandlers().keys()]);
    expect(DOMAIN_LOADERS.map(([domain]) => domain)).toEqual([...createDomainHandlers().keys()]);
  });

  it('loads, for every domain, the handler class createDomainHandlers constructs', async () => {
    const eager = createDomainHandlers();
    for (const [domain, lazy] of createLazyDomainHandlers()) {
      expect(lazy).toBeInstanceOf(LazyDomainHandler);
      const real = await (lazy as LazyDomainHandler).resolve();
      expect(real.constructor, domain).toBe(eager.get(domain)?.constructor);
    }
  });

  it('delegates query and mutate to the loaded handler', async () => {
    const response = ok({ ok: 1 });
    const real = stubHandler(response);
    const lazy = new LazyDomainHandler('tasks', async () => real);
    await expect(lazy.query('show', { taskId: 'T1' })).resolves.toBe(response);
    await expect(lazy.mutate('add', { title: 'x' })).resolves.toBe(response);
    expect(real.query).toHaveBeenCalledWith('show', { taskId: 'T1' });
    expect(real.mutate).toHaveBeenCalledWith('add', { title: 'x' });
  });

  it('answers getSupportedOperations from the operation registry without loading', () => {
    const load = vi.fn(async (): Promise<DomainHandler> => {
      throw new Error('must not load');
    });
    const ops = new LazyDomainHandler('tasks', load).getSupportedOperations();
    expect(ops.query).toContain('show');
    expect(ops.mutate).toContain('add');
    expect(load).not.toHaveBeenCalled();
  });

  it('retries a failed load instead of caching the rejection', async () => {
    const real = stubHandler(ok({}));
    const load = vi
      .fn<() => Promise<DomainHandler>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(real);
    const lazy = new LazyDomainHandler('tasks', load);
    await expect(lazy.resolve()).rejects.toThrow('transient');
    await expect(lazy.resolve()).resolves.toBe(real);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
