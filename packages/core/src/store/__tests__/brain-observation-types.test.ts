/**
 * Tests for BRAIN_OBSERVATION_TYPES enum (T1005).
 * Verifies that 'diary' type is properly added to both schema and contract layers.
 */

import type { BrainObservationType } from '@cleocode/contracts';
import { BRAIN_OBSERVATION_TYPES as ContractTypes } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { BRAIN_OBSERVATION_TYPES as SchemaTypes } from '../memory-schema.js';

describe('BRAIN_OBSERVATION_TYPES', () => {
  it('should include diary type in schema', () => {
    expect(SchemaTypes).toContain('diary');
  });

  it('should have exactly 7 observation types in schema', () => {
    expect(SchemaTypes).toHaveLength(7);
  });

  it('should include diary type in contracts facade', () => {
    expect(ContractTypes).toContain('diary');
  });

  it('should have exactly 7 observation types in contracts', () => {
    expect(ContractTypes).toHaveLength(7);
  });

  it('should match between schema and contracts', () => {
    expect(SchemaTypes).toEqual(ContractTypes);
  });

  it('should accept diary as valid BrainObservationType', () => {
    const diaryType: BrainObservationType = 'diary';
    expect(ContractTypes).toContain(diaryType);
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
    ];
    for (const t of required) {
      expect(SchemaTypes).toContain(t);
    }
  });
});
