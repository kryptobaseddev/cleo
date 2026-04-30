/**
 * Tests for BRAIN_OBSERVATION_TYPES enum (T1005, T1615).
 * Verifies that 'diary' and 'session-summary' types are properly added to
 * both schema and contract layers.
 */

import type { BrainObservationType } from '@cleocode/contracts';
import { BRAIN_OBSERVATION_TYPES as ContractTypes } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { BRAIN_OBSERVATION_TYPES as SchemaTypes } from '../memory-schema.js';

describe('BRAIN_OBSERVATION_TYPES', () => {
  it('should include diary type in schema', () => {
    expect(SchemaTypes).toContain('diary');
  });

  it('should include session-summary type in schema', () => {
    expect(SchemaTypes).toContain('session-summary');
  });

  it('should have exactly 8 observation types in schema', () => {
    expect(SchemaTypes).toHaveLength(8);
  });

  it('should include diary type in contracts facade', () => {
    expect(ContractTypes).toContain('diary');
  });

  it('should include session-summary type in contracts facade', () => {
    expect(ContractTypes).toContain('session-summary');
  });

  it('should have exactly 8 observation types in contracts', () => {
    expect(ContractTypes).toHaveLength(8);
  });

  it('should match between schema and contracts', () => {
    expect(SchemaTypes).toEqual(ContractTypes);
  });

  it('should accept diary as valid BrainObservationType', () => {
    const diaryType: BrainObservationType = 'diary';
    expect(ContractTypes).toContain(diaryType);
  });

  it('should accept session-summary as valid BrainObservationType', () => {
    const summaryType: BrainObservationType = 'session-summary';
    expect(ContractTypes).toContain(summaryType);
  });

  it('should accept all required observation types', () => {
    const required: BrainObservationType[] = [
      'discovery',
      'change',
      'feature',
      'bugfix',
      'decision',
      'refactor',
      'diary',
      'session-summary',
    ];
    for (const t of required) {
      expect(SchemaTypes).toContain(t);
    }
  });
});
