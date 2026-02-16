/**
 * Tests for verification gates.
 * @task T4528
 * @epic T4454
 */

import { describe, it, expect } from 'vitest';
import {
  initVerification,
  isValidGateName,
  isValidAgentName,
  getGateOrder,
  getGateIndex,
  getDownstreamGates,
  computePassed,
  setVerificationPassed,
  updateGate,
  resetDownstreamGates,
  incrementRound,
  logFailure,
  checkAllGatesPassed,
  isVerificationComplete,
  getVerificationStatus,
  shouldRequireVerification,
  getMissingGates,
  getGateSummary,
  checkCircularValidation,
  allEpicChildrenVerified,
  allSiblingsVerified,
} from '../verification.js';

// ============================================================================
// Initialization
// ============================================================================

describe('initVerification', () => {
  it('creates default verification object', () => {
    const v = initVerification();
    expect(v.passed).toBe(false);
    expect(v.round).toBe(0);
    expect(v.gates.implemented).toBeNull();
    expect(v.gates.documented).toBeNull();
    expect(v.lastAgent).toBeNull();
    expect(v.failureLog).toHaveLength(0);
  });
});

// ============================================================================
// Validation Helpers
// ============================================================================

describe('validation helpers', () => {
  it('isValidGateName accepts valid names', () => {
    expect(isValidGateName('implemented')).toBe(true);
    expect(isValidGateName('testsPassed')).toBe(true);
    expect(isValidGateName('documented')).toBe(true);
  });

  it('isValidGateName rejects invalid names', () => {
    expect(isValidGateName('foo')).toBe(false);
    expect(isValidGateName('')).toBe(false);
  });

  it('isValidAgentName accepts valid names', () => {
    expect(isValidAgentName('coder')).toBe(true);
    expect(isValidAgentName('testing')).toBe(true);
    expect(isValidAgentName('')).toBe(true); // empty allowed
  });

  it('isValidAgentName rejects invalid names', () => {
    expect(isValidAgentName('hacker')).toBe(false);
  });
});

// ============================================================================
// Gate Order
// ============================================================================

describe('gate order', () => {
  it('getGateOrder returns all 6 gates', () => {
    expect(getGateOrder()).toHaveLength(6);
  });

  it('getGateIndex returns correct index', () => {
    expect(getGateIndex('implemented')).toBe(0);
    expect(getGateIndex('documented')).toBe(5);
  });

  it('getDownstreamGates returns gates after given', () => {
    const downstream = getDownstreamGates('implemented');
    expect(downstream).toHaveLength(5);
    expect(downstream[0]).toBe('testsPassed');
  });

  it('getDownstreamGates returns empty for last gate', () => {
    expect(getDownstreamGates('documented')).toHaveLength(0);
  });
});

// ============================================================================
// Gate Updates
// ============================================================================

describe('updateGate', () => {
  it('sets a gate value', () => {
    const v = initVerification();
    const updated = updateGate(v, 'implemented', true, 'coder');
    expect(updated.gates.implemented).toBe(true);
    expect(updated.lastAgent).toBe('coder');
  });

  it('throws for invalid gate', () => {
    const v = initVerification();
    expect(() => updateGate(v, 'invalid' as any, true)).toThrow();
  });

  it('throws for invalid agent', () => {
    const v = initVerification();
    expect(() => updateGate(v, 'implemented', true, 'hacker')).toThrow();
  });
});

describe('resetDownstreamGates', () => {
  it('resets all gates after the given one', () => {
    let v = initVerification();
    v = updateGate(v, 'implemented', true);
    v = updateGate(v, 'testsPassed', true);
    v = updateGate(v, 'qaPassed', true);

    const reset = resetDownstreamGates(v, 'implemented');
    expect(reset.gates.implemented).toBe(true); // not reset
    expect(reset.gates.testsPassed).toBeNull(); // reset
    expect(reset.gates.qaPassed).toBeNull(); // reset
  });
});

// ============================================================================
// Compute Passed
// ============================================================================

describe('computePassed', () => {
  it('returns false when required gates are missing', () => {
    const v = initVerification();
    expect(computePassed(v)).toBe(false);
  });

  it('returns true when all required gates are true', () => {
    let v = initVerification();
    v = updateGate(v, 'implemented', true);
    v = updateGate(v, 'testsPassed', true);
    v = updateGate(v, 'qaPassed', true);
    v = updateGate(v, 'securityPassed', true);
    v = updateGate(v, 'documented', true);
    expect(computePassed(v)).toBe(true);
  });

  it('returns true with custom required gates', () => {
    let v = initVerification();
    v = updateGate(v, 'implemented', true);
    expect(computePassed(v, ['implemented'])).toBe(true);
  });
});

// ============================================================================
// Round Management
// ============================================================================

describe('incrementRound', () => {
  it('increments round', () => {
    const v = initVerification();
    const updated = incrementRound(v);
    expect(updated).not.toBeNull();
    expect(updated!.round).toBe(1);
  });

  it('returns null when max rounds exceeded', () => {
    let v = initVerification();
    v = { ...v, round: 5 };
    expect(incrementRound(v, 5)).toBeNull();
  });
});

// ============================================================================
// Failure Logging
// ============================================================================

describe('logFailure', () => {
  it('appends to failure log', () => {
    const v = initVerification();
    const updated = logFailure(v, 'testsPassed', 'testing', 'Tests failed');
    expect(updated.failureLog).toHaveLength(1);
    expect(updated.failureLog[0].gate).toBe('testsPassed');
    expect(updated.failureLog[0].reason).toBe('Tests failed');
  });
});

// ============================================================================
// Status Checks
// ============================================================================

describe('status checks', () => {
  it('getVerificationStatus returns pending for new', () => {
    expect(getVerificationStatus(initVerification())).toBe('pending');
  });

  it('getVerificationStatus returns in-progress when gates set', () => {
    const v = updateGate(initVerification(), 'implemented', true);
    expect(getVerificationStatus(v)).toBe('in-progress');
  });

  it('getVerificationStatus returns failed after failure', () => {
    const v = logFailure(initVerification(), 'testsPassed', 'testing', 'fail');
    expect(getVerificationStatus(v)).toBe('failed');
  });

  it('getVerificationStatus returns passed', () => {
    const v = setVerificationPassed(initVerification(), true);
    expect(getVerificationStatus(v)).toBe('passed');
  });

  it('getVerificationStatus returns pending for null', () => {
    expect(getVerificationStatus(null)).toBe('pending');
  });

  it('isVerificationComplete returns false for null', () => {
    expect(isVerificationComplete(null)).toBe(false);
  });

  it('shouldRequireVerification returns false for epics', () => {
    expect(shouldRequireVerification('epic')).toBe(false);
  });

  it('shouldRequireVerification returns true for tasks', () => {
    expect(shouldRequireVerification('task')).toBe(true);
  });
});

// ============================================================================
// Missing Gates
// ============================================================================

describe('getMissingGates', () => {
  it('returns all required gates when none set', () => {
    const v = initVerification();
    const missing = getMissingGates(v);
    expect(missing).toHaveLength(5); // default required gates
  });

  it('returns empty when all required gates passed', () => {
    let v = initVerification();
    v = updateGate(v, 'implemented', true);
    v = updateGate(v, 'testsPassed', true);
    v = updateGate(v, 'qaPassed', true);
    v = updateGate(v, 'securityPassed', true);
    v = updateGate(v, 'documented', true);
    expect(getMissingGates(v)).toHaveLength(0);
  });
});

// ============================================================================
// Circular Validation
// ============================================================================

describe('checkCircularValidation', () => {
  it('allows different agents', () => {
    const result = checkCircularValidation('testing', 'coder', null, null);
    expect(result.valid).toBe(true);
  });

  it('blocks self-approval (creator = validator)', () => {
    const result = checkCircularValidation('coder', 'coder', null, null);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('own work');
  });

  it('blocks validator re-testing', () => {
    const result = checkCircularValidation('qa', null, 'qa', null);
    expect(result.valid).toBe(false);
  });

  it('allows system agents', () => {
    const result = checkCircularValidation('user', 'user');
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// Epic Children Verification
// ============================================================================

describe('allEpicChildrenVerified', () => {
  it('returns true when all done children are verified', () => {
    const tasks = [
      { id: 'T1', status: 'done', parentId: 'E1', verification: { passed: true, round: 0, gates: {} as any, lastAgent: null, lastUpdated: '', failureLog: [] } },
      { id: 'T2', status: 'done', parentId: 'E1', verification: { passed: true, round: 0, gates: {} as any, lastAgent: null, lastUpdated: '', failureLog: [] } },
    ];
    expect(allEpicChildrenVerified('E1', tasks)).toBe(true);
  });

  it('returns false when children are incomplete', () => {
    const tasks = [
      { id: 'T1', status: 'done', parentId: 'E1', verification: { passed: true, round: 0, gates: {} as any, lastAgent: null, lastUpdated: '', failureLog: [] } },
      { id: 'T2', status: 'active', parentId: 'E1' },
    ];
    expect(allEpicChildrenVerified('E1', tasks)).toBe(false);
  });

  it('returns false when no children', () => {
    expect(allEpicChildrenVerified('E1', [])).toBe(false);
  });
});
