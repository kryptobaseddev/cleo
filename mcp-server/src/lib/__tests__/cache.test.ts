/**
 * Tests for query cache
 *
 * @task T3145
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { QueryCache } from '../cache.js';

describe('QueryCache', () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache(5000, true);
  });

  afterEach(() => {
    cache.destroy();
  });

  describe('basic operations', () => {
    it('should store and retrieve values', () => {
      const value = { success: true, data: { tasks: [] } };
      cache.set('tasks', 'list', { status: 'pending' }, value);

      const result = cache.get('tasks', 'list', { status: 'pending' });
      expect(result).toEqual(value);
    });

    it('should return undefined for cache miss', () => {
      const result = cache.get('tasks', 'list', { status: 'pending' });
      expect(result).toBeUndefined();
    });

    it('should return undefined for different params', () => {
      cache.set('tasks', 'list', { status: 'pending' }, { data: 'a' });

      const result = cache.get('tasks', 'list', { status: 'active' });
      expect(result).toBeUndefined();
    });

    it('should return undefined for different operation', () => {
      cache.set('tasks', 'list', undefined, { data: 'a' });

      const result = cache.get('tasks', 'find', undefined);
      expect(result).toBeUndefined();
    });

    it('should handle undefined params', () => {
      cache.set('system', 'version', undefined, { version: '1.0.0' });

      const result = cache.get('system', 'version', undefined);
      expect(result).toEqual({ version: '1.0.0' });
    });

    it('should handle params with same keys in different order', () => {
      cache.set('tasks', 'list', { status: 'pending', parent: 'T1' }, 'result');

      // Same params, different key order
      const result = cache.get('tasks', 'list', { parent: 'T1', status: 'pending' });
      expect(result).toBe('result');
    });
  });

  describe('TTL expiration', () => {
    it('should expire entries after TTL', () => {
      // Use a very short TTL
      cache.destroy();
      cache = new QueryCache(50, true);

      cache.set('tasks', 'list', undefined, { data: 'value' });

      // Immediately available
      expect(cache.get('tasks', 'list', undefined)).toEqual({ data: 'value' });

      // Wait for expiration
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(cache.get('tasks', 'list', undefined)).toBeUndefined();
          resolve();
        }, 100);
      });
    });

    it('should count TTL expiration as eviction', () => {
      cache.destroy();
      cache = new QueryCache(50, true);

      cache.set('tasks', 'list', undefined, { data: 'value' });

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          cache.get('tasks', 'list', undefined); // Triggers eviction check
          const stats = cache.getStats();
          expect(stats.evictions).toBeGreaterThan(0);
          resolve();
        }, 100);
      });
    });
  });

  describe('domain invalidation', () => {
    it('should invalidate all entries for a domain', () => {
      cache.set('tasks', 'list', undefined, 'a');
      cache.set('tasks', 'find', { q: 'test' }, 'b');
      cache.set('tasks', 'get', { id: 'T1' }, 'c');
      cache.set('session', 'status', undefined, 'd');

      const count = cache.invalidateDomain('tasks');

      expect(count).toBe(3);
      expect(cache.get('tasks', 'list', undefined)).toBeUndefined();
      expect(cache.get('tasks', 'find', { q: 'test' })).toBeUndefined();
      expect(cache.get('tasks', 'get', { id: 'T1' })).toBeUndefined();
      // Other domains unaffected
      expect(cache.get('session', 'status', undefined)).toBe('d');
    });

    it('should return 0 for empty domain', () => {
      const count = cache.invalidateDomain('unknown');
      expect(count).toBe(0);
    });

    it('should update eviction stats on invalidation', () => {
      cache.set('tasks', 'list', undefined, 'a');
      cache.set('tasks', 'find', undefined, 'b');

      cache.invalidateDomain('tasks');

      const stats = cache.getStats();
      expect(stats.evictions).toBe(2);
    });
  });

  describe('clear', () => {
    it('should clear all entries', () => {
      cache.set('tasks', 'list', undefined, 'a');
      cache.set('session', 'status', undefined, 'b');
      cache.set('system', 'version', undefined, 'c');

      cache.clear();

      expect(cache.get('tasks', 'list', undefined)).toBeUndefined();
      expect(cache.get('session', 'status', undefined)).toBeUndefined();
      expect(cache.get('system', 'version', undefined)).toBeUndefined();
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe('statistics', () => {
    it('should track hits and misses', () => {
      cache.set('tasks', 'list', undefined, 'value');

      cache.get('tasks', 'list', undefined); // hit
      cache.get('tasks', 'list', undefined); // hit
      cache.get('tasks', 'find', undefined); // miss
      cache.get('session', 'status', undefined); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(2);
    });

    it('should track size by domain', () => {
      cache.set('tasks', 'list', undefined, 'a');
      cache.set('tasks', 'find', undefined, 'b');
      cache.set('session', 'status', undefined, 'c');

      const stats = cache.getStats();
      expect(stats.size).toBe(3);
      expect(stats.domains['tasks']).toBe(2);
      expect(stats.domains['session']).toBe(1);
    });

    it('should reset stats', () => {
      cache.set('tasks', 'list', undefined, 'value');
      cache.get('tasks', 'list', undefined);
      cache.get('tasks', 'find', undefined);

      cache.resetStats();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.evictions).toBe(0);
    });
  });

  describe('disabled cache', () => {
    it('should always miss when disabled', () => {
      cache.destroy();
      cache = new QueryCache(30000, false);

      cache.set('tasks', 'list', undefined, 'value');

      const result = cache.get('tasks', 'list', undefined);
      expect(result).toBeUndefined();
    });

    it('should track misses when disabled', () => {
      cache.destroy();
      cache = new QueryCache(30000, false);

      cache.get('tasks', 'list', undefined);

      const stats = cache.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(0);
    });
  });

  describe('zero TTL', () => {
    it('should not cache with TTL of 0', () => {
      cache.destroy();
      cache = new QueryCache(0, true);

      cache.set('tasks', 'list', undefined, 'value');

      const result = cache.get('tasks', 'list', undefined);
      expect(result).toBeUndefined();
    });
  });

  describe('evictExpired', () => {
    it('should remove all expired entries', () => {
      cache.destroy();
      // Use a longer TTL and manually expire by waiting
      cache = new QueryCache(50, true);

      cache.set('tasks', 'list', undefined, 'a');
      cache.set('session', 'status', undefined, 'b');

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // After 100ms, entries are expired. Some may have been
          // cleaned by the periodic timer. Either way, size should be 0.
          cache.evictExpired();
          expect(cache.getStats().size).toBe(0);
          // Total evictions should be 2 (from timer or manual)
          expect(cache.getStats().evictions).toBeGreaterThanOrEqual(2);
          resolve();
        }, 100);
      });
    });
  });

  describe('buildKey', () => {
    it('should produce deterministic keys', () => {
      const key1 = cache.buildKey('tasks', 'list', { status: 'pending' });
      const key2 = cache.buildKey('tasks', 'list', { status: 'pending' });
      expect(key1).toBe(key2);
    });

    it('should produce different keys for different params', () => {
      const key1 = cache.buildKey('tasks', 'list', { status: 'pending' });
      const key2 = cache.buildKey('tasks', 'list', { status: 'active' });
      expect(key1).not.toBe(key2);
    });

    it('should produce same key regardless of param order', () => {
      const key1 = cache.buildKey('tasks', 'list', { a: 1, b: 2 });
      const key2 = cache.buildKey('tasks', 'list', { b: 2, a: 1 });
      expect(key1).toBe(key2);
    });

    it('should handle no params', () => {
      const key = cache.buildKey('system', 'version', undefined);
      expect(key).toContain('system:version:no-params');
    });
  });

  describe('destroy', () => {
    it('should clear cache and stop cleanup', () => {
      cache.set('tasks', 'list', undefined, 'value');
      cache.destroy();

      expect(cache.getStats().size).toBe(0);
    });
  });
});
