/**
 * Unit tests for the Wave 1E same-origin guard.
 */

import { describe, expect, it } from 'vitest';
import { deriveCsrfToken, isSameOriginRequest } from '../csrf.js';

describe('deriveCsrfToken', () => {
  it('returns a 24-char token for a given project id', () => {
    const tok = deriveCsrfToken('proj-abc');
    expect(tok).toMatch(/^[0-9a-f]{24}$/);
  });

  it('returns the same token for the same input within one process', () => {
    const a = deriveCsrfToken('proj-abc');
    const b = deriveCsrfToken('proj-abc');
    expect(a).toBe(b);
  });

  it('returns a different token for a different project id', () => {
    const a = deriveCsrfToken('proj-abc');
    const b = deriveCsrfToken('proj-xyz');
    expect(a).not.toBe(b);
  });
});

describe('isSameOriginRequest', () => {
  it('allows GET / HEAD / OPTIONS without an Origin header', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS'] as const) {
      const req = new Request('http://localhost:3456/api/health', { method });
      expect(isSameOriginRequest(req)).toBe(true);
    }
  });

  it('allows POSTs with matching Origin', () => {
    const req = new Request('http://localhost:3456/api/project/scan', {
      method: 'POST',
      headers: { origin: 'http://localhost:3456' },
    });
    expect(isSameOriginRequest(req)).toBe(true);
  });

  it('rejects POSTs with a cross-origin Origin header', () => {
    const req = new Request('http://localhost:3456/api/project/scan', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(isSameOriginRequest(req)).toBe(false);
  });

  it('falls back to Referer when Origin is absent', () => {
    const good = new Request('http://localhost:3456/api/project/scan', {
      method: 'POST',
      headers: { referer: 'http://localhost:3456/projects' },
    });
    expect(isSameOriginRequest(good)).toBe(true);

    const bad = new Request('http://localhost:3456/api/project/scan', {
      method: 'POST',
      headers: { referer: 'https://evil.example.com/abuse' },
    });
    expect(isSameOriginRequest(bad)).toBe(false);
  });

  it('rejects POSTs with no Origin + no Referer', () => {
    const req = new Request('http://localhost:3456/api/project/scan', {
      method: 'POST',
    });
    expect(isSameOriginRequest(req)).toBe(false);
  });
});
