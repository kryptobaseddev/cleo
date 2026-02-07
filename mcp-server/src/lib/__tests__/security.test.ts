/**
 * Tests for Security Hardening and Input Sanitization
 *
 * @task T3144
 * @epic T3125
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  sanitizeTaskId,
  sanitizePath,
  sanitizeContent,
  validateEnum,
  sanitizeParams,
  RateLimiter,
  SecurityError,
  VALID_STATUSES,
  VALID_PRIORITIES,
  VALID_DOMAINS,
  VALID_GATEWAYS,
  DEFAULT_RATE_LIMITS,
} from '../security.js';

describe('Security Module', () => {
  describe('sanitizeTaskId', () => {
    it('should accept valid task IDs', () => {
      expect(sanitizeTaskId('T1')).toBe('T1');
      expect(sanitizeTaskId('T123')).toBe('T123');
      expect(sanitizeTaskId('T999999')).toBe('T999999');
    });

    it('should trim whitespace from task IDs', () => {
      expect(sanitizeTaskId('  T123  ')).toBe('T123');
      expect(sanitizeTaskId('\tT456\n')).toBe('T456');
    });

    it('should reject empty task IDs', () => {
      expect(() => sanitizeTaskId('')).toThrow(SecurityError);
      expect(() => sanitizeTaskId('  ')).toThrow(SecurityError);
    });

    it('should reject malformed task IDs', () => {
      expect(() => sanitizeTaskId('123')).toThrow(SecurityError);
      expect(() => sanitizeTaskId('t123')).toThrow(SecurityError);
      expect(() => sanitizeTaskId('T')).toThrow(SecurityError);
      expect(() => sanitizeTaskId('Task123')).toThrow(SecurityError);
      expect(() => sanitizeTaskId('T-123')).toThrow(SecurityError);
      expect(() => sanitizeTaskId('T12.3')).toThrow(SecurityError);
      expect(() => sanitizeTaskId('T123abc')).toThrow(SecurityError);
    });

    it('should reject excessively large task IDs', () => {
      expect(() => sanitizeTaskId('T1000000')).toThrow(SecurityError);
      expect(() => sanitizeTaskId('T9999999')).toThrow(SecurityError);
    });

    it('should throw SecurityError with correct code', () => {
      try {
        sanitizeTaskId('invalid');
        fail('Expected SecurityError');
      } catch (e) {
        expect(e).toBeInstanceOf(SecurityError);
        expect((e as SecurityError).code).toBe('E_INVALID_TASK_ID');
        expect((e as SecurityError).field).toBe('taskId');
      }
    });

    it('should reject non-string inputs', () => {
      expect(() => sanitizeTaskId(123 as any)).toThrow(SecurityError);
      expect(() => sanitizeTaskId(null as any)).toThrow(SecurityError);
    });
  });

  describe('sanitizePath', () => {
    const projectRoot = '/home/user/project';

    it('should accept paths within project root', () => {
      const result = sanitizePath('src/lib/test.ts', projectRoot);
      expect(result).toBe('/home/user/project/src/lib/test.ts');
    });

    it('should accept absolute paths within project root', () => {
      const result = sanitizePath('/home/user/project/src/lib/test.ts', projectRoot);
      expect(result).toBe('/home/user/project/src/lib/test.ts');
    });

    it('should accept paths with . segments', () => {
      const result = sanitizePath('./src/lib/test.ts', projectRoot);
      expect(result).toBe('/home/user/project/src/lib/test.ts');
    });

    it('should reject path traversal with ..', () => {
      expect(() => sanitizePath('../../../etc/passwd', projectRoot)).toThrow(SecurityError);
      expect(() => sanitizePath('src/../../etc/passwd', projectRoot)).toThrow(SecurityError);
    });

    it('should reject absolute paths outside project root', () => {
      expect(() => sanitizePath('/etc/passwd', projectRoot)).toThrow(SecurityError);
      expect(() => sanitizePath('/home/other/file.txt', projectRoot)).toThrow(SecurityError);
    });

    it('should reject paths with null bytes', () => {
      expect(() => sanitizePath('src/test\0.ts', projectRoot)).toThrow(SecurityError);
    });

    it('should reject empty paths', () => {
      expect(() => sanitizePath('', projectRoot)).toThrow(SecurityError);
      expect(() => sanitizePath('  ', projectRoot)).toThrow(SecurityError);
    });

    it('should throw SecurityError with E_PATH_TRAVERSAL code', () => {
      try {
        sanitizePath('../../../etc/passwd', projectRoot);
        fail('Expected SecurityError');
      } catch (e) {
        expect(e).toBeInstanceOf(SecurityError);
        expect((e as SecurityError).code).toBe('E_PATH_TRAVERSAL');
      }
    });

    it('should reject non-string inputs', () => {
      expect(() => sanitizePath(123 as any, projectRoot)).toThrow(SecurityError);
    });

    it('should reject empty project root', () => {
      expect(() => sanitizePath('test.ts', '')).toThrow(SecurityError);
    });
  });

  describe('sanitizeContent', () => {
    it('should pass through clean content', () => {
      expect(sanitizeContent('Hello, world!')).toBe('Hello, world!');
      expect(sanitizeContent('Line 1\nLine 2\tTabbed')).toBe('Line 1\nLine 2\tTabbed');
    });

    it('should strip control characters', () => {
      expect(sanitizeContent('Hello\x00World')).toBe('HelloWorld');
      expect(sanitizeContent('Test\x07bell')).toBe('Testbell');
      expect(sanitizeContent('Data\x1Fescape')).toBe('Dataescape');
    });

    it('should preserve newlines, tabs, and carriage returns', () => {
      const content = 'Line 1\nLine 2\r\nLine 3\tTabbed';
      expect(sanitizeContent(content)).toBe(content);
    });

    it('should enforce default size limit', () => {
      const oversized = 'a'.repeat(64 * 1024 + 1);
      expect(() => sanitizeContent(oversized)).toThrow(SecurityError);
    });

    it('should enforce custom size limit', () => {
      expect(() => sanitizeContent('abcdef', 5)).toThrow(SecurityError);
      expect(sanitizeContent('abcde', 5)).toBe('abcde');
    });

    it('should throw SecurityError with E_CONTENT_TOO_LARGE', () => {
      try {
        sanitizeContent('too long', 3);
        fail('Expected SecurityError');
      } catch (e) {
        expect(e).toBeInstanceOf(SecurityError);
        expect((e as SecurityError).code).toBe('E_CONTENT_TOO_LARGE');
      }
    });

    it('should accept empty strings', () => {
      expect(sanitizeContent('')).toBe('');
    });

    it('should reject non-string inputs', () => {
      expect(() => sanitizeContent(123 as any)).toThrow(SecurityError);
    });
  });

  describe('validateEnum', () => {
    const allowed = ['pending', 'active', 'blocked', 'done'];

    it('should accept valid enum values', () => {
      expect(validateEnum('pending', allowed, 'status')).toBe('pending');
      expect(validateEnum('active', allowed, 'status')).toBe('active');
      expect(validateEnum('blocked', allowed, 'status')).toBe('blocked');
      expect(validateEnum('done', allowed, 'status')).toBe('done');
    });

    it('should trim whitespace', () => {
      expect(validateEnum('  pending  ', allowed, 'status')).toBe('pending');
    });

    it('should reject invalid values', () => {
      expect(() => validateEnum('invalid', allowed, 'status')).toThrow(SecurityError);
      expect(() => validateEnum('PENDING', allowed, 'status')).toThrow(SecurityError);
      expect(() => validateEnum('', allowed, 'status')).toThrow(SecurityError);
    });

    it('should include allowed values in error message', () => {
      try {
        validateEnum('invalid', allowed, 'status');
        fail('Expected SecurityError');
      } catch (e) {
        expect((e as SecurityError).message).toContain('pending');
        expect((e as SecurityError).message).toContain('done');
        expect((e as SecurityError).code).toBe('E_INVALID_ENUM');
        expect((e as SecurityError).field).toBe('status');
      }
    });

    it('should reject non-string inputs', () => {
      expect(() => validateEnum(123 as any, allowed, 'status')).toThrow(SecurityError);
    });
  });

  describe('Enum Constants', () => {
    it('should define valid domains', () => {
      expect(VALID_DOMAINS).toContain('tasks');
      expect(VALID_DOMAINS).toContain('session');
      expect(VALID_DOMAINS).toContain('system');
      expect(VALID_DOMAINS).toHaveLength(8);
    });

    it('should define valid gateways', () => {
      expect(VALID_GATEWAYS).toContain('cleo_query');
      expect(VALID_GATEWAYS).toContain('cleo_mutate');
      expect(VALID_GATEWAYS).toHaveLength(2);
    });

    it('should define valid statuses', () => {
      expect(VALID_STATUSES).toContain('pending');
      expect(VALID_STATUSES).toContain('active');
      expect(VALID_STATUSES).toContain('blocked');
      expect(VALID_STATUSES).toContain('done');
      expect(VALID_STATUSES).toHaveLength(4);
    });

    it('should define valid priorities', () => {
      expect(VALID_PRIORITIES).toContain('low');
      expect(VALID_PRIORITIES).toContain('medium');
      expect(VALID_PRIORITIES).toContain('high');
      expect(VALID_PRIORITIES).toContain('critical');
      expect(VALID_PRIORITIES).toHaveLength(4);
    });
  });

  describe('RateLimiter', () => {
    let limiter: RateLimiter;

    beforeEach(() => {
      limiter = new RateLimiter({
        query: { maxRequests: 3, windowMs: 1000 },
        mutate: { maxRequests: 2, windowMs: 1000 },
      });
    });

    it('should allow requests within limit', () => {
      const result = limiter.check('query');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(3);
      expect(result.limit).toBe(3);
    });

    it('should track consumed requests', () => {
      const r1 = limiter.consume('query');
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);

      const r2 = limiter.consume('query');
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);

      const r3 = limiter.consume('query');
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);

      const r4 = limiter.consume('query');
      expect(r4.allowed).toBe(false);
      expect(r4.remaining).toBe(0);
    });

    it('should enforce per-key limits independently', () => {
      // Exhaust mutate limit
      limiter.consume('mutate');
      limiter.consume('mutate');
      const r3 = limiter.consume('mutate');
      expect(r3.allowed).toBe(false);

      // Query should still be available
      const qr = limiter.consume('query');
      expect(qr.allowed).toBe(true);
    });

    it('should allow unknown keys by default', () => {
      const result = limiter.check('unknown');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(Infinity);
    });

    it('should reset specific key', () => {
      limiter.consume('query');
      limiter.consume('query');
      limiter.consume('query');

      // Exhausted
      expect(limiter.check('query').allowed).toBe(false);

      // Reset
      limiter.reset('query');
      expect(limiter.check('query').allowed).toBe(true);
      expect(limiter.check('query').remaining).toBe(3);
    });

    it('should reset all keys', () => {
      limiter.consume('query');
      limiter.consume('mutate');

      limiter.reset();

      expect(limiter.check('query').remaining).toBe(3);
      expect(limiter.check('mutate').remaining).toBe(2);
    });

    it('should use default rate limits when no config provided', () => {
      const defaultLimiter = new RateLimiter();
      const queryConfig = defaultLimiter.getConfig('query');
      expect(queryConfig).toBeDefined();
      expect(queryConfig!.maxRequests).toBe(100);
      expect(queryConfig!.windowMs).toBe(60_000);
    });

    it('should allow updating config', () => {
      limiter.setConfig('spawn', { maxRequests: 5, windowMs: 2000 });
      const config = limiter.getConfig('spawn');
      expect(config).toBeDefined();
      expect(config!.maxRequests).toBe(5);
    });

    it('should provide resetMs information', () => {
      limiter.consume('query');
      const result = limiter.check('query');
      // resetMs should be positive (within the window)
      expect(result.resetMs).toBeGreaterThanOrEqual(0);
      expect(result.resetMs).toBeLessThanOrEqual(1000);
    });
  });

  describe('DEFAULT_RATE_LIMITS', () => {
    it('should define query limits', () => {
      expect(DEFAULT_RATE_LIMITS.query.maxRequests).toBe(100);
      expect(DEFAULT_RATE_LIMITS.query.windowMs).toBe(60_000);
    });

    it('should define mutate limits', () => {
      expect(DEFAULT_RATE_LIMITS.mutate.maxRequests).toBe(30);
      expect(DEFAULT_RATE_LIMITS.mutate.windowMs).toBe(60_000);
    });

    it('should define spawn limits', () => {
      expect(DEFAULT_RATE_LIMITS.spawn.maxRequests).toBe(10);
      expect(DEFAULT_RATE_LIMITS.spawn.windowMs).toBe(60_000);
    });
  });

  describe('sanitizeParams', () => {
    it('should return undefined for undefined params', () => {
      expect(sanitizeParams(undefined)).toBeUndefined();
    });

    it('should sanitize taskId fields', () => {
      const result = sanitizeParams({ taskId: '  T123  ' });
      expect(result?.taskId).toBe('T123');
    });

    it('should sanitize parent fields', () => {
      const result = sanitizeParams({ parent: 'T456' });
      expect(result?.parent).toBe('T456');
    });

    it('should sanitize epicId fields', () => {
      const result = sanitizeParams({ epicId: 'T789' });
      expect(result?.epicId).toBe('T789');
    });

    it('should sanitize depends arrays', () => {
      const result = sanitizeParams({ depends: ['T1', 'T2', 'T3'] });
      expect(result?.depends).toEqual(['T1', 'T2', 'T3']);
    });

    it('should reject invalid task IDs in params', () => {
      expect(() => sanitizeParams({ taskId: 'invalid' })).toThrow(SecurityError);
    });

    it('should sanitize content fields', () => {
      const result = sanitizeParams({
        title: 'Test\x00Title',
        description: 'Clean description',
      });
      expect(result?.title).toBe('TestTitle');
      expect(result?.description).toBe('Clean description');
    });

    it('should enforce title length limit', () => {
      const longTitle = 'a'.repeat(201);
      expect(() => sanitizeParams({ title: longTitle })).toThrow(SecurityError);
    });

    it('should validate status enum', () => {
      const result = sanitizeParams({ status: 'pending' });
      expect(result?.status).toBe('pending');

      expect(() => sanitizeParams({ status: 'invalid' })).toThrow(SecurityError);
    });

    it('should validate priority enum', () => {
      const result = sanitizeParams({ priority: 'high' });
      expect(result?.priority).toBe('high');

      expect(() => sanitizeParams({ priority: 'urgent' })).toThrow(SecurityError);
    });

    it('should pass through unknown fields unchanged', () => {
      const result = sanitizeParams({ customField: 42, anotherField: true });
      expect(result?.customField).toBe(42);
      expect(result?.anotherField).toBe(true);
    });

    it('should skip null and undefined values', () => {
      const result = sanitizeParams({ taskId: null as any, status: undefined });
      expect(result?.taskId).toBeNull();
      expect(result?.status).toBeUndefined();
    });

    it('should sanitize notes as string', () => {
      const result = sanitizeParams({ notes: 'A note\x00with control' });
      expect(result?.notes).toBe('A notewith control');
    });

    it('should sanitize notes as array of strings', () => {
      const result = sanitizeParams({ notes: ['Note 1\x00', 'Note 2'] });
      expect(result?.notes).toEqual(['Note 1', 'Note 2']);
    });

    it('should sanitize path fields when projectRoot provided', () => {
      const result = sanitizeParams(
        { path: 'src/test.ts' },
        '/home/user/project'
      );
      expect(result?.path).toBe('/home/user/project/src/test.ts');
    });

    it('should reject path traversal in params', () => {
      expect(() =>
        sanitizeParams(
          { path: '../../../etc/passwd' },
          '/home/user/project'
        )
      ).toThrow(SecurityError);
    });
  });

  describe('SecurityError', () => {
    it('should be an instance of Error', () => {
      const err = new SecurityError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(SecurityError);
    });

    it('should have correct name', () => {
      const err = new SecurityError('test');
      expect(err.name).toBe('SecurityError');
    });

    it('should have default code', () => {
      const err = new SecurityError('test');
      expect(err.code).toBe('E_SECURITY_VIOLATION');
    });

    it('should accept custom code and field', () => {
      const err = new SecurityError('test', 'E_CUSTOM', 'myField');
      expect(err.code).toBe('E_CUSTOM');
      expect(err.field).toBe('myField');
    });
  });
});
