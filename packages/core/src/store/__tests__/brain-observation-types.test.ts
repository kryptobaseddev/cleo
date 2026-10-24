/**
 * Tests for BRAIN_OBSERVATION_TYPES enum (T1005, T13949).
 * Pins the exact type list in both the schema and contract layers.
 */

import type { BrainObservationType } from '@cleocode/contracts';
import { BRAIN_OBSERVATION_TYPES as ContractTypes } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { BRAIN_OBSERVATION_TYPES as SchemaTypes } from '../schema/memory-schema.js';

/** The full set, in declaration order (T1005 added diary, T13949 added lesson). */
const EXPECTED = [
  'discovery',
  'change',
  'feature',
  'bugfix',
  'decision',
  'refactor',
  'diary',
  'session-summary',
  'lesson',
] as const;

describe('BRAIN_OBSERVATION_TYPES', () => {
  it('schema declares exactly the expected observation types', () => {
    expect(SchemaTypes).toEqual(EXPECTED);
  });

  it('contracts facade declares exactly the expected observation types', () => {
    expect(ContractTypes).toEqual(EXPECTED);
  });

  it('should accept diary and lesson as valid BrainObservationType values', () => {
    const diaryType: BrainObservationType = 'diary';
    const lessonType: BrainObservationType = 'lesson';
    expect(ContractTypes).toContain(diaryType);
    expect(ContractTypes).toContain(lessonType);
  });
});
