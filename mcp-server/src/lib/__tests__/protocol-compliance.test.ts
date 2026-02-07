/**
 * Comprehensive Protocol Compliance Tests
 *
 * @task T2923
 * @epic T2908
 *
 * Tests all 7 RCSD-IVTR protocol validators with exit codes 60-66, 68-70.
 * Covers all protocol requirements from lib/protocol-validation.sh
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ProtocolEnforcer, ProtocolType } from '../protocol-enforcement.js';
import { protocolFixtures } from '../../__tests__/fixtures/protocol-violations.js';
import { ExitCode } from '../exit-codes.js';

describe('Protocol Compliance Test Suite', () => {
  let enforcer: ProtocolEnforcer;

  beforeEach(() => {
    enforcer = new ProtocolEnforcer(true); // Strict mode
  });

  /**
   * Research Protocol (Exit Code 60) - Full Coverage
   */
  describe('Research Protocol (Exit Code 60)', () => {
    describe('RSCH-001: Code Modification Check', () => {
      it('should block research tasks that modify code', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.research.codeModified;
        const result = await enforcer.validateProtocol(
          ProtocolType.RESEARCH,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'RSCH-001',
            severity: 'error',
            message: expect.stringContaining('must not modify code'),
          })
        );
        expect(result.score).toBeLessThan(100);
      });

      it('should pass research tasks without code changes', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.research.valid;
        const result = await enforcer.validateProtocol(
          ProtocolType.RESEARCH,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(true);
        const rsch001Violation = result.violations.find((v) => v.requirement === 'RSCH-001');
        expect(rsch001Violation).toBeUndefined();
      });
    });

    describe('RSCH-004: Manifest Entry Required', () => {
      it('should validate manifest entry structure', async () => {
        const manifestEntry = {
          id: 'T2050-research',
          file: 'output.md',
          date: '2026-02-04',
          title: 'Research output',
          status: 'complete',
          agent_type: 'research',
          key_findings: ['F1', 'F2', 'F3'],
          linked_tasks: ['T2050'],
        };

        const result = await enforcer.validateProtocol(
          ProtocolType.RESEARCH,
          manifestEntry,
          { hasCodeChanges: false }
        );

        expect(result.valid).toBe(true);
        const rsch004Violation = result.violations.find((v) => v.requirement === 'RSCH-004');
        expect(rsch004Violation).toBeUndefined();
      });
    });

    describe('RSCH-006: Key Findings Count', () => {
      it('should reject less than 3 key findings', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.research.insufficientFindings;
        const result = await enforcer.validateProtocol(
          ProtocolType.RESEARCH,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'RSCH-006',
            severity: 'error',
          })
        );
      });

      it('should reject more than 7 key findings', async () => {
        const manifestEntry = {
          id: 'T2051-research',
          file: 'output.md',
          date: '2026-02-04',
          title: 'Research output',
          status: 'complete',
          agent_type: 'research',
          key_findings: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'], // 8 findings
          linked_tasks: ['T2051'],
        };

        const result = await enforcer.validateProtocol(
          ProtocolType.RESEARCH,
          manifestEntry,
          { hasCodeChanges: false }
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'RSCH-006',
          })
        );
      });

      it('should accept 3-7 key findings', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.research.valid;
        const result = await enforcer.validateProtocol(
          ProtocolType.RESEARCH,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(true);
      });
    });

    describe('RSCH-007: Agent Type Validation', () => {
      it('should reject incorrect agent_type', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.research.wrongAgentType;
        const result = await enforcer.validateProtocol(
          ProtocolType.RESEARCH,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'RSCH-007',
            severity: 'error',
          })
        );
      });
    });
  });

  /**
   * Consensus Protocol (Exit Code 61) - Full Coverage
   */
  describe('Consensus Protocol (Exit Code 61)', () => {
    describe('CONS-001: Voting Matrix Options', () => {
      it('should require at least 2 voting options', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.consensus.tooFewOptions;
        const result = await enforcer.validateProtocol(
          ProtocolType.CONSENSUS,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'CONS-001',
            severity: 'error',
            message: expect.stringContaining('≥2 options'),
          })
        );
      });
    });

    describe('CONS-003: Confidence Score Validation', () => {
      it('should reject confidence scores > 1.0', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.consensus.invalidConfidence;
        const result = await enforcer.validateProtocol(
          ProtocolType.CONSENSUS,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'CONS-003',
            severity: 'error',
          })
        );
      });

      it('should accept confidence scores 0.0-1.0', async () => {
        const { manifestEntry, additionalData} = protocolFixtures.consensus.valid;
        const result = await enforcer.validateProtocol(
          ProtocolType.CONSENSUS,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(true);
      });
    });

    describe('CONS-004: Threshold Validation', () => {
      it('should require 50% confidence threshold', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.consensus.thresholdNotMet;
        const result = await enforcer.validateProtocol(
          ProtocolType.CONSENSUS,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'CONS-004',
            severity: 'error',
          })
        );
      });
    });
  });

  /**
   * Specification Protocol (Exit Code 62) - Full Coverage
   */
  describe('Specification Protocol (Exit Code 62)', () => {
    describe('SPEC-001: RFC 2119 Keywords', () => {
      it('should require RFC 2119 keywords in spec content', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.specification.missingRFC2119;
        const result = await enforcer.validateProtocol(
          ProtocolType.SPECIFICATION,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'SPEC-001',
            severity: 'error',
          })
        );
      });

      it('should accept specs with MUST/SHOULD/MAY', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.specification.valid;
        const result = await enforcer.validateProtocol(
          ProtocolType.SPECIFICATION,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(true);
      });
    });

    describe('SPEC-002: Version Field', () => {
      it('should require version field in manifest', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.specification.missingVersion;
        const result = await enforcer.validateProtocol(
          ProtocolType.SPECIFICATION,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'SPEC-002',
            severity: 'error',
          })
        );
      });
    });
  });

  /**
   * Decomposition Protocol (Exit Code 63) - Full Coverage
   */
  describe('Decomposition Protocol (Exit Code 63)', () => {
    describe('DCMP-003: Hierarchy Depth', () => {
      it('should enforce max depth of 3', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.decomposition.depthExceeded;
        const result = await enforcer.validateProtocol(
          ProtocolType.DECOMPOSITION,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'DCMP-003',
            severity: 'error',
          })
        );
      });
    });

    describe('DCMP-005: Time Estimate Prohibition', () => {
      it('should reject task descriptions with time estimates', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.decomposition.timeEstimates;
        const result = await enforcer.validateProtocol(
          ProtocolType.DECOMPOSITION,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'DCMP-005',
            severity: 'error',
            message: expect.stringContaining('time estimates'),
          })
        );
      });
    });

    describe('DCMP-006: Sibling Limit', () => {
      it('should enforce max 7 siblings per parent', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.decomposition.tooManySiblings;
        const result = await enforcer.validateProtocol(
          ProtocolType.DECOMPOSITION,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'DCMP-006',
            severity: 'error',
          })
        );
      });
    });
  });

  /**
   * Implementation Protocol (Exit Code 64) - Full Coverage
   */
  describe('Implementation Protocol (Exit Code 64)', () => {
    describe('IMPL-003: Provenance Tags', () => {
      it('should require @task tags on new functions', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.implementation.missingProvenanceTags;
        const result = await enforcer.validateProtocol(
          ProtocolType.IMPLEMENTATION,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'IMPL-003',
            severity: 'error',
            message: expect.stringContaining('provenance tags'),
          })
        );
      });

      it('should pass when no new functions added', async () => {
        const manifestEntry = {
          id: 'T2060-impl',
          file: 'code.ts',
          date: '2026-02-04',
          status: 'complete',
          agent_type: 'implementation',
        };

        const result = await enforcer.validateProtocol(
          ProtocolType.IMPLEMENTATION,
          manifestEntry,
          { hasNewFunctions: false }
        );

        expect(result.valid).toBe(true);
      });

      it('should pass when new functions have @task tags', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.implementation.valid;
        const result = await enforcer.validateProtocol(
          ProtocolType.IMPLEMENTATION,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(true);
      });
    });
  });

  /**
   * Release Protocol (Exit Code 66) - Full Coverage
   */
  describe('Release Protocol (Exit Code 66)', () => {
    describe('RLSE-001: Semver Validation', () => {
      it('should enforce semver format (X.Y.Z)', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.release.invalidSemver;
        const result = await enforcer.validateProtocol(
          ProtocolType.RELEASE,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'RLSE-001',
            severity: 'error',
            message: expect.stringContaining('semver'),
          })
        );
      });

      it('should accept valid semver versions', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.release.valid;
        const result = await enforcer.validateProtocol(
          ProtocolType.RELEASE,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(true);
      });
    });

    describe('RLSE-002: Changelog Entry', () => {
      it('should require changelog entry for releases', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.release.missingChangelog;
        const result = await enforcer.validateProtocol(
          ProtocolType.RELEASE,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'RLSE-002',
            severity: 'error',
          })
        );
      });
    });
  });

  /**
   * Validation Protocol (Exit Code 68) - Full Coverage
   */
  describe('Validation Protocol (Exit Code 68)', () => {
    describe('VALID-001: Validation Result', () => {
      it('should require validation_result field', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.validation.missingValidationResult;
        const result = await enforcer.validateProtocol(
          ProtocolType.VALIDATION,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'VALID-001',
            severity: 'error',
          })
        );
      });
    });

    describe('VALID-003: Status Validation', () => {
      it('should require valid status enum value', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.validation.invalidStatus;
        const result = await enforcer.validateProtocol(
          ProtocolType.VALIDATION,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'VALID-003',
            severity: 'error',
          })
        );
      });
    });
  });

  /**
   * Testing Protocol (Exit Codes 69/70) - Full Coverage
   */
  describe('Testing Protocol (Exit Codes 69/70)', () => {
    describe('TEST-004: 100% Pass Rate', () => {
      it('should require 100% test pass rate', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.testing.failingTests;
        const result = await enforcer.validateProtocol(
          ProtocolType.TESTING,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'TEST-004',
            severity: 'error',
            message: expect.stringContaining('100%'),
          })
        );
      });

      it('should pass with 100% pass rate', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.testing.valid;
        const result = await enforcer.validateProtocol(
          ProtocolType.TESTING,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(true);
      });
    });

    describe('TEST-006: Test Summary', () => {
      it('should require test summary in key_findings', async () => {
        const { manifestEntry, additionalData } = protocolFixtures.testing.missingTestSummary;
        const result = await enforcer.validateProtocol(
          ProtocolType.TESTING,
          manifestEntry,
          additionalData
        );

        expect(result.valid).toBe(false);
        expect(result.violations).toContainEqual(
          expect.objectContaining({
            requirement: 'TEST-006',
            severity: 'error',
          })
        );
      });
    });
  });

  /**
   * Protocol Violation Scoring
   */
  describe('Violation Scoring System', () => {
    it('should calculate score based on violation severity', async () => {
      const { manifestEntry, additionalData } = protocolFixtures.research.insufficientFindings;
      const result = await enforcer.validateProtocol(
        ProtocolType.RESEARCH,
        manifestEntry,
        additionalData
      );

      expect(result.score).toBeLessThan(100);
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('should give perfect score for valid output', async () => {
      const { manifestEntry, additionalData } = protocolFixtures.research.valid;
      const result = await enforcer.validateProtocol(
        ProtocolType.RESEARCH,
        manifestEntry,
        additionalData
      );

      expect(result.score).toBe(100);
    });

    it('should accumulate penalties for multiple violations', async () => {
      const manifestEntry = {
        id: 'T2070-research',
        file: 'output.md',
        date: '2026-02-04',
        title: 'Research output',
        status: 'complete',
        agent_type: 'implementation', // Wrong (RSCH-007)
        key_findings: ['Only one'], // Insufficient (RSCH-006)
        linked_tasks: ['T2070'],
      };

      const result = await enforcer.validateProtocol(
        ProtocolType.RESEARCH,
        manifestEntry,
        { hasCodeChanges: true } // Code modified (RSCH-001)
      );

      expect(result.violations.length).toBeGreaterThan(2);
      expect(result.score).toBeLessThan(60); // Multiple penalties
    });
  });

  /**
   * Fix Suggestion Generation
   */
  describe('Fix Suggestion Generation', () => {
    it('should provide actionable fix suggestions', async () => {
      const { manifestEntry, additionalData } = protocolFixtures.decomposition.tooManySiblings;
      const result = await enforcer.validateProtocol(
        ProtocolType.DECOMPOSITION,
        manifestEntry,
        additionalData
      );

      const violation = result.violations[0];
      expect(violation.fix).toBeTruthy();
      expect(violation.fix.length).toBeGreaterThan(10); // Substantial fix description
    });

    it('should include requirement ID in fix context', async () => {
      const { manifestEntry, additionalData } = protocolFixtures.specification.missingRFC2119;
      const result = await enforcer.validateProtocol(
        ProtocolType.SPECIFICATION,
        manifestEntry,
        additionalData
      );

      const violation = result.violations.find((v) => v.requirement === 'SPEC-001');
      expect(violation).toBeDefined();
      expect(violation!.requirement).toBe('SPEC-001');
    });
  });

  /**
   * Violation History Tracking
   */
  describe('Violation History Tracking', () => {
    it('should record violations with timestamps', () => {
      const violations = [
        { requirement: 'RSCH-001', severity: 'error' as const, message: 'Test', fix: 'Fix' },
      ];

      enforcer.recordViolation(ProtocolType.RESEARCH, violations, 80, 'T2080');

      const history = enforcer.getViolations(1);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].timestamp).toBeTruthy();
      expect(history[0].taskId).toBe('T2080');
      expect(history[0].protocol).toBe(ProtocolType.RESEARCH);
    });

    it('should track blocking status in strict mode', () => {
      enforcer.setStrictMode(true);

      const errorViolations = [
        { requirement: 'RSCH-001', severity: 'error' as const, message: 'Test', fix: 'Fix' },
      ];

      enforcer.recordViolation(ProtocolType.RESEARCH, errorViolations, 70);

      const history = enforcer.getViolations(1);
      expect(history[0].blocked).toBe(true);
    });

    it('should not block warnings in strict mode', () => {
      enforcer.setStrictMode(true);

      const warningViolations = [
        { requirement: 'RSCH-002', severity: 'warning' as const, message: 'Test', fix: 'Fix' },
      ];

      enforcer.recordViolation(ProtocolType.RESEARCH, warningViolations, 95);

      const history = enforcer.getViolations(1);
      expect(history[0].blocked).toBe(false); // Warnings don't block
    });
  });
});
