/**
 * Tests for Verification Gate System
 *
 * @task T2936
 * @epic T2908
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  VerificationGate,
  GateLayer,
  GateStatus,
  OperationContext,
  createVerificationGate,
  GATE_SEQUENCE,
  WorkflowGateName,
  WorkflowGateTracker,
  WORKFLOW_GATE_SEQUENCE,
  WORKFLOW_GATE_DEFINITIONS,
  isValidWorkflowGateName,
  getWorkflowGateDefinition,
} from '../verification-gates.js';
import { ExitCode } from '../exit-codes.js';
import { ProtocolType } from '../protocol-enforcement.js';

describe('VerificationGate', () => {
  let gate: VerificationGate;

  beforeEach(() => {
    gate = createVerificationGate(true);
  });

  describe('Layer 1: Schema Validation', () => {
    it('should pass valid task creation', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Valid Task Title',
          description: 'This is a valid task description with sufficient length',
          priority: 5,
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(true);
      expect(result.layers[GateLayer.SCHEMA].status).toBe(GateStatus.PASSED);
    });

    it('should fail on invalid task ID format', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'update',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'INVALID123',
          title: 'Updated Title',
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(false);
      expect(result.blockedAt).toBe(GateLayer.SCHEMA);
      expect(result.layers[GateLayer.SCHEMA].violations).toHaveLength(1);
      expect(result.layers[GateLayer.SCHEMA].violations[0].code).toBe('E_INVALID_TASK_ID');
    });

    it('should fail on title too short', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Hi',
          description: 'Valid description',
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(false);
      expect(result.layers[GateLayer.SCHEMA].violations[0].code).toBe('E_INVALID_TITLE');
    });

    it('should fail on invalid status', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'update',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'T1234',
          status: 'invalid_status',
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(false);
      expect(result.layers[GateLayer.SCHEMA].violations[0].code).toBe('E_INVALID_STATUS');
    });

    it('should fail on priority out of range', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Valid Title',
          description: 'Valid description',
          priority: 15,
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(false);
      expect(result.layers[GateLayer.SCHEMA].violations[0].code).toBe('E_INVALID_PRIORITY');
    });
  });

  describe('Layer 2: Semantic Validation', () => {
    it('should fail when title equals description', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Same Content',
          description: 'Same Content',
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(false);
      expect(result.blockedAt).toBe(GateLayer.SEMANTIC);
      expect(result.layers[GateLayer.SEMANTIC].violations[0].code).toBe(
        'E_TITLE_DESCRIPTION_SAME'
      );
    });

    it('should fail on circular dependency', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'T1234',
          title: 'Task Title',
          description: 'Task description',
          depends: ['T1234', 'T5678'],
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(false);
      expect(result.layers[GateLayer.SEMANTIC].violations[0].code).toBe(
        'E_CIRCULAR_DEPENDENCY'
      );
    });

    it('should fail on invalid session scope format', async () => {
      const context: OperationContext = {
        domain: 'session',
        operation: 'start',
        gateway: 'cleo_mutate',
        params: {
          scope: 'invalid_scope',
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(false);
      expect(result.layers[GateLayer.SEMANTIC].violations[0].code).toBe('E_INVALID_SCOPE');
    });

    it('should warn on missing completion notes', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'T1234',
        },
      };

      const result = await gate.verifyOperation(context);
      // Warnings don't block in strict mode
      expect(result.passed).toBe(true);
      expect(result.layers[GateLayer.SEMANTIC].violations).toHaveLength(1);
      expect(result.layers[GateLayer.SEMANTIC].violations[0].code).toBe(
        'E_NOTES_RECOMMENDED'
      );
    });
  });

  describe('Layer 3: Referential Validation', () => {
    it('should fail on invalid parent reference', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Valid Title',
          description: 'Valid description',
          parent: 'INVALID',
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(false);
      expect(result.blockedAt).toBe(GateLayer.REFERENTIAL);
      expect(result.layers[GateLayer.REFERENTIAL].violations[0].code).toBe(
        'E_INVALID_PARENT_REF'
      );
    });

    it('should fail on invalid dependency reference', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Valid Title',
          description: 'Valid description',
          depends: ['T1234', 'INVALID'],
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(false);
      expect(result.layers[GateLayer.REFERENTIAL].violations[0].code).toBe(
        'E_INVALID_DEPENDENCY_REF'
      );
    });

    it('should fail when taskId missing for update', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'update',
        gateway: 'cleo_mutate',
        params: {
          title: 'Updated Title',
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(false);
      expect(result.layers[GateLayer.REFERENTIAL].violations[0].code).toBe(
        'E_TASK_ID_REQUIRED'
      );
    });
  });

  describe('Layer 4: Protocol Validation', () => {
    it('should skip protocol validation when not applicable', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Valid Title',
          description: 'Valid description',
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.layers[GateLayer.PROTOCOL].status).toBe(GateStatus.SKIPPED);
    });

    it('should validate manifest fields for completion', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'T1234',
          manifestEntry: {
            id: 'T1234-slug',
            file: 'output.md',
            title: 'Title',
            // Missing: date, status, agent_type
          },
        },
        protocolType: ProtocolType.IMPLEMENTATION,
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(false);
      expect(result.blockedAt).toBe(GateLayer.PROTOCOL);
      expect(result.layers[GateLayer.PROTOCOL].violations.length).toBeGreaterThan(0);
    });

    it('should validate manifest status enum', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'T1234',
          manifestEntry: {
            id: 'T1234-slug',
            file: 'output.md',
            title: 'Title',
            date: '2026-02-03',
            status: 'invalid',
            agent_type: 'implementation',
          },
        },
        protocolType: ProtocolType.IMPLEMENTATION,
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(false);
      expect(result.layers[GateLayer.PROTOCOL].violations.some(
        (v: any) => v.code === 'E_INVALID_MANIFEST_STATUS'
      )).toBe(true);
    });
  });

  describe('Gate Sequence', () => {
    it('should execute all layers in sequence', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Valid Task Title',
          description: 'Valid description with sufficient length',
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.layers[GateLayer.SCHEMA]).toBeDefined();
      expect(result.layers[GateLayer.SEMANTIC]).toBeDefined();
      expect(result.layers[GateLayer.REFERENTIAL]).toBeDefined();
      expect(result.layers[GateLayer.PROTOCOL]).toBeDefined();
    });

    it('should stop at first failure in strict mode', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Hi', // Too short - fails layer 1
          description: 'Same as title', // Would fail layer 2 if reached
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.passed).toBe(false);
      expect(result.blockedAt).toBe(GateLayer.SCHEMA);
      expect(result.layers[GateLayer.SCHEMA].status).toBe(GateStatus.FAILED);
    });

    it('should track duration for each layer', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Valid Title',
          description: 'Valid description',
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.layers[GateLayer.SCHEMA].duration_ms).toBeGreaterThanOrEqual(0);
      expect(result.layers[GateLayer.SEMANTIC].duration_ms).toBeGreaterThanOrEqual(0);
      expect(result.layers[GateLayer.REFERENTIAL].duration_ms).toBeGreaterThanOrEqual(0);
      expect(result.layers[GateLayer.PROTOCOL].duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Exit Code Mapping', () => {
    it('should map schema errors to E_VALIDATION_ERROR', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Hi',
          description: 'Valid description',
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.exitCode).toBe(ExitCode.E_VALIDATION_ERROR);
    });

    it('should map semantic errors to appropriate codes', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Valid Title',
          description: 'Valid Title', // Same as title
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.exitCode).toBe(ExitCode.E_VALIDATION_ERROR);
    });

    it('should map referential errors to E_NOT_FOUND', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'update',
        gateway: 'cleo_mutate',
        params: {
          title: 'Updated Title',
        },
      };

      const result = await gate.verifyOperation(context);
      expect(result.exitCode).toBe(ExitCode.E_NOT_FOUND);
    });
  });

  describe('Static Helper Methods', () => {
    it('should require validation for mutate operations', () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
      };
      expect(VerificationGate.requiresValidation(context)).toBe(true);
    });

    it('should not require validation for query operations', () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'get',
        gateway: 'cleo_query',
      };
      expect(VerificationGate.requiresValidation(context)).toBe(false);
    });

    it('should return human-readable layer names', () => {
      expect(VerificationGate.getLayerName(GateLayer.SCHEMA)).toBe('Schema Validation');
      expect(VerificationGate.getLayerName(GateLayer.SEMANTIC)).toBe('Semantic Validation');
      expect(VerificationGate.getLayerName(GateLayer.REFERENTIAL)).toBe(
        'Referential Validation'
      );
      expect(VerificationGate.getLayerName(GateLayer.PROTOCOL)).toBe('Protocol Validation');
    });
  });

  describe('GATE_SEQUENCE constant', () => {
    it('should define correct layer sequence', () => {
      expect(GATE_SEQUENCE).toEqual([
        GateLayer.SCHEMA,
        GateLayer.SEMANTIC,
        GateLayer.REFERENTIAL,
        GateLayer.PROTOCOL,
      ]);
    });
  });
});

/**
 * Section 7: Workflow Verification Gates
 *
 * @task T3141
 */
describe('WorkflowGateTracker', () => {
  let tracker: WorkflowGateTracker;

  beforeEach(() => {
    tracker = new WorkflowGateTracker();
  });

  describe('Section 7.1: Gate Sequence', () => {
    it('should define 6 gates in correct order', () => {
      expect(WORKFLOW_GATE_SEQUENCE).toEqual([
        'implemented',
        'testsPassed',
        'qaPassed',
        'cleanupDone',
        'securityPassed',
        'documented',
      ]);
    });

    it('should have 6 gate definitions', () => {
      expect(WORKFLOW_GATE_DEFINITIONS).toHaveLength(6);
    });
  });

  describe('Section 7.2: Gate Definitions', () => {
    it('should assign correct agents to gates', () => {
      const agentMap: Record<string, string> = {
        implemented: 'coder',
        testsPassed: 'testing',
        qaPassed: 'qa',
        cleanupDone: 'cleanup',
        securityPassed: 'security',
        documented: 'docs',
      };

      for (const [gateName, agent] of Object.entries(agentMap)) {
        const def = getWorkflowGateDefinition(gateName as WorkflowGateName);
        expect(def?.agent).toBe(agent);
      }
    });

    it('should define correct dependency chain', () => {
      const def0 = getWorkflowGateDefinition(WorkflowGateName.IMPLEMENTED);
      expect(def0?.dependsOn).toEqual([]);

      const def1 = getWorkflowGateDefinition(WorkflowGateName.TESTS_PASSED);
      expect(def1?.dependsOn).toEqual([WorkflowGateName.IMPLEMENTED]);

      const def2 = getWorkflowGateDefinition(WorkflowGateName.QA_PASSED);
      expect(def2?.dependsOn).toEqual([WorkflowGateName.TESTS_PASSED]);

      const def3 = getWorkflowGateDefinition(WorkflowGateName.CLEANUP_DONE);
      expect(def3?.dependsOn).toEqual([WorkflowGateName.QA_PASSED]);

      const def4 = getWorkflowGateDefinition(WorkflowGateName.SECURITY_PASSED);
      expect(def4?.dependsOn).toEqual([WorkflowGateName.CLEANUP_DONE]);

      const def5 = getWorkflowGateDefinition(WorkflowGateName.DOCUMENTED);
      expect(def5?.dependsOn).toEqual([WorkflowGateName.SECURITY_PASSED]);
    });
  });

  describe('Section 7.3: Gate Status Values', () => {
    it('should initialize all gates with null status', () => {
      const gates = tracker.getAllGates();
      expect(gates).toHaveLength(6);
      for (const gate of gates) {
        expect(gate.status).toBeNull();
      }
    });

    it('should support passed status', () => {
      tracker.passGate(WorkflowGateName.IMPLEMENTED);
      expect(tracker.getGateStatus(WorkflowGateName.IMPLEMENTED)).toBe('passed');
    });

    it('should support failed status', () => {
      tracker.failGate(WorkflowGateName.IMPLEMENTED, 'Build errors');
      expect(tracker.getGateStatus(WorkflowGateName.IMPLEMENTED)).toBe('failed');
    });

    it('should support blocked status', () => {
      tracker.updateBlockedStatus();
      // testsPassed should be blocked since implemented is not passed
      expect(tracker.getGateStatus(WorkflowGateName.TESTS_PASSED)).toBe('blocked');
    });

    it('should return null for not-yet-attempted gates', () => {
      expect(tracker.getGateStatus(WorkflowGateName.IMPLEMENTED)).toBeNull();
    });
  });

  describe('Gate Transitions', () => {
    it('should allow passing first gate without dependencies', () => {
      const result = tracker.passGate(WorkflowGateName.IMPLEMENTED);
      expect(result).toBe(true);
      expect(tracker.getGateStatus(WorkflowGateName.IMPLEMENTED)).toBe('passed');
    });

    it('should block passing gate when dependencies not met', () => {
      const result = tracker.passGate(WorkflowGateName.TESTS_PASSED);
      expect(result).toBe(false);
      expect(tracker.getGateStatus(WorkflowGateName.TESTS_PASSED)).toBeNull();
    });

    it('should allow passing gate when dependencies are met', () => {
      tracker.passGate(WorkflowGateName.IMPLEMENTED);
      const result = tracker.passGate(WorkflowGateName.TESTS_PASSED);
      expect(result).toBe(true);
      expect(tracker.getGateStatus(WorkflowGateName.TESTS_PASSED)).toBe('passed');
    });

    it('should allow sequential pass through all 6 gates', () => {
      for (const gateName of WORKFLOW_GATE_SEQUENCE) {
        const result = tracker.passGate(gateName);
        expect(result).toBe(true);
      }
      expect(tracker.allPassed()).toBe(true);
    });

    it('should reject incorrect agent', () => {
      const result = tracker.passGate(WorkflowGateName.IMPLEMENTED, 'testing');
      expect(result).toBe(false);
    });

    it('should accept correct agent', () => {
      const result = tracker.passGate(WorkflowGateName.IMPLEMENTED, 'coder');
      expect(result).toBe(true);
    });

    it('should allow failing any gate', () => {
      const result = tracker.failGate(WorkflowGateName.IMPLEMENTED, 'Compile errors');
      expect(result).toBe(true);
      expect(tracker.getGateStatus(WorkflowGateName.IMPLEMENTED)).toBe('failed');
    });

    it('should store failure reason', () => {
      tracker.failGate(WorkflowGateName.IMPLEMENTED, 'Compile errors');
      const state = tracker.getGateState(WorkflowGateName.IMPLEMENTED);
      expect(state?.failureReason).toBe('Compile errors');
    });

    it('should set updatedAt timestamp on pass', () => {
      tracker.passGate(WorkflowGateName.IMPLEMENTED);
      const state = tracker.getGateState(WorkflowGateName.IMPLEMENTED);
      expect(state?.updatedAt).toBeTruthy();
    });

    it('should set updatedAt timestamp on fail', () => {
      tracker.failGate(WorkflowGateName.IMPLEMENTED);
      const state = tracker.getGateState(WorkflowGateName.IMPLEMENTED);
      expect(state?.updatedAt).toBeTruthy();
    });
  });

  describe('Section 7.4: Failure Cascade', () => {
    it('should reset all downstream gates when a gate fails', () => {
      // Pass first 3 gates
      tracker.passGate(WorkflowGateName.IMPLEMENTED);
      tracker.passGate(WorkflowGateName.TESTS_PASSED);
      tracker.passGate(WorkflowGateName.QA_PASSED);

      // Fail testsPassed
      tracker.failGate(WorkflowGateName.TESTS_PASSED, 'Test regression found');

      // testsPassed should be failed
      expect(tracker.getGateStatus(WorkflowGateName.TESTS_PASSED)).toBe('failed');

      // Downstream gates should be reset to null
      expect(tracker.getGateStatus(WorkflowGateName.QA_PASSED)).toBeNull();
      expect(tracker.getGateStatus(WorkflowGateName.CLEANUP_DONE)).toBeNull();
      expect(tracker.getGateStatus(WorkflowGateName.SECURITY_PASSED)).toBeNull();
      expect(tracker.getGateStatus(WorkflowGateName.DOCUMENTED)).toBeNull();

      // Upstream gates should be unaffected
      expect(tracker.getGateStatus(WorkflowGateName.IMPLEMENTED)).toBe('passed');
    });

    it('should cascade from first gate to all remaining', () => {
      // Pass all 6 gates
      for (const name of WORKFLOW_GATE_SEQUENCE) {
        tracker.passGate(name);
      }
      expect(tracker.allPassed()).toBe(true);

      // Fail the first gate
      tracker.failGate(WorkflowGateName.IMPLEMENTED, 'Critical bug');

      // First gate failed, all others reset to null
      expect(tracker.getGateStatus(WorkflowGateName.IMPLEMENTED)).toBe('failed');
      expect(tracker.getGateStatus(WorkflowGateName.TESTS_PASSED)).toBeNull();
      expect(tracker.getGateStatus(WorkflowGateName.QA_PASSED)).toBeNull();
      expect(tracker.getGateStatus(WorkflowGateName.CLEANUP_DONE)).toBeNull();
      expect(tracker.getGateStatus(WorkflowGateName.SECURITY_PASSED)).toBeNull();
      expect(tracker.getGateStatus(WorkflowGateName.DOCUMENTED)).toBeNull();
    });

    it('should not cascade upstream when last gate fails', () => {
      // Pass first 5 gates
      for (let i = 0; i < 5; i++) {
        tracker.passGate(WORKFLOW_GATE_SEQUENCE[i]);
      }

      // Fail the last gate
      tracker.failGate(WorkflowGateName.DOCUMENTED, 'Docs incomplete');

      // Only documented is failed, no downstream to reset
      expect(tracker.getGateStatus(WorkflowGateName.DOCUMENTED)).toBe('failed');
      expect(tracker.getGateStatus(WorkflowGateName.SECURITY_PASSED)).toBe('passed');
      expect(tracker.getGateStatus(WorkflowGateName.CLEANUP_DONE)).toBe('passed');
    });

    it('should clear failure reason on cascaded resets', () => {
      tracker.passGate(WorkflowGateName.IMPLEMENTED);
      tracker.passGate(WorkflowGateName.TESTS_PASSED);

      // Fail qaPassed with reason, then cascade
      tracker.failGate(WorkflowGateName.IMPLEMENTED, 'Bug');

      // testsPassed was reset, should have no failure reason
      const state = tracker.getGateState(WorkflowGateName.TESTS_PASSED);
      expect(state?.failureReason).toBeUndefined();
      expect(state?.updatedAt).toBeNull();
    });

    it('should allow re-passing after failure cascade', () => {
      tracker.passGate(WorkflowGateName.IMPLEMENTED);
      tracker.passGate(WorkflowGateName.TESTS_PASSED);

      // Fail and cascade
      tracker.failGate(WorkflowGateName.IMPLEMENTED, 'Bug');

      // Re-pass implemented
      tracker.passGate(WorkflowGateName.IMPLEMENTED, 'coder');
      expect(tracker.getGateStatus(WorkflowGateName.IMPLEMENTED)).toBe('passed');

      // Should be able to re-pass testsPassed now
      const result = tracker.passGate(WorkflowGateName.TESTS_PASSED);
      expect(result).toBe(true);
      expect(tracker.getGateStatus(WorkflowGateName.TESTS_PASSED)).toBe('passed');
    });
  });

  describe('Helper Methods', () => {
    it('canAttempt should return true for first gate', () => {
      expect(tracker.canAttempt(WorkflowGateName.IMPLEMENTED)).toBe(true);
    });

    it('canAttempt should return false when deps not met', () => {
      expect(tracker.canAttempt(WorkflowGateName.TESTS_PASSED)).toBe(false);
    });

    it('canAttempt should return true when deps met', () => {
      tracker.passGate(WorkflowGateName.IMPLEMENTED);
      expect(tracker.canAttempt(WorkflowGateName.TESTS_PASSED)).toBe(true);
    });

    it('allPassed should return false when not all passed', () => {
      tracker.passGate(WorkflowGateName.IMPLEMENTED);
      expect(tracker.allPassed()).toBe(false);
    });

    it('allPassed should return true when all passed', () => {
      for (const name of WORKFLOW_GATE_SEQUENCE) {
        tracker.passGate(name);
      }
      expect(tracker.allPassed()).toBe(true);
    });

    it('getPendingGates should return all gates initially', () => {
      const pending = tracker.getPendingGates();
      expect(pending).toHaveLength(6);
    });

    it('getPendingGates should exclude passed gates', () => {
      tracker.passGate(WorkflowGateName.IMPLEMENTED);
      const pending = tracker.getPendingGates();
      expect(pending).toHaveLength(5);
      expect(pending.every((g) => g.name !== WorkflowGateName.IMPLEMENTED)).toBe(true);
    });

    it('getNextAttemptable should return first gate initially', () => {
      expect(tracker.getNextAttemptable()).toBe(WorkflowGateName.IMPLEMENTED);
    });

    it('getNextAttemptable should return second gate after first passes', () => {
      tracker.passGate(WorkflowGateName.IMPLEMENTED);
      expect(tracker.getNextAttemptable()).toBe(WorkflowGateName.TESTS_PASSED);
    });

    it('getNextAttemptable should return null when all passed', () => {
      for (const name of WORKFLOW_GATE_SEQUENCE) {
        tracker.passGate(name);
      }
      expect(tracker.getNextAttemptable()).toBeNull();
    });

    it('getDownstreamGates should return correct downstream gates', () => {
      const downstream = tracker.getDownstreamGates(WorkflowGateName.TESTS_PASSED);
      expect(downstream).toEqual([
        WorkflowGateName.QA_PASSED,
        WorkflowGateName.CLEANUP_DONE,
        WorkflowGateName.SECURITY_PASSED,
        WorkflowGateName.DOCUMENTED,
      ]);
    });

    it('getDownstreamGates should return empty for last gate', () => {
      const downstream = tracker.getDownstreamGates(WorkflowGateName.DOCUMENTED);
      expect(downstream).toEqual([]);
    });
  });

  describe('Blocked Status Updates', () => {
    it('should mark gates as blocked when deps not met', () => {
      tracker.updateBlockedStatus();

      // Implemented has no deps, should not be blocked
      expect(tracker.getGateStatus(WorkflowGateName.IMPLEMENTED)).toBeNull();

      // All others should be blocked (deps not met)
      expect(tracker.getGateStatus(WorkflowGateName.TESTS_PASSED)).toBe('blocked');
      expect(tracker.getGateStatus(WorkflowGateName.QA_PASSED)).toBe('blocked');
      expect(tracker.getGateStatus(WorkflowGateName.CLEANUP_DONE)).toBe('blocked');
      expect(tracker.getGateStatus(WorkflowGateName.SECURITY_PASSED)).toBe('blocked');
      expect(tracker.getGateStatus(WorkflowGateName.DOCUMENTED)).toBe('blocked');
    });

    it('should unblock gates when deps are met', () => {
      tracker.updateBlockedStatus();
      expect(tracker.getGateStatus(WorkflowGateName.TESTS_PASSED)).toBe('blocked');

      tracker.passGate(WorkflowGateName.IMPLEMENTED);
      tracker.updateBlockedStatus();
      // testsPassed should no longer be blocked
      expect(tracker.getGateStatus(WorkflowGateName.TESTS_PASSED)).toBeNull();
    });
  });

  describe('Serialization', () => {
    it('should serialize to record', () => {
      tracker.passGate(WorkflowGateName.IMPLEMENTED);
      tracker.passGate(WorkflowGateName.TESTS_PASSED);
      tracker.failGate(WorkflowGateName.QA_PASSED, 'Review failed');

      const record = tracker.toRecord();
      expect(record).toEqual({
        implemented: 'passed',
        testsPassed: 'passed',
        qaPassed: 'failed',
        cleanupDone: null,
        securityPassed: null,
        documented: null,
      });
    });

    it('should deserialize from record', () => {
      const record = {
        implemented: 'passed' as const,
        testsPassed: 'passed' as const,
        qaPassed: null,
        cleanupDone: null,
        securityPassed: null,
        documented: null,
      };

      tracker.fromRecord(record);

      expect(tracker.getGateStatus(WorkflowGateName.IMPLEMENTED)).toBe('passed');
      expect(tracker.getGateStatus(WorkflowGateName.TESTS_PASSED)).toBe('passed');
      expect(tracker.getGateStatus(WorkflowGateName.QA_PASSED)).toBeNull();
    });
  });

  describe('Gate Name Validation', () => {
    it('should accept valid gate names', () => {
      expect(isValidWorkflowGateName('implemented')).toBe(true);
      expect(isValidWorkflowGateName('testsPassed')).toBe(true);
      expect(isValidWorkflowGateName('qaPassed')).toBe(true);
      expect(isValidWorkflowGateName('cleanupDone')).toBe(true);
      expect(isValidWorkflowGateName('securityPassed')).toBe(true);
      expect(isValidWorkflowGateName('documented')).toBe(true);
    });

    it('should reject invalid gate names', () => {
      expect(isValidWorkflowGateName('invalid')).toBe(false);
      expect(isValidWorkflowGateName('')).toBe(false);
      expect(isValidWorkflowGateName('IMPLEMENTED')).toBe(false);
    });
  });
});
