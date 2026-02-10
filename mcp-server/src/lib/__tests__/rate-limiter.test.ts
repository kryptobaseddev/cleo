/**
 * Rate Limiter Tests
 *
 * Tests for sliding window rate limiting per Section 13.3:
 * - Query: 100/minute
 * - Mutate: 30/minute
 * - Spawn: 10/minute
 *
 * @task T2916
 */

import { RateLimiter, DEFAULT_RATE_LIMITING, RateLimitingConfig } from '../rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  describe('constructor', () => {
    it('uses default config when no config provided', () => {
      const config = limiter.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.query.maxRequests).toBe(100);
      expect(config.query.windowMs).toBe(60_000);
      expect(config.mutate.maxRequests).toBe(30);
      expect(config.mutate.windowMs).toBe(60_000);
      expect(config.spawn.maxRequests).toBe(10);
      expect(config.spawn.windowMs).toBe(60_000);
    });

    it('merges partial config with defaults', () => {
      const customLimiter = new RateLimiter({
        query: { maxRequests: 50, windowMs: 30_000 },
      });
      const config = customLimiter.getConfig();
      expect(config.query.maxRequests).toBe(50);
      expect(config.query.windowMs).toBe(30_000);
      // Mutate and spawn should remain at defaults
      expect(config.mutate.maxRequests).toBe(30);
      expect(config.spawn.maxRequests).toBe(10);
    });

    it('respects enabled=false', () => {
      const disabledLimiter = new RateLimiter({ enabled: false });
      const config = disabledLimiter.getConfig();
      expect(config.enabled).toBe(false);
    });
  });

  describe('check()', () => {
    it('allows requests within the limit', () => {
      const result = limiter.check('cleo_query', 'tasks', 'list');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
      expect(result.limit).toBe(100);
      expect(result.category).toBe('query');
    });

    it('correctly categorizes query operations', () => {
      const result = limiter.check('cleo_query', 'tasks', 'find');
      expect(result.category).toBe('query');
    });

    it('correctly categorizes mutate operations', () => {
      const result = limiter.check('cleo_mutate', 'tasks', 'create');
      expect(result.category).toBe('mutate');
    });

    it('correctly categorizes spawn operations', () => {
      const result = limiter.check('cleo_mutate', 'orchestrate', 'spawn');
      expect(result.category).toBe('spawn');
    });

    it('decrements remaining count on each check', () => {
      const r1 = limiter.check('cleo_mutate', 'tasks', 'create');
      expect(r1.remaining).toBe(29);

      const r2 = limiter.check('cleo_mutate', 'tasks', 'update');
      expect(r2.remaining).toBe(28);

      const r3 = limiter.check('cleo_mutate', 'session', 'start');
      expect(r3.remaining).toBe(27);
    });

    it('blocks when limit is exceeded', () => {
      // Use a small limit for testing
      const smallLimiter = new RateLimiter({
        mutate: { maxRequests: 3, windowMs: 60_000 },
      });

      expect(smallLimiter.check('cleo_mutate', 'tasks', 'create').allowed).toBe(true);
      expect(smallLimiter.check('cleo_mutate', 'tasks', 'update').allowed).toBe(true);
      expect(smallLimiter.check('cleo_mutate', 'tasks', 'delete').allowed).toBe(true);

      // 4th request should be blocked
      const blocked = smallLimiter.check('cleo_mutate', 'tasks', 'complete');
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.limit).toBe(3);
      expect(blocked.resetMs).toBeGreaterThan(0);
    });

    it('blocks spawn operations at their lower limit', () => {
      const smallLimiter = new RateLimiter({
        spawn: { maxRequests: 2, windowMs: 60_000 },
      });

      expect(smallLimiter.check('cleo_mutate', 'orchestrate', 'spawn').allowed).toBe(true);
      expect(smallLimiter.check('cleo_mutate', 'orchestrate', 'spawn').allowed).toBe(true);

      const blocked = smallLimiter.check('cleo_mutate', 'orchestrate', 'spawn');
      expect(blocked.allowed).toBe(false);
      expect(blocked.category).toBe('spawn');
    });

    it('returns Infinity when disabled', () => {
      const disabledLimiter = new RateLimiter({ enabled: false });
      const result = disabledLimiter.check('cleo_query', 'tasks', 'list');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(Infinity);
      expect(result.limit).toBe(Infinity);
      expect(result.category).toBe('disabled');
    });

    it('tracks categories independently', () => {
      const smallLimiter = new RateLimiter({
        query: { maxRequests: 2, windowMs: 60_000 },
        mutate: { maxRequests: 2, windowMs: 60_000 },
      });

      // Use up query limit
      smallLimiter.check('cleo_query', 'tasks', 'list');
      smallLimiter.check('cleo_query', 'tasks', 'find');
      expect(smallLimiter.check('cleo_query', 'tasks', 'get').allowed).toBe(false);

      // Mutate should still be available
      expect(smallLimiter.check('cleo_mutate', 'tasks', 'create').allowed).toBe(true);
    });

    it('resets after window expires', () => {
      // Use a very short window
      const shortLimiter = new RateLimiter({
        query: { maxRequests: 1, windowMs: 10 }, // 10ms window
      });

      expect(shortLimiter.check('cleo_query', 'tasks', 'list').allowed).toBe(true);
      expect(shortLimiter.check('cleo_query', 'tasks', 'list').allowed).toBe(false);

      // Wait for window to expire
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(shortLimiter.check('cleo_query', 'tasks', 'list').allowed).toBe(true);
          resolve();
        }, 20);
      });
    });
  });

  describe('peek()', () => {
    it('returns status without recording a request', () => {
      const peek1 = limiter.peek('cleo_query', 'tasks', 'list');
      expect(peek1.allowed).toBe(true);
      expect(peek1.remaining).toBe(100);

      // Peek again - should still be 100 (not recorded)
      const peek2 = limiter.peek('cleo_query', 'tasks', 'list');
      expect(peek2.remaining).toBe(100);

      // Now check (records) and peek should show 99
      limiter.check('cleo_query', 'tasks', 'list');
      const peek3 = limiter.peek('cleo_query', 'tasks', 'list');
      expect(peek3.remaining).toBe(99);
    });

    it('returns Infinity when disabled', () => {
      const disabledLimiter = new RateLimiter({ enabled: false });
      const result = disabledLimiter.peek('cleo_query', 'tasks', 'list');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(Infinity);
    });
  });

  describe('reset()', () => {
    it('clears all buckets', () => {
      limiter.check('cleo_query', 'tasks', 'list');
      limiter.check('cleo_mutate', 'tasks', 'create');

      limiter.reset();

      const queryResult = limiter.peek('cleo_query', 'tasks', 'list');
      expect(queryResult.remaining).toBe(100);

      const mutateResult = limiter.peek('cleo_mutate', 'tasks', 'create');
      expect(mutateResult.remaining).toBe(30);
    });
  });

  describe('resetCategory()', () => {
    it('clears only the specified category', () => {
      limiter.check('cleo_query', 'tasks', 'list');
      limiter.check('cleo_mutate', 'tasks', 'create');

      limiter.resetCategory('query');

      const queryResult = limiter.peek('cleo_query', 'tasks', 'list');
      expect(queryResult.remaining).toBe(100);

      const mutateResult = limiter.peek('cleo_mutate', 'tasks', 'create');
      expect(mutateResult.remaining).toBe(29);
    });
  });

  describe('updateConfig()', () => {
    it('updates config at runtime', () => {
      limiter.updateConfig({ enabled: false });
      expect(limiter.getConfig().enabled).toBe(false);

      const result = limiter.check('cleo_query', 'tasks', 'list');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(Infinity);
    });

    it('updates individual category limits', () => {
      limiter.updateConfig({
        query: { maxRequests: 5, windowMs: 60_000 },
      });

      const config = limiter.getConfig();
      expect(config.query.maxRequests).toBe(5);
      // Other categories unchanged
      expect(config.mutate.maxRequests).toBe(30);
    });
  });

  describe('DEFAULT_RATE_LIMITING', () => {
    it('matches spec Section 13.3 values', () => {
      expect(DEFAULT_RATE_LIMITING.enabled).toBe(true);
      expect(DEFAULT_RATE_LIMITING.query.maxRequests).toBe(100);
      expect(DEFAULT_RATE_LIMITING.query.windowMs).toBe(60_000);
      expect(DEFAULT_RATE_LIMITING.mutate.maxRequests).toBe(30);
      expect(DEFAULT_RATE_LIMITING.mutate.windowMs).toBe(60_000);
      expect(DEFAULT_RATE_LIMITING.spawn.maxRequests).toBe(10);
      expect(DEFAULT_RATE_LIMITING.spawn.windowMs).toBe(60_000);
    });
  });

  describe('edge cases', () => {
    it('handles unknown gateway type as mutate', () => {
      const result = limiter.check('cleo_unknown' as any, 'tasks', 'list');
      expect(result.category).toBe('mutate');
    });

    it('handles rapid successive requests', () => {
      const smallLimiter = new RateLimiter({
        query: { maxRequests: 5, windowMs: 60_000 },
      });

      for (let i = 0; i < 5; i++) {
        const r = smallLimiter.check('cleo_query', 'tasks', 'list');
        expect(r.allowed).toBe(true);
        expect(r.remaining).toBe(4 - i);
      }

      const blocked = smallLimiter.check('cleo_query', 'tasks', 'list');
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });

    it('provides accurate resetMs', () => {
      const smallLimiter = new RateLimiter({
        query: { maxRequests: 1, windowMs: 60_000 },
      });

      smallLimiter.check('cleo_query', 'tasks', 'list');
      const blocked = smallLimiter.check('cleo_query', 'tasks', 'list');

      expect(blocked.resetMs).toBeGreaterThan(0);
      expect(blocked.resetMs).toBeLessThanOrEqual(60_000);
    });
  });
});
