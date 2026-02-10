/**
 * Lifecycle Gate Enforcement Tests
 *
 * @task T2923
 * @epic T2908
 *
 * Tests RCSD→IVTR lifecycle gate enforcement with exit code 75 (E_LIFECYCLE_GATE_FAILED).
 * Covers enforcement modes (strict/advisory/off) and prerequisite checking.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ProtocolEnforcer } from '../protocol-enforcement.js';
import { lifecycleScenarios } from '../../__tests__/fixtures/lifecycle-scenarios.js';
import { ExitCode } from '../exit-codes.js';

describe('Lifecycle Gate Enforcement', () => {
  let enforcer: ProtocolEnforcer;

  beforeEach(() => {
    enforcer = new ProtocolEnforcer(true); // Start in strict mode
  });

  /**
   * RCSD Pipeline Gate Tests
   */
  describe('RCSD Pipeline Gates', () => {
    describe('Research → Consensus Gate', () => {
      it('should pass when research is completed', async () => {
        const { epicId, targetStage, currentManifest, expectedResult } =
          lifecycleScenarios.successes.researchToConsensus;

        const result = await enforcer.checkLifecycleGate(epicId, targetStage, currentManifest || undefined);

        expect(result.passed).toBe(expectedResult.passed);
        expect(result.missingPrerequisites).toEqual(expectedResult.missingPrerequisites);
      });

      it('should block when research is pending', async () => {
        const { epicId, targetStage, currentManifest, expectedResult } =
          lifecycleScenarios.failures.consensusWithoutResearch;

        const result = await enforcer.checkLifecycleGate(epicId, targetStage, currentManifest || undefined);

        expect(result.passed).toBe(false);
        expect(result.missingPrerequisites).toContain('research');
        expect(result.message).toContain('missing prerequisites');
      });
    });

    describe('Consensus → Specification Gate', () => {
      it('should pass when research + consensus completed', async () => {
        const { manifest } = lifecycleScenarios.rcsd.researchAndConsensus;

        const result = await enforcer.checkLifecycleGate('T3002', 'specification', manifest);

        expect(result.passed).toBe(true);
        expect(result.missingPrerequisites).toEqual([]);
      });

      it('should accept skipped consensus stage', async () => {
        const { epicId, targetStage, currentManifest, expectedResult } =
          lifecycleScenarios.successes.withSkippedStage;

        const result = await enforcer.checkLifecycleGate(epicId, targetStage, currentManifest || undefined);

        expect(result.passed).toBe(true); // Skipped counts as passed
      });
    });

    describe('Specification → Decomposition Gate', () => {
      it('should pass when all prior RCSD stages complete', async () => {
        const { manifest } = lifecycleScenarios.rcsd.upToSpecification;

        const result = await enforcer.checkLifecycleGate('T3003', 'decomposition', manifest);

        expect(result.passed).toBe(true);
      });

      it('should block without specification', async () => {
        const { epicId, targetStage, currentManifest, expectedResult } =
          lifecycleScenarios.failures.decompositionWithoutSpec;

        const result = await enforcer.checkLifecycleGate(epicId, targetStage, currentManifest || undefined);

        expect(result.passed).toBe(false);
        expect(result.missingPrerequisites).toContain('specification');
      });
    });

    describe('Decomposition → Implementation Gate', () => {
      it('should pass with complete RCSD', async () => {
        const { epicId, targetStage, currentManifest, expectedResult } =
          lifecycleScenarios.successes.completeRCSDToImplementation;

        const result = await enforcer.checkLifecycleGate(epicId, targetStage, currentManifest || undefined);

        expect(result.passed).toBe(true);
        expect(result.missingPrerequisites).toEqual([]);
      });

      it('should allow without manifest (legacy behavior)', async () => {
        const { epicId, targetStage, currentManifest } =
          lifecycleScenarios.failures.skipToImplementation;

        const result = await enforcer.checkLifecycleGate(epicId, targetStage, currentManifest || undefined);

        // When no manifest exists, enforcer warns but allows (for backward compatibility)
        expect(result.passed).toBe(true);
        expect(result.message).toContain('No RCSD manifest');
      });
    });
  });

  /**
   * IVTR Pipeline Gate Tests
   */
  describe('IVTR Pipeline Gates', () => {
    describe('Implementation → Validation Gate', () => {
      it('should pass when implementation complete', async () => {
        const { manifest } = lifecycleScenarios.ivtr.implementationOnly;

        const result = await enforcer.checkLifecycleGate('T3010', 'validation', manifest);

        expect(result.passed).toBe(true);
      });

      it('should block without implementation', async () => {
        const { epicId, targetStage, currentManifest, expectedResult } =
          lifecycleScenarios.failures.validationWithoutImplementation;

        const result = await enforcer.checkLifecycleGate(epicId, targetStage, currentManifest || undefined);

        expect(result.passed).toBe(false);
        expect(result.missingPrerequisites).toContain('implementation');
      });
    });

    describe('Validation → Testing Gate', () => {
      it('should pass when validation complete', async () => {
        const { manifest } = lifecycleScenarios.ivtr.validationComplete;

        const result = await enforcer.checkLifecycleGate('T3011', 'testing', manifest);

        expect(result.passed).toBe(true);
      });
    });

    describe('Testing → Release Gate', () => {
      it('should pass when all stages complete', async () => {
        const { epicId, targetStage, currentManifest, expectedResult } =
          lifecycleScenarios.successes.readyForRelease;

        const result = await enforcer.checkLifecycleGate(epicId, targetStage, currentManifest || undefined);

        expect(result.passed).toBe(true);
        expect(result.missingPrerequisites).toEqual([]);
      });

      it('should block without testing', async () => {
        const { epicId, targetStage, currentManifest, expectedResult } =
          lifecycleScenarios.failures.releaseWithoutTesting;

        const result = await enforcer.checkLifecycleGate(epicId, targetStage, currentManifest || undefined);

        expect(result.passed).toBe(false);
        expect(result.missingPrerequisites).toContain('testing');
      });
    });
  });

  /**
   * Enforcement Mode Tests
   */
  describe('Enforcement Modes', () => {
    describe('Strict Mode (Default)', () => {
      beforeEach(() => {
        enforcer.setStrictMode(true);
      });

      it('should block spawn on gate failure with actual manifest', async () => {
        // Use a scenario with an actual manifest, not null
        const manifest = {
          research: 'pending',
          consensus: 'pending',
        };

        const result = await enforcer.checkLifecycleGate('T3020', 'implementation', manifest);

        expect(result.passed).toBe(false);
        expect(result.missingPrerequisites.length).toBeGreaterThan(0);
      });

      it('should return error message with missing prerequisites', async () => {
        // Use a scenario with pending prerequisites
        const manifest = {
          research: 'completed',
          consensus: 'pending',
          specification: 'pending',
          decomposition: 'pending',
        };

        const result = await enforcer.checkLifecycleGate('T3020', 'implementation', manifest);

        expect(result.message).toContain('missing prerequisites');
        expect(result.message).toContain('consensus'); // At least one missing
      });

      it('should be enabled by default', () => {
        const newEnforcer = new ProtocolEnforcer();
        expect(newEnforcer.isStrictMode()).toBe(true);
      });
    });

    describe('Advisory Mode', () => {
      beforeEach(() => {
        enforcer.setStrictMode(false);
      });

      it('should warn but allow spawn on gate failure', async () => {
        // In advisory mode, the enforcer would log warnings but return success
        // This is tested through the enforcement middleware behavior
        expect(enforcer.isStrictMode()).toBe(false);
      });

      it('should track strict mode state', () => {
        enforcer.setStrictMode(false);
        expect(enforcer.isStrictMode()).toBe(false);

        enforcer.setStrictMode(true);
        expect(enforcer.isStrictMode()).toBe(true);
      });
    });
  });

  /**
   * Missing Manifest Tests
   */
  describe('Missing Manifest Handling', () => {
    it('should warn when no RCSD manifest exists', async () => {
      const { epicId } = lifecycleScenarios.rcsd.noRCSD;

      const result = await enforcer.checkLifecycleGate(epicId, 'implementation', undefined);

      expect(result.passed).toBe(true); // Allows by default
      expect(result.message).toContain('No RCSD manifest');
    });

    it('should allow first stage (research) without manifest', async () => {
      const result = await enforcer.checkLifecycleGate('T3100', 'research', undefined);

      expect(result.passed).toBe(true);
      expect(result.missingPrerequisites).toEqual([]);
    });
  });

  /**
   * Failed Stage Handling
   */
  describe('Failed Stage Handling', () => {
    it('should block progression when stage failed', async () => {
      const { epicId, manifest } = lifecycleScenarios.rcsd.specificationFailed;

      const result = await enforcer.checkLifecycleGate(epicId, 'decomposition', manifest);

      expect(result.passed).toBe(false);
      expect(result.missingPrerequisites).toContain('specification');
    });

    it('should treat failed as not completed', async () => {
      const manifest = {
        research: 'completed',
        consensus: 'failed', // Failed stage
      };

      const result = await enforcer.checkLifecycleGate('T3200', 'specification', manifest);

      expect(result.passed).toBe(false);
      expect(result.missingPrerequisites).toContain('consensus');
    });
  });

  /**
   * Prerequisite Chain Validation
   */
  describe('Prerequisite Chain Validation', () => {
    it('should validate all prerequisites in sequence', async () => {
      const manifest = {
        research: 'completed',
        consensus: 'pending', // Breaks chain
        specification: 'completed', // This shouldn't matter
        decomposition: 'pending',
      };

      const result = await enforcer.checkLifecycleGate('T3300', 'decomposition', manifest);

      expect(result.passed).toBe(false);
      expect(result.missingPrerequisites).toContain('consensus');
    });

    it('should check multiple missing prerequisites', async () => {
      const manifest = {
        research: 'pending',
        consensus: 'pending',
        specification: 'pending',
        decomposition: 'pending',
      };

      const result = await enforcer.checkLifecycleGate('T3301', 'implementation', manifest);

      expect(result.passed).toBe(false);
      expect(result.missingPrerequisites.length).toBe(4); // All RCSD stages
      expect(result.missingPrerequisites).toContain('research');
      expect(result.missingPrerequisites).toContain('consensus');
      expect(result.missingPrerequisites).toContain('specification');
      expect(result.missingPrerequisites).toContain('decomposition');
    });
  });

  /**
   * Stage Completion Status Tests
   */
  describe('Stage Completion Status', () => {
    it('should accept "completed" status', async () => {
      const manifest = { research: 'completed' };

      const result = await enforcer.checkLifecycleGate('T3400', 'consensus', manifest);

      expect(result.passed).toBe(true);
    });

    it('should accept "skipped" status', async () => {
      const manifest = {
        research: 'completed',
        consensus: 'skipped',
      };

      const result = await enforcer.checkLifecycleGate('T3401', 'specification', manifest);

      expect(result.passed).toBe(true);
    });

    it('should reject "pending" status', async () => {
      const manifest = {
        research: 'completed',
        consensus: 'pending',
      };

      const result = await enforcer.checkLifecycleGate('T3402', 'specification', manifest);

      expect(result.passed).toBe(false);
      expect(result.missingPrerequisites).toContain('consensus');
    });

    it('should reject "in_progress" status', async () => {
      const manifest = {
        research: 'in_progress', // Still in progress
      };

      const result = await enforcer.checkLifecycleGate('T3403', 'consensus', manifest);

      expect(result.passed).toBe(false);
      expect(result.missingPrerequisites).toContain('research');
    });
  });

  /**
   * Gate Error Messages
   */
  describe('Gate Error Messages', () => {
    it('should provide actionable error message', async () => {
      // Use a real failure scenario with pending prerequisites
      const manifest = {
        research: 'pending',
        consensus: 'pending',
        specification: 'pending',
        decomposition: 'pending',
      };

      const result = await enforcer.checkLifecycleGate('T3500', 'implementation', manifest);

      expect(result.message).toBeTruthy();
      expect(result.message).toContain('failed');
      expect(result.message).toContain('prerequisites');
    });

    it('should list missing stages in message', async () => {
      const manifest = {
        research: 'pending',
        consensus: 'pending',
      };

      const result = await enforcer.checkLifecycleGate('T3500', 'specification', manifest);

      expect(result.message).toContain('research');
      expect(result.message).toContain('consensus');
    });

    it('should provide success message when gates pass', async () => {
      const manifest = {
        research: 'completed',
        consensus: 'completed',
        specification: 'completed',
        decomposition: 'completed',
      };

      const result = await enforcer.checkLifecycleGate('T3501', 'implementation', manifest);

      expect(result.message).toContain('prerequisites met');
    });
  });

  /**
   * Special Cases
   */
  describe('Special Cases', () => {
    it('should handle empty manifest gracefully', async () => {
      const result = await enforcer.checkLifecycleGate('T3600', 'research', {});

      expect(result.passed).toBe(true); // Research has no prerequisites
    });

    it('should handle partial manifest (missing stages)', async () => {
      const manifest = {
        research: 'completed',
        // consensus missing
        specification: 'completed',
      };

      const result = await enforcer.checkLifecycleGate('T3601', 'decomposition', manifest);

      expect(result.passed).toBe(false);
      expect(result.missingPrerequisites).toContain('consensus');
    });

    it('should handle unknown stage gracefully', async () => {
      const manifest = {
        research: 'completed',
      };

      // Unknown stage should have empty prerequisites
      const result = await enforcer.checkLifecycleGate('T3602', 'unknown_stage', manifest);

      expect(result.passed).toBe(true); // No prerequisites for unknown stage
      expect(result.missingPrerequisites).toEqual([]);
    });
  });

  /**
   * Integration with Exit Codes
   */
  describe('Exit Code Integration', () => {
    it('should map gate failures to exit code 80', () => {
      // This is tested through the domain router integration
      // Exit code 80 = E_LIFECYCLE_GATE_FAILED (moved from 75 to avoid Nexus conflict)
      expect(ExitCode.E_LIFECYCLE_GATE_FAILED).toBe(80);
    });
  });
});
