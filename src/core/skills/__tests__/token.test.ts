/**
 * Tests for token injection.
 * @task T4522
 */

import { describe, it, expect } from 'vitest';
import {
  injectTokens,
  hasUnresolvedTokens,
  validateRequired,
  validateTokenValue,
  validateAllTokens,
  buildDefaults,
} from '../injection/token.js';

describe('injectTokens', () => {
  it('should replace {{TOKEN}} patterns', () => {
    const template = 'Task: {{TASK_ID}}, Date: {{DATE}}';
    const result = injectTokens(template, { TASK_ID: 'T1234', DATE: '2026-01-15' });

    expect(result).toBe('Task: T1234, Date: 2026-01-15');
  });

  it('should leave unresolved tokens as-is', () => {
    const template = 'Task: {{TASK_ID}}, Unknown: {{UNKNOWN_TOKEN}}';
    const result = injectTokens(template, { TASK_ID: 'T1234' });

    expect(result).toBe('Task: T1234, Unknown: {{UNKNOWN_TOKEN}}');
  });

  it('should apply defaults for CLEO commands', () => {
    const template = 'Run: {{TASK_SHOW_CMD}} {{TASK_ID}}';
    const result = injectTokens(template, { TASK_ID: 'T1234' });

    expect(result).toBe('Run: cleo show T1234');
  });

  it('should allow explicit values to override defaults', () => {
    const template = '{{TASK_SHOW_CMD}} {{TASK_ID}}';
    const result = injectTokens(template, { TASK_ID: 'T1234', TASK_SHOW_CMD: 'ct show' });

    expect(result).toBe('ct show T1234');
  });

  it('should handle multiple occurrences of same token', () => {
    const template = '{{TASK_ID}} and {{TASK_ID}} again';
    const result = injectTokens(template, { TASK_ID: 'T100' });

    expect(result).toBe('T100 and T100 again');
  });

  it('should handle empty template', () => {
    expect(injectTokens('', {})).toBe('');
  });
});

describe('hasUnresolvedTokens', () => {
  it('should detect unresolved tokens', () => {
    const content = 'Task: {{TASK_ID}}, Date: {{DATE}}';
    const unresolved = hasUnresolvedTokens(content);

    expect(unresolved).toEqual(['TASK_ID', 'DATE']);
  });

  it('should return empty for fully resolved content', () => {
    const content = 'Task: T1234, Date: 2026-01-15';
    expect(hasUnresolvedTokens(content)).toEqual([]);
  });

  it('should deduplicate tokens', () => {
    const content = '{{TASK_ID}} and {{TASK_ID}} again';
    expect(hasUnresolvedTokens(content)).toEqual(['TASK_ID']);
  });
});

describe('validateTokenValue', () => {
  it('should validate TASK_ID format', () => {
    expect(validateTokenValue('TASK_ID', 'T123').valid).toBe(true);
    expect(validateTokenValue('TASK_ID', 'T0').valid).toBe(true);
    expect(validateTokenValue('TASK_ID', 'bad').valid).toBe(false);
    expect(validateTokenValue('TASK_ID', '').valid).toBe(false);
  });

  it('should validate DATE format', () => {
    expect(validateTokenValue('DATE', '2026-01-15').valid).toBe(true);
    expect(validateTokenValue('DATE', 'bad-date').valid).toBe(false);
    expect(validateTokenValue('DATE', '').valid).toBe(false);
  });

  it('should validate TOPIC_SLUG format', () => {
    expect(validateTokenValue('TOPIC_SLUG', 'my-topic').valid).toBe(true);
    expect(validateTokenValue('TOPIC_SLUG', 'with_underscore').valid).toBe(true);
    expect(validateTokenValue('TOPIC_SLUG', 'has spaces').valid).toBe(false);
  });

  it('should accept any value for unknown tokens', () => {
    expect(validateTokenValue('UNKNOWN', 'anything').valid).toBe(true);
  });
});

describe('validateRequired', () => {
  it('should pass when all required tokens present', () => {
    const result = validateRequired({
      TASK_ID: 'T123',
      DATE: '2026-01-15',
      TOPIC_SLUG: 'my-topic',
    });

    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it('should report missing tokens', () => {
    const result = validateRequired({ TASK_ID: 'T123' });

    expect(result.valid).toBe(false);
    expect(result.missing).toContain('DATE');
    expect(result.missing).toContain('TOPIC_SLUG');
  });

  it('should report invalid format', () => {
    const result = validateRequired({
      TASK_ID: 'bad',
      DATE: '2026-01-15',
      TOPIC_SLUG: 'my-topic',
    });

    expect(result.valid).toBe(false);
    expect(result.invalid.length).toBe(1);
    expect(result.invalid[0].token).toBe('TASK_ID');
  });
});

describe('validateAllTokens', () => {
  it('should validate all provided tokens', () => {
    const result = validateAllTokens({
      TASK_ID: 'T123',
      DATE: '2026-01-15',
      EPIC_ID: 'T001',
    });

    expect(result.valid).toBe(true);
  });

  it('should report invalid tokens', () => {
    const result = validateAllTokens({
      TASK_ID: 'bad-format',
      DATE: 'not-a-date',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
  });

  it('should skip empty optional tokens', () => {
    const result = validateAllTokens({
      TASK_ID: 'T123',
      EPIC_ID: '', // empty optional = ok
    });

    expect(result.valid).toBe(true);
  });
});

describe('buildDefaults', () => {
  it('should return default CLEO command values', () => {
    const defaults = buildDefaults();

    expect(defaults['TASK_SHOW_CMD']).toBe('cleo show');
    expect(defaults['TASK_FOCUS_CMD']).toBe('cleo focus set');
    expect(defaults['DASH_CMD']).toBe('cleo dash');
    expect(defaults['OUTPUT_DIR']).toBe('claudedocs/agent-outputs');
  });
});
