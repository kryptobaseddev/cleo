/**
 * Type-level and runtime shape tests for T10510 Validator role contracts.
 *
 * Covers the AgentRole enum extension and the four envelope types
 * (`ValidatorFinding`, `ValidatorAttestation`, `ValidatorRejection`,
 * `ValidatorVerdict`) plus their Zod schemas and type guards.
 *
 * @task T10510
 * @epic T10383 (E-VALIDATOR-ROLE)
 * @saga T10377 (SG-IVTR-AC-BINDING)
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLES,
  type AgentRole,
  isAgentRole,
  isValidatorAttestation,
  isValidatorRejection,
  isValidatorVerdict,
  VALIDATOR_ID_REGEX,
  type ValidatorAttestation,
  type ValidatorFinding,
  type ValidatorRejection,
  type ValidatorVerdict,
  validatorAttestationSchema,
  validatorFindingSchema,
  validatorRejectionSchema,
  validatorVerdictSchema,
} from '../validator/index.js';

// ============================================================================
// Test fixtures
// ============================================================================

const NOW = '2026-05-24T12:00:00Z';

const passFinding: ValidatorFinding = {
  acId: '11111111-1111-4111-8111-111111111111',
  status: 'pass',
  reasoning: 'AC satisfied — implementation matches spec',
  checkedAt: NOW,
};

const failFinding: ValidatorFinding = {
  acId: '22222222-2222-4222-8222-222222222222',
  status: 'fail',
  reasoning: 'Missing error handling for the null branch',
  evidenceRefs: ['src/foo.ts:42', 'tests/foo.test.ts:17'],
  checkedAt: NOW,
};

const inconclusiveFinding: ValidatorFinding = {
  acId: '33333333-3333-4333-8333-333333333333',
  status: 'inconclusive',
  reasoning: 'Cannot reproduce the claimed test — file not present',
  checkedAt: NOW,
};

// ============================================================================
// AgentRole enum
// ============================================================================

describe('AgentRole enum (T10510)', () => {
  it('contains the four canonical roles', () => {
    expect(AGENT_ROLES).toEqual(['orchestrator', 'lead', 'worker', 'validator']);
  });

  it('AGENT_ROLES is a readonly tuple of length 4', () => {
    // `as const` is a compile-time readonly marker — there is no runtime
    // freeze. The TS type guard below ensures mutation attempts are rejected
    // by the compiler; runtime length is the structural invariant.
    expect(AGENT_ROLES.length).toBe(4);
    // @ts-expect-error — readonly tuple disallows .push at the type level.
    AGENT_ROLES.push;
  });

  it('AgentRole type compiles for all four values', () => {
    const roles: AgentRole[] = ['orchestrator', 'lead', 'worker', 'validator'];
    expect(roles).toHaveLength(4);
  });

  it('isAgentRole accepts canonical values', () => {
    for (const r of AGENT_ROLES) {
      expect(isAgentRole(r)).toBe(true);
    }
  });

  it('isAgentRole rejects unknown strings and non-strings', () => {
    expect(isAgentRole('subagent')).toBe(false);
    expect(isAgentRole('Validator')).toBe(false);
    expect(isAgentRole('')).toBe(false);
    expect(isAgentRole(undefined)).toBe(false);
    expect(isAgentRole(null)).toBe(false);
    expect(isAgentRole(42)).toBe(false);
    expect(isAgentRole({})).toBe(false);
  });
});

// ============================================================================
// VALIDATOR_ID_REGEX
// ============================================================================

describe('VALIDATOR_ID_REGEX (T10510)', () => {
  it('accepts canonical validator agentIds', () => {
    expect(VALIDATOR_ID_REGEX.test('validator-prime')).toBe(true);
    expect(VALIDATOR_ID_REGEX.test('validator-sec-001')).toBe(true);
    expect(VALIDATOR_ID_REGEX.test('validator-a')).toBe(true);
    expect(VALIDATOR_ID_REGEX.test('validator-9-test')).toBe(true);
  });

  it('rejects malformed validator agentIds', () => {
    expect(VALIDATOR_ID_REGEX.test('validator-')).toBe(false);
    expect(VALIDATOR_ID_REGEX.test('Validator-prime')).toBe(false);
    expect(VALIDATOR_ID_REGEX.test('validator-Prime')).toBe(false);
    expect(VALIDATOR_ID_REGEX.test('worker-prime')).toBe(false);
    expect(VALIDATOR_ID_REGEX.test('validator-_x')).toBe(false);
  });
});

// ============================================================================
// ValidatorFinding
// ============================================================================

describe('ValidatorFinding (T10510)', () => {
  it('accepts pass / fail / inconclusive', () => {
    expect(validatorFindingSchema.safeParse(passFinding).success).toBe(true);
    expect(validatorFindingSchema.safeParse(failFinding).success).toBe(true);
    expect(validatorFindingSchema.safeParse(inconclusiveFinding).success).toBe(true);
  });

  it('rejects empty acId', () => {
    const bad = { ...passFinding, acId: '' };
    expect(validatorFindingSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects empty reasoning', () => {
    const bad = { ...passFinding, reasoning: '' };
    expect(validatorFindingSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown status value', () => {
    const bad = { ...passFinding, status: 'warn' };
    expect(validatorFindingSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts optional evidenceRefs array', () => {
    const withRefs = { ...passFinding, evidenceRefs: ['a', 'b'] };
    expect(validatorFindingSchema.safeParse(withRefs).success).toBe(true);
  });
});

// ============================================================================
// ValidatorAttestation
// ============================================================================

describe('ValidatorAttestation (T10510)', () => {
  const baseAttestation: ValidatorAttestation = {
    verdict: 'attest',
    taskId: 'T10510',
    validatorId: 'validator-prime',
    findings: [passFinding],
    attestedAt: NOW,
    schemaVersion: '1',
  };

  it('accepts a well-formed attestation with all passes', () => {
    expect(validatorAttestationSchema.safeParse(baseAttestation).success).toBe(true);
  });

  it('accepts optional summary', () => {
    const withSummary = { ...baseAttestation, summary: 'All ACs verified' };
    expect(validatorAttestationSchema.safeParse(withSummary).success).toBe(true);
  });

  it('accepts multiple pass findings', () => {
    const multi = {
      ...baseAttestation,
      findings: [passFinding, { ...passFinding, acId: '44444444-4444-4444-8444-444444444444' }],
    };
    expect(validatorAttestationSchema.safeParse(multi).success).toBe(true);
  });

  it('REJECTS attestation containing any fail finding', () => {
    const mixed = { ...baseAttestation, findings: [passFinding, failFinding] };
    const r = validatorAttestationSchema.safeParse(mixed);
    expect(r.success).toBe(false);
  });

  it('REJECTS attestation containing inconclusive finding', () => {
    const mixed = { ...baseAttestation, findings: [passFinding, inconclusiveFinding] };
    expect(validatorAttestationSchema.safeParse(mixed).success).toBe(false);
  });

  it('REJECTS empty findings array', () => {
    const empty = { ...baseAttestation, findings: [] };
    expect(validatorAttestationSchema.safeParse(empty).success).toBe(false);
  });

  it('REJECTS malformed validatorId', () => {
    const bad = { ...baseAttestation, validatorId: 'worker-prime' };
    expect(validatorAttestationSchema.safeParse(bad).success).toBe(false);
  });

  it('REJECTS wrong verdict discriminant', () => {
    const bad = { ...baseAttestation, verdict: 'reject' };
    expect(validatorAttestationSchema.safeParse(bad).success).toBe(false);
  });

  it('REJECTS wrong schemaVersion', () => {
    const bad = { ...baseAttestation, schemaVersion: '2' };
    expect(validatorAttestationSchema.safeParse(bad).success).toBe(false);
  });
});

// ============================================================================
// ValidatorRejection
// ============================================================================

describe('ValidatorRejection (T10510)', () => {
  const baseRejection: ValidatorRejection = {
    verdict: 'reject',
    taskId: 'T10510',
    validatorId: 'validator-sec-001',
    findings: [failFinding],
    summary: 'AC#2 fails — null branch unhandled',
    rejectedAt: NOW,
    schemaVersion: '1',
  };

  it('accepts a well-formed rejection with a fail finding', () => {
    expect(validatorRejectionSchema.safeParse(baseRejection).success).toBe(true);
  });

  it('accepts a rejection with only an inconclusive finding', () => {
    const inc = { ...baseRejection, findings: [inconclusiveFinding] };
    expect(validatorRejectionSchema.safeParse(inc).success).toBe(true);
  });

  it('accepts mixed pass + fail findings', () => {
    const mixed = { ...baseRejection, findings: [passFinding, failFinding] };
    expect(validatorRejectionSchema.safeParse(mixed).success).toBe(true);
  });

  it('REJECTS rejection where every finding is pass', () => {
    const allPass = { ...baseRejection, findings: [passFinding, passFinding] };
    const r = validatorRejectionSchema.safeParse(allPass);
    expect(r.success).toBe(false);
  });

  it('REJECTS empty findings array', () => {
    const empty = { ...baseRejection, findings: [] };
    expect(validatorRejectionSchema.safeParse(empty).success).toBe(false);
  });

  it('REJECTS empty summary', () => {
    const bad = { ...baseRejection, summary: '' };
    expect(validatorRejectionSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts optional remediationHints', () => {
    const withHints = {
      ...baseRejection,
      remediationHints: ['Add null guard to foo()', 'Add regression test'],
    };
    expect(validatorRejectionSchema.safeParse(withHints).success).toBe(true);
  });
});

// ============================================================================
// ValidatorVerdict discriminated union
// ============================================================================

describe('ValidatorVerdict (T10510)', () => {
  const attestation: ValidatorAttestation = {
    verdict: 'attest',
    taskId: 'T10510',
    validatorId: 'validator-prime',
    findings: [passFinding],
    attestedAt: NOW,
    schemaVersion: '1',
  };
  const rejection: ValidatorRejection = {
    verdict: 'reject',
    taskId: 'T10510',
    validatorId: 'validator-prime',
    findings: [failFinding],
    summary: 'fail',
    rejectedAt: NOW,
    schemaVersion: '1',
  };

  it('schema accepts both attest and reject envelopes', () => {
    expect(validatorVerdictSchema.safeParse(attestation).success).toBe(true);
    expect(validatorVerdictSchema.safeParse(rejection).success).toBe(true);
  });

  it('schema rejects envelope with unknown verdict', () => {
    const bad = { ...attestation, verdict: 'maybe' };
    expect(validatorVerdictSchema.safeParse(bad).success).toBe(false);
  });

  it('discriminant narrows in TypeScript at compile time', () => {
    const handle = (v: ValidatorVerdict): string => {
      if (v.verdict === 'attest') {
        // TS narrows to ValidatorAttestation here
        return `attested ${v.attestedAt}`;
      }
      // TS narrows to ValidatorRejection here
      return `rejected ${v.rejectedAt} — ${v.summary}`;
    };
    expect(handle(attestation)).toContain('attested');
    expect(handle(rejection)).toContain('rejected');
  });
});

// ============================================================================
// Type guards
// ============================================================================

describe('Validator type guards (T10510)', () => {
  const attestation: ValidatorAttestation = {
    verdict: 'attest',
    taskId: 'T10510',
    validatorId: 'validator-prime',
    findings: [passFinding],
    attestedAt: NOW,
    schemaVersion: '1',
  };
  const rejection: ValidatorRejection = {
    verdict: 'reject',
    taskId: 'T10510',
    validatorId: 'validator-prime',
    findings: [failFinding],
    summary: 'fail',
    rejectedAt: NOW,
    schemaVersion: '1',
  };

  it('isValidatorAttestation returns true only for attestations', () => {
    expect(isValidatorAttestation(attestation)).toBe(true);
    expect(isValidatorAttestation(rejection)).toBe(false);
    expect(isValidatorAttestation(null)).toBe(false);
    expect(isValidatorAttestation({})).toBe(false);
  });

  it('isValidatorRejection returns true only for rejections', () => {
    expect(isValidatorRejection(rejection)).toBe(true);
    expect(isValidatorRejection(attestation)).toBe(false);
    expect(isValidatorRejection(null)).toBe(false);
  });

  it('isValidatorVerdict returns true for both shapes', () => {
    expect(isValidatorVerdict(attestation)).toBe(true);
    expect(isValidatorVerdict(rejection)).toBe(true);
    expect(isValidatorVerdict({ verdict: 'attest' })).toBe(false);
    expect(isValidatorVerdict(null)).toBe(false);
  });
});
