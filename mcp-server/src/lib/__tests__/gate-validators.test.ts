/**
 * Tests for Gate Validators - 4-Layer Validation Pipeline
 *
 * @task T2936
 * @task T3138
 * @epic T2908
 */

import { describe, it, expect } from '@jest/globals';
import {
  validateLayer1Schema,
  validateLayer2Semantic,
  validateLayer3Referential,
  validateLayer4Protocol,
  VALIDATION_RULES,
  isFieldRequired,
  validateWorkflowGateName,
  validateWorkflowGateStatus,
  validateWorkflowGateUpdate,
  VALID_WORKFLOW_AGENTS,
  VALID_WORKFLOW_GATE_STATUSES,
} from '../gate-validators.js';
import {
  GateLayer,
  GateStatus,
  OperationContext,
  WorkflowGateName,
  WorkflowGateTracker,
} from '../verification-gates.js';
import { ProtocolEnforcer, ProtocolType } from '../protocol-enforcement.js';

describe('Gate Validators', () => {
  describe('validateLayer1Schema', () => {
    it('should pass valid parameters', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Valid Task Title',
          description: 'Valid task description with sufficient length',
          priority: 5,
        },
      };

      const result = await validateLayer1Schema(context);
      expect(result.passed).toBe(true);
      expect(result.status).toBe(GateStatus.PASSED);
      expect(result.violations).toHaveLength(0);
    });

    it('should detect invalid task ID', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'update',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'INVALID',
        },
      };

      const result = await validateLayer1Schema(context);
      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('E_INVALID_TASK_ID');
    });

    it('should detect title length violations', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Hi',
        },
      };

      const result = await validateLayer1Schema(context);
      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('E_INVALID_TITLE');
      expect(result.violations[0].constraint).toContain('5-100');
    });

    it('should detect invalid status', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'update',
        gateway: 'cleo_mutate',
        params: {
          status: 'invalid_status',
        },
      };

      const result = await validateLayer1Schema(context);
      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('E_INVALID_STATUS');
    });

    it('should detect priority out of range', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          priority: 15,
        },
      };

      const result = await validateLayer1Schema(context);
      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('E_INVALID_PRIORITY');
    });

    // Section 8.1: Description length 10-1000
    it('should fail on description exceeding 1000 characters', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          description: 'x'.repeat(1001),
        },
      };

      const result = await validateLayer1Schema(context);
      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('E_INVALID_DESCRIPTION');
      expect(result.violations[0].constraint).toContain('10-1000');
    });

    it('should pass description at exactly 1000 characters', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          description: 'x'.repeat(1000),
        },
      };

      const result = await validateLayer1Schema(context);
      // No description violation
      const descViolations = result.violations.filter(v => v.code === 'E_INVALID_DESCRIPTION');
      expect(descViolations).toHaveLength(0);
    });

    // Section 8.2: Manifest ID format ^T\d{3,}-[a-z0-9-]+$
    it('should fail on invalid manifest ID format', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          manifestEntry: {
            id: 'T12-short',  // Only 2 digits, needs 3+
          },
        },
      };

      const result = await validateLayer1Schema(context);
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.code === 'E_INVALID_MANIFEST_ID')).toBe(true);
    });

    it('should pass valid manifest ID format', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          manifestEntry: {
            id: 'T1234-research-output',
          },
        },
      };

      const result = await validateLayer1Schema(context);
      const idViolations = result.violations.filter(v => v.code === 'E_INVALID_MANIFEST_ID');
      expect(idViolations).toHaveLength(0);
    });

    it('should fail manifest ID with uppercase characters', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          manifestEntry: {
            id: 'T1234-Research-Output',
          },
        },
      };

      const result = await validateLayer1Schema(context);
      expect(result.violations.some(v => v.code === 'E_INVALID_MANIFEST_ID')).toBe(true);
    });

    // Section 8.2: Date format ISO 8601 YYYY-MM-DD
    it('should fail on invalid date format in manifest', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          manifestEntry: {
            date: '02/06/2026',
          },
        },
      };

      const result = await validateLayer1Schema(context);
      expect(result.violations.some(v => v.code === 'E_INVALID_DATE_FORMAT')).toBe(true);
    });

    it('should pass valid ISO 8601 date in manifest', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          manifestEntry: {
            date: '2026-02-06',
          },
        },
      };

      const result = await validateLayer1Schema(context);
      const dateViolations = result.violations.filter(v => v.code === 'E_INVALID_DATE_FORMAT');
      expect(dateViolations).toHaveLength(0);
    });

    // Section 8.2: Agent type validation
    it('should fail on invalid agent type in manifest', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          manifestEntry: {
            agent_type: 'unknown_type',
          },
        },
      };

      const result = await validateLayer1Schema(context);
      expect(result.violations.some(v => v.code === 'E_INVALID_AGENT_TYPE')).toBe(true);
    });

    it('should pass valid agent types in manifest', async () => {
      for (const agentType of ['research', 'implementation', 'testing', 'validation']) {
        const context: OperationContext = {
          domain: 'tasks',
          operation: 'complete',
          gateway: 'cleo_mutate',
          params: {
            manifestEntry: {
              agent_type: agentType,
            },
          },
        };

        const result = await validateLayer1Schema(context);
        const agentViolations = result.violations.filter(v => v.code === 'E_INVALID_AGENT_TYPE');
        expect(agentViolations).toHaveLength(0);
      }
    });
  });

  describe('validateLayer2Semantic', () => {
    it('should pass valid semantics', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Task Title',
          description: 'Different description',
        },
      };

      const result = await validateLayer2Semantic(context);
      expect(result.passed).toBe(true);
    });

    it('should detect title/description match', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Same Content',
          description: 'Same Content',
        },
      };

      const result = await validateLayer2Semantic(context);
      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('E_TITLE_DESCRIPTION_SAME');
    });

    it('should detect circular dependency', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'T1234',
          depends: ['T1234'],
        },
      };

      const result = await validateLayer2Semantic(context);
      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('E_CIRCULAR_DEPENDENCY');
    });

    it('should detect invalid session scope', async () => {
      const context: OperationContext = {
        domain: 'session',
        operation: 'start',
        gateway: 'cleo_mutate',
        params: {
          scope: 'invalid_format',
        },
      };

      const result = await validateLayer2Semantic(context);
      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('E_INVALID_SCOPE');
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

      const result = await validateLayer2Semantic(context);
      expect(result.passed).toBe(true); // Warnings don't fail
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].code).toBe('E_NOTES_RECOMMENDED');
    });

    // Section 8.1: No future timestamps
    it('should fail on future created timestamp', async () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Task Title',
          description: 'Task description',
          created: futureDate.toISOString(),
        },
      };

      const result = await validateLayer2Semantic(context);
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.code === 'E_FUTURE_TIMESTAMP')).toBe(true);
    });

    it('should fail on future updated timestamp', async () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const context: OperationContext = {
        domain: 'tasks',
        operation: 'update',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'T1234',
          updated: futureDate.toISOString(),
        },
      };

      const result = await validateLayer2Semantic(context);
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.code === 'E_FUTURE_TIMESTAMP')).toBe(true);
    });

    it('should pass on past timestamps', async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          title: 'Task Title',
          description: 'Task description',
          created: pastDate.toISOString(),
        },
      };

      const result = await validateLayer2Semantic(context);
      const timestampViolations = result.violations.filter(v => v.code === 'E_FUTURE_TIMESTAMP');
      expect(timestampViolations).toHaveLength(0);
    });

    it('should fail on future manifest date', async () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);
      const futureDateStr = futureDate.toISOString().split('T')[0];

      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'T1234',
          manifestEntry: {
            date: futureDateStr,
          },
        },
      };

      const result = await validateLayer2Semantic(context);
      expect(result.violations.some(v => v.code === 'E_FUTURE_TIMESTAMP')).toBe(true);
    });
  });

  describe('validateLayer3Referential', () => {
    it('should pass valid references', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          parent: 'T1234',
          depends: ['T5678', 'T9012'],
        },
      };

      const result = await validateLayer3Referential(context);
      expect(result.passed).toBe(true);
    });

    it('should detect invalid parent reference', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          parent: 'INVALID',
        },
      };

      const result = await validateLayer3Referential(context);
      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('E_INVALID_PARENT_REF');
    });

    it('should detect invalid dependency reference', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          depends: ['T1234', 'INVALID'],
        },
      };

      const result = await validateLayer3Referential(context);
      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('E_INVALID_DEPENDENCY_REF');
    });

    it('should detect missing taskId for update', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'update',
        gateway: 'cleo_mutate',
        params: {},
      };

      const result = await validateLayer3Referential(context);
      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('E_TASK_ID_REQUIRED');
    });

    // Section 8.1: Hierarchy depth max 3
    it('should fail when hierarchy depth exceeds 3', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          depth: 4,
        },
      };

      const result = await validateLayer3Referential(context);
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.code === 'E_DEPTH_EXCEEDED')).toBe(true);
    });

    it('should pass when hierarchy depth is at max', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          depth: 3,
        },
      };

      const result = await validateLayer3Referential(context);
      const depthViolations = result.violations.filter(v => v.code === 'E_DEPTH_EXCEEDED');
      expect(depthViolations).toHaveLength(0);
    });

    // Section 8.1: Sibling limit max 7
    it('should fail when sibling limit reached', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          siblingCount: 7,
        },
      };

      const result = await validateLayer3Referential(context);
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.code === 'E_SIBLING_LIMIT')).toBe(true);
    });

    it('should pass when under sibling limit', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {
          siblingCount: 6,
        },
      };

      const result = await validateLayer3Referential(context);
      const siblingViolations = result.violations.filter(v => v.code === 'E_SIBLING_LIMIT');
      expect(siblingViolations).toHaveLength(0);
    });

    // Section 8.2: Manifest file reference
    it('should fail on empty manifest file reference', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'T1234',
          manifestEntry: {
            file: '',
          },
        },
      };

      const result = await validateLayer3Referential(context);
      expect(result.violations.some(v => v.code === 'E_EMPTY_FILE_REF')).toBe(true);
    });
  });

  describe('validateLayer4Protocol', () => {
    const enforcer = new ProtocolEnforcer(true);

    it('should skip when protocol type not set', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'create',
        gateway: 'cleo_mutate',
        params: {},
      };

      const result = await validateLayer4Protocol(context, enforcer);
      expect(result.status).toBe(GateStatus.SKIPPED);
      expect(result.passed).toBe(true);
    });

    it('should validate manifest fields', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          manifestEntry: {
            id: 'T1234-slug',
            // Missing required fields
          },
        },
        protocolType: ProtocolType.IMPLEMENTATION,
      };

      const result = await validateLayer4Protocol(context, enforcer);
      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    it('should validate manifest status enum', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          manifestEntry: {
            id: 'T1234-slug',
            file: 'output.md',
            title: 'Title',
            date: '2026-02-03',
            status: 'invalid_status',
            agent_type: 'implementation',
          },
        },
        protocolType: ProtocolType.IMPLEMENTATION,
      };

      const result = await validateLayer4Protocol(context, enforcer);
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.code === 'E_INVALID_MANIFEST_STATUS')).toBe(true);
    });

    it('should warn on missing provenance tags', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          files: ['lib/new-module.ts'],
        },
        protocolType: ProtocolType.IMPLEMENTATION,
      };

      const result = await validateLayer4Protocol(context, enforcer);
      expect(result.passed).toBe(true); // Warning only
      expect(result.violations.some((v) => v.code === 'E_PROVENANCE_CHECK')).toBe(true);
    });

    // Section 8.2: Key findings count 3-7 for research
    it('should fail on too few key findings for research', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'T1234',
          manifestEntry: {
            key_findings: ['finding1', 'finding2'],
          },
        },
        protocolType: ProtocolType.RESEARCH,
      };

      const result = await validateLayer4Protocol(context, enforcer);
      expect(result.violations.some(v => v.code === 'E_KEY_FINDINGS_COUNT')).toBe(true);
    });

    it('should fail on too many key findings for research', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'T1234',
          manifestEntry: {
            key_findings: Array(8).fill('finding'),
          },
        },
        protocolType: ProtocolType.RESEARCH,
      };

      const result = await validateLayer4Protocol(context, enforcer);
      expect(result.violations.some(v => v.code === 'E_KEY_FINDINGS_COUNT')).toBe(true);
    });

    it('should pass valid key findings count for research', async () => {
      const context: OperationContext = {
        domain: 'tasks',
        operation: 'complete',
        gateway: 'cleo_mutate',
        params: {
          taskId: 'T1234',
          manifestEntry: {
            key_findings: ['f1', 'f2', 'f3', 'f4', 'f5'],
          },
        },
        protocolType: ProtocolType.RESEARCH,
      };

      const result = await validateLayer4Protocol(context, enforcer);
      const findingsViolations = result.violations.filter(v => v.code === 'E_KEY_FINDINGS_COUNT');
      expect(findingsViolations).toHaveLength(0);
    });
  });

  describe('VALIDATION_RULES', () => {
    it('should export correct rule constants', () => {
      expect(VALIDATION_RULES.TASK_ID_PATTERN).toEqual(/^T[0-9]+$/);
      expect(VALIDATION_RULES.TITLE_MIN_LENGTH).toBe(5);
      expect(VALIDATION_RULES.TITLE_MAX_LENGTH).toBe(100);
      expect(VALIDATION_RULES.DESCRIPTION_MIN_LENGTH).toBe(10);
      expect(VALIDATION_RULES.VALID_STATUSES).toEqual(['pending', 'active', 'blocked', 'done']);
      expect(VALIDATION_RULES.PRIORITY_MIN).toBe(1);
      expect(VALIDATION_RULES.PRIORITY_MAX).toBe(9);
      expect(VALIDATION_RULES.MAX_DEPTH).toBe(3);
      expect(VALIDATION_RULES.MAX_SIBLINGS).toBe(7);
    });

    it('should export new Section 8 rule constants', () => {
      expect(VALIDATION_RULES.MANIFEST_ID_PATTERN).toEqual(/^T\d{3,}-[a-z0-9-]+$/);
      expect(VALIDATION_RULES.DATE_FORMAT_PATTERN).toEqual(/^\d{4}-\d{2}-\d{2}$/);
      expect(VALIDATION_RULES.DESCRIPTION_MAX_LENGTH).toBe(1000);
      expect(VALIDATION_RULES.VALID_MANIFEST_STATUSES).toEqual(['complete', 'partial', 'blocked']);
      expect(VALIDATION_RULES.VALID_AGENT_TYPES).toContain('research');
      expect(VALIDATION_RULES.VALID_AGENT_TYPES).toContain('implementation');
      expect(VALIDATION_RULES.VALID_AGENT_TYPES).toContain('testing');
      expect(VALIDATION_RULES.VALID_AGENT_TYPES).toContain('validation');
      expect(VALIDATION_RULES.KEY_FINDINGS_MIN).toBe(3);
      expect(VALIDATION_RULES.KEY_FINDINGS_MAX).toBe(7);
    });
  });

  describe('isFieldRequired', () => {
    it('should detect required fields for create', () => {
      expect(isFieldRequired('tasks', 'create', 'title')).toBe(true);
      expect(isFieldRequired('tasks', 'create', 'description')).toBe(true);
      expect(isFieldRequired('tasks', 'create', 'priority')).toBe(false);
    });

    it('should detect required fields for update', () => {
      expect(isFieldRequired('tasks', 'update', 'taskId')).toBe(true);
      expect(isFieldRequired('tasks', 'update', 'title')).toBe(false);
    });

    it('should detect required fields for session', () => {
      expect(isFieldRequired('session', 'start', 'scope')).toBe(true);
      expect(isFieldRequired('session', 'focus.set', 'taskId')).toBe(true);
    });
  });
});

/**
 * Section 7: Workflow Gate Validator Tests
 *
 * @task T3141
 */
describe('Workflow Gate Validators', () => {
  describe('validateWorkflowGateName', () => {
    it('should accept valid gate names', () => {
      expect(validateWorkflowGateName('implemented')).toBe(true);
      expect(validateWorkflowGateName('testsPassed')).toBe(true);
      expect(validateWorkflowGateName('qaPassed')).toBe(true);
      expect(validateWorkflowGateName('cleanupDone')).toBe(true);
      expect(validateWorkflowGateName('securityPassed')).toBe(true);
      expect(validateWorkflowGateName('documented')).toBe(true);
    });

    it('should reject invalid gate names', () => {
      expect(validateWorkflowGateName('invalid')).toBe(false);
      expect(validateWorkflowGateName('')).toBe(false);
      expect(validateWorkflowGateName('IMPLEMENTED')).toBe(false);
    });
  });

  describe('validateWorkflowGateStatus', () => {
    it('should accept valid statuses', () => {
      expect(validateWorkflowGateStatus(null)).toBe(true);
      expect(validateWorkflowGateStatus('passed')).toBe(true);
      expect(validateWorkflowGateStatus('failed')).toBe(true);
      expect(validateWorkflowGateStatus('blocked')).toBe(true);
    });

    it('should reject invalid statuses', () => {
      expect(validateWorkflowGateStatus('pending')).toBe(false);
      expect(validateWorkflowGateStatus('skipped')).toBe(false);
      expect(validateWorkflowGateStatus('')).toBe(false);
      expect(validateWorkflowGateStatus(undefined)).toBe(false);
    });
  });

  describe('validateWorkflowGateUpdate', () => {
    it('should reject invalid gate name', () => {
      const violations = validateWorkflowGateUpdate('invalid', 'passed');
      expect(violations).toHaveLength(1);
      expect(violations[0].code).toBe('E_INVALID_GATE');
    });

    it('should reject invalid status for update', () => {
      const violations = validateWorkflowGateUpdate('implemented', 'blocked');
      expect(violations).toHaveLength(1);
      expect(violations[0].code).toBe('E_INVALID_GATE_STATUS');
    });

    it('should accept valid pass operation', () => {
      const violations = validateWorkflowGateUpdate('implemented', 'passed');
      expect(violations).toHaveLength(0);
    });

    it('should accept valid fail operation', () => {
      const violations = validateWorkflowGateUpdate('implemented', 'failed');
      expect(violations).toHaveLength(0);
    });

    it('should reject wrong agent when tracker provided', () => {
      const tracker = new WorkflowGateTracker();
      const violations = validateWorkflowGateUpdate(
        'implemented',
        'passed',
        'testing',
        tracker
      );
      expect(violations.some((v) => v.code === 'E_INVALID_AGENT')).toBe(true);
    });

    it('should accept correct agent when tracker provided', () => {
      const tracker = new WorkflowGateTracker();
      const violations = validateWorkflowGateUpdate(
        'implemented',
        'passed',
        'coder',
        tracker
      );
      expect(violations).toHaveLength(0);
    });

    it('should reject pass when dependencies not met', () => {
      const tracker = new WorkflowGateTracker();
      const violations = validateWorkflowGateUpdate(
        'testsPassed',
        'passed',
        undefined,
        tracker
      );
      expect(violations.some((v) => v.code === 'E_GATE_DEPENDENCY')).toBe(true);
    });

    it('should accept pass when dependencies met', () => {
      const tracker = new WorkflowGateTracker();
      tracker.passGate(WorkflowGateName.IMPLEMENTED);
      const violations = validateWorkflowGateUpdate(
        'testsPassed',
        'passed',
        'testing',
        tracker
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe('Constants', () => {
    it('should export valid workflow agents', () => {
      expect(VALID_WORKFLOW_AGENTS).toEqual(['coder', 'testing', 'qa', 'cleanup', 'security', 'docs']);
    });

    it('should export valid workflow gate statuses', () => {
      expect(VALID_WORKFLOW_GATE_STATUSES).toEqual([null, 'passed', 'failed', 'blocked']);
    });
  });
});
