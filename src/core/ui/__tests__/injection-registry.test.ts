/**
 * Tests for injection legacy utilities (injection-legacy.ts).
 *
 * These test the remaining utility functions kept from the deleted
 * injection-registry.ts for backward compatibility.
 *
 * @task T4677
 * @epic T4663
 */

import { describe, it, expect } from 'vitest';
import {
  INJECTION_VALIDATION_KEYS,
  getValidationKey,
  extractMarkerVersion,
} from '../injection-legacy.js';

describe('getValidationKey', () => {
  it('should return correct keys for known targets', () => {
    expect(getValidationKey('CLAUDE.md')).toBe('claude_md');
    expect(getValidationKey('AGENTS.md')).toBe('agents_md');
    expect(getValidationKey('GEMINI.md')).toBe('gemini_md');
  });

  it('should generate a key for unknown targets', () => {
    expect(getValidationKey('CODEX.md')).toBe('codex_md');
    expect(getValidationKey('README.md')).toBe('readme_md');
  });
});

describe('INJECTION_VALIDATION_KEYS', () => {
  it('should have entries for the 3 known targets', () => {
    expect(INJECTION_VALIDATION_KEYS['CLAUDE.md']).toBe('claude_md');
    expect(INJECTION_VALIDATION_KEYS['AGENTS.md']).toBe('agents_md');
    expect(INJECTION_VALIDATION_KEYS['GEMINI.md']).toBe('gemini_md');
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
