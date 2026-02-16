/**
 * Tests for injection registry (injection-registry.ts).
 * @task T4552
 * @epic T4545
 */

import { describe, it, expect } from 'vitest';
import {
  INJECTION_TARGETS,
  INJECTION_MARKER_START,
  INJECTION_MARKER_END,
  INJECTION_VALIDATION_KEYS,
  isInjectionTarget,
  getValidationKey,
  extractMarkerVersion,
} from '../injection-registry.js';

describe('INJECTION_TARGETS', () => {
  it('should contain exactly 3 targets', () => {
    expect(INJECTION_TARGETS).toHaveLength(3);
  });

  it('should include CLAUDE.md, AGENTS.md, and GEMINI.md', () => {
    expect(INJECTION_TARGETS).toContain('CLAUDE.md');
    expect(INJECTION_TARGETS).toContain('AGENTS.md');
    expect(INJECTION_TARGETS).toContain('GEMINI.md');
  });
});

describe('INJECTION_MARKER_START', () => {
  it('should be the correct marker', () => {
    expect(INJECTION_MARKER_START).toBe('<!-- CLEO:START');
  });
});

describe('INJECTION_MARKER_END', () => {
  it('should be the correct marker', () => {
    expect(INJECTION_MARKER_END).toBe('<!-- CLEO:END -->');
  });
});

describe('isInjectionTarget', () => {
  it('should return true for valid targets', () => {
    expect(isInjectionTarget('CLAUDE.md')).toBe(true);
    expect(isInjectionTarget('AGENTS.md')).toBe(true);
    expect(isInjectionTarget('GEMINI.md')).toBe(true);
  });

  it('should return false for invalid targets', () => {
    expect(isInjectionTarget('README.md')).toBe(false);
    expect(isInjectionTarget('CODEX.md')).toBe(false);
    expect(isInjectionTarget('')).toBe(false);
  });
});

describe('getValidationKey', () => {
  it('should return correct keys for each target', () => {
    expect(getValidationKey('CLAUDE.md')).toBe('claude_md');
    expect(getValidationKey('AGENTS.md')).toBe('agents_md');
    expect(getValidationKey('GEMINI.md')).toBe('gemini_md');
  });
});

describe('INJECTION_VALIDATION_KEYS', () => {
  it('should have entries for all targets', () => {
    for (const target of INJECTION_TARGETS) {
      expect(INJECTION_VALIDATION_KEYS[target]).toBeDefined();
    }
  });
});

describe('extractMarkerVersion', () => {
  it('should return null for current format (no version)', () => {
    expect(extractMarkerVersion('<!-- CLEO:START -->')).toBeNull();
  });

  it('should extract version from legacy format', () => {
    expect(extractMarkerVersion('<!-- CLEO:START v0.58.6 -->')).toBe('0.58.6');
  });

  it('should return null for non-matching strings', () => {
    expect(extractMarkerVersion('not a marker')).toBeNull();
    expect(extractMarkerVersion('')).toBeNull();
  });

  it('should handle various version formats', () => {
    expect(extractMarkerVersion('CLEO:START v1.0.0 -->')).toBe('1.0.0');
    expect(extractMarkerVersion('CLEO:START v10.20.30 -->')).toBe('10.20.30');
  });
});
