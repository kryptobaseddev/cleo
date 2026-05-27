/**
 * Validate Engine — core export tests.
 *
 * Verifies that the core validation functions migrated in ENG-MIG-7 / T1574
 * are exported from @cleocode/core/internal.
 *
 * Relocated from packages/cleo/src/dispatch/engines/__tests__/ per T1889 Wave 7.
 *
 * @task T1574 — ENG-MIG-7
 * @task T4477
 * @task T9061 — T1889 Wave 7 relocation
 */

import {
  validateGateVerify,
  validateProtocolArchitectureDecision,
  validateProtocolArtifactPublish,
  validateProtocolConsensus,
  validateProtocolContribution,
  validateProtocolDecomposition,
  validateProtocolImplementation,
  validateProtocolProvenance,
  validateProtocolRelease,
  validateProtocolResearch,
  validateProtocolSpecification,
  validateProtocolTesting,
  validateProtocolValidation,
} from '@cleocode/core/internal';
import { describe, expect, it } from 'vitest';

describe('validate-engine shim (ENG-MIG-7)', () => {
  it('re-exports validateGateVerify from core', () => {
    expect(typeof validateGateVerify).toBe('function');
  });

  it('re-exports all 12 protocol validators from core', () => {
    expect(typeof validateProtocolConsensus).toBe('function');
    expect(typeof validateProtocolContribution).toBe('function');
    expect(typeof validateProtocolDecomposition).toBe('function');
    expect(typeof validateProtocolImplementation).toBe('function');
    expect(typeof validateProtocolSpecification).toBe('function');
    expect(typeof validateProtocolResearch).toBe('function');
    expect(typeof validateProtocolArchitectureDecision).toBe('function');
    expect(typeof validateProtocolValidation).toBe('function');
    expect(typeof validateProtocolTesting).toBe('function');
    expect(typeof validateProtocolRelease).toBe('function');
    expect(typeof validateProtocolArtifactPublish).toBe('function');
    expect(typeof validateProtocolProvenance).toBe('function');
  });
});
