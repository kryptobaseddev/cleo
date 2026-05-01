/**
 * Validate Engine Shim Tests
 *
 * Verifies that the validate-engine re-export shim correctly exposes the
 * core validation functions migrated in ENG-MIG-7 / T1574.
 *
 * The actual business logic is tested in:
 *   packages/core/src/validation/__tests__/
 *
 * @task T1574 — ENG-MIG-7
 * @task T4477
 */

import { describe, expect, it } from 'vitest';
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
} from '../validate-engine.js';

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
