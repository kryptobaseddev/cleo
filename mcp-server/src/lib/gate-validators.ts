/**
 * Gate Validators for 4-Layer Verification System
 *
 * @task T2936
 * @task T3138
 * @epic T2908
 *
 * Individual validator functions for each gate layer:
 * - Layer 1: Schema validation (JSON Schema, format constraints)
 * - Layer 2: Semantic validation (business rules, anti-hallucination)
 * - Layer 3: Referential validation (cross-entity integrity)
 * - Layer 4: Protocol validation (RCSD-IVTR lifecycle)
 *
 * Reference: docs/specs/MCP-SERVER-SPECIFICATION.md Section 8
 */

import {
  GateLayer,
  GateStatus,
  GateViolation,
  LayerResult,
  OperationContext,
  WorkflowGateName,
  WorkflowGateTracker,
  WORKFLOW_GATE_SEQUENCE,
  isValidWorkflowGateName,
} from './verification-gates.js';
import { ErrorSeverity } from './exit-codes.js';
import { ProtocolEnforcer } from './protocol-enforcement.js';

/**
 * Layer 1: Schema Validation
 *
 * Validates operation parameters against JSON Schema definitions.
 * Checks required fields, data types, and format constraints.
 */
export async function validateLayer1Schema(
  context: OperationContext
): Promise<LayerResult> {
  const violations: GateViolation[] = [];

  // Task ID validation (if present)
  if (context.params?.taskId) {
    const taskId = context.params.taskId as string;
    if (!taskId.match(/^T[0-9]+$/)) {
      violations.push({
        layer: GateLayer.SCHEMA,
        severity: ErrorSeverity.ERROR,
        code: 'E_INVALID_TASK_ID',
        message: `Invalid task ID format: ${taskId}`,
        field: 'taskId',
        value: taskId,
        constraint: 'Must match pattern ^T[0-9]+$',
        fix: 'Use format T followed by digits (e.g., T1234)',
      });
    }
  }

  // Title validation (for create/update operations)
  if (context.params?.title !== undefined) {
    const title = context.params.title as string;
    if (typeof title !== 'string' || title.length < 5 || title.length > 100) {
      violations.push({
        layer: GateLayer.SCHEMA,
        severity: ErrorSeverity.ERROR,
        code: 'E_INVALID_TITLE',
        message: 'Title must be 5-100 characters',
        field: 'title',
        value: title,
        constraint: 'length: 5-100',
        fix: 'Provide a title between 5 and 100 characters',
      });
    }
  }

  // Description validation (Section 8.1: 10-1000 characters)
  if (context.params?.description !== undefined) {
    const description = context.params.description as string;
    if (typeof description !== 'string' || description.length < 10 || description.length > 1000) {
      violations.push({
        layer: GateLayer.SCHEMA,
        severity: ErrorSeverity.ERROR,
        code: 'E_INVALID_DESCRIPTION',
        message: 'Description must be 10-1000 characters',
        field: 'description',
        value: typeof description === 'string' ? `${description.substring(0, 50)}...` : description,
        constraint: 'length: 10-1000',
        fix: 'Provide a description between 10 and 1000 characters',
      });
    }
  }

  // Manifest ID format validation (Section 8.2: ^T\d{3,}-[a-z0-9-]+$)
  if (context.params?.manifestEntry) {
    const entry = context.params.manifestEntry as Record<string, unknown>;
    if (entry.id) {
      const manifestId = entry.id as string;
      if (!manifestId.match(/^T\d{3,}-[a-z0-9-]+$/)) {
        violations.push({
          layer: GateLayer.SCHEMA,
          severity: ErrorSeverity.ERROR,
          code: 'E_INVALID_MANIFEST_ID',
          message: `Invalid manifest ID format: ${manifestId}`,
          field: 'manifestEntry.id',
          value: manifestId,
          constraint: 'Must match ^T\\d{3,}-[a-z0-9-]+$',
          fix: 'Use format T####-slug (e.g., T1234-research-output)',
        });
      }
    }

    // Date format validation (Section 8.2: ISO 8601 YYYY-MM-DD)
    if (entry.date) {
      const date = entry.date as string;
      if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        violations.push({
          layer: GateLayer.SCHEMA,
          severity: ErrorSeverity.ERROR,
          code: 'E_INVALID_DATE_FORMAT',
          message: `Invalid date format: ${date}`,
          field: 'manifestEntry.date',
          value: date,
          constraint: 'Must be ISO 8601 YYYY-MM-DD',
          fix: 'Use date format YYYY-MM-DD (e.g., 2026-02-06)',
        });
      }
    }

    // Agent type validation (Section 8.2: known protocol type)
    if (entry.agent_type) {
      const agentType = entry.agent_type as string;
      const validAgentTypes = [
        'research', 'analysis', 'specification', 'implementation',
        'testing', 'validation', 'documentation', 'release',
      ];
      if (!validAgentTypes.includes(agentType)) {
        violations.push({
          layer: GateLayer.SCHEMA,
          severity: ErrorSeverity.ERROR,
          code: 'E_INVALID_AGENT_TYPE',
          message: `Invalid agent type: ${agentType}`,
          field: 'manifestEntry.agent_type',
          value: agentType,
          constraint: `Must be one of: ${validAgentTypes.join(', ')}`,
          fix: `Use one of: ${validAgentTypes.join(', ')}`,
        });
      }
    }
  }

  // Status validation
  if (context.params?.status) {
    const status = context.params.status as string;
    const validStatuses = ['pending', 'active', 'blocked', 'done'];
    if (!validStatuses.includes(status)) {
      violations.push({
        layer: GateLayer.SCHEMA,
        severity: ErrorSeverity.ERROR,
        code: 'E_INVALID_STATUS',
        message: `Invalid status: ${status}`,
        field: 'status',
        value: status,
        constraint: `Must be one of: ${validStatuses.join(', ')}`,
        fix: `Use one of: ${validStatuses.join(', ')}`,
      });
    }
  }

  // Priority validation
  if (context.params?.priority !== undefined) {
    const priority = context.params.priority;
    if (typeof priority !== 'number' || priority < 1 || priority > 9) {
      violations.push({
        layer: GateLayer.SCHEMA,
        severity: ErrorSeverity.ERROR,
        code: 'E_INVALID_PRIORITY',
        message: 'Priority must be 1-9',
        field: 'priority',
        value: priority,
        constraint: 'range: 1-9',
        fix: 'Set priority between 1 (highest) and 9 (lowest)',
      });
    }
  }

  return {
    layer: GateLayer.SCHEMA,
    status: violations.length > 0 ? GateStatus.FAILED : GateStatus.PASSED,
    passed: violations.length === 0,
    violations,
    duration_ms: 0,
  };
}

/**
 * Layer 2: Semantic Validation
 *
 * Validates business rules and logical constraints.
 * Checks hierarchy depth, sibling limits, title/description uniqueness.
 */
export async function validateLayer2Semantic(
  context: OperationContext
): Promise<LayerResult> {
  const violations: GateViolation[] = [];

  // Title and description must be different (anti-hallucination)
  if (context.params?.title && context.params?.description) {
    const title = context.params.title as string;
    const description = context.params.description as string;
    if (title === description) {
      violations.push({
        layer: GateLayer.SEMANTIC,
        severity: ErrorSeverity.ERROR,
        code: 'E_TITLE_DESCRIPTION_SAME',
        message: 'Title and description must be different',
        field: 'description',
        constraint: 'must differ from title',
        fix: 'Provide a unique description that explains the task',
      });
    }
  }

  // No future timestamps (Section 8.1: created/updated <= now)
  if (context.params?.created || context.params?.updated) {
    const now = new Date();
    for (const field of ['created', 'updated'] as const) {
      const value = context.params?.[field] as string | undefined;
      if (value) {
        const timestamp = new Date(value);
        if (!isNaN(timestamp.getTime()) && timestamp > now) {
          violations.push({
            layer: GateLayer.SEMANTIC,
            severity: ErrorSeverity.ERROR,
            code: 'E_FUTURE_TIMESTAMP',
            message: `Timestamp ${field} cannot be in the future: ${value}`,
            field,
            value,
            constraint: `${field} <= current time`,
            fix: `Set ${field} to current or past timestamp`,
          });
        }
      }
    }
  }

  // Manifest date must not be future (Section 8.1)
  if (context.params?.manifestEntry) {
    const entry = context.params.manifestEntry as Record<string, unknown>;
    if (entry.date) {
      const dateStr = entry.date as string;
      const today = new Date().toISOString().split('T')[0];
      if (dateStr > today) {
        violations.push({
          layer: GateLayer.SEMANTIC,
          severity: ErrorSeverity.ERROR,
          code: 'E_FUTURE_TIMESTAMP',
          message: `Manifest date cannot be in the future: ${dateStr}`,
          field: 'manifestEntry.date',
          value: dateStr,
          constraint: 'date <= today',
          fix: 'Set date to today or earlier',
        });
      }
    }
  }

  // Circular dependency check (if depends specified)
  if (context.params?.depends) {
    const depends = context.params.depends as string[];
    const taskId = context.params?.taskId as string | undefined;
    if (taskId && depends.includes(taskId)) {
      violations.push({
        layer: GateLayer.SEMANTIC,
        severity: ErrorSeverity.ERROR,
        code: 'E_CIRCULAR_DEPENDENCY',
        message: 'Task cannot depend on itself',
        field: 'depends',
        constraint: 'no self-reference',
        fix: 'Remove self-reference from dependencies',
      });
    }
  }

  // Session scope validation
  if (context.domain === 'session' && context.operation === 'start') {
    const scope = context.params?.scope as string | undefined;
    if (scope && !scope.match(/^(epic|task|global):/)) {
      violations.push({
        layer: GateLayer.SEMANTIC,
        severity: ErrorSeverity.ERROR,
        code: 'E_INVALID_SCOPE',
        message: `Invalid session scope format: ${scope}`,
        field: 'scope',
        constraint: 'Must be epic:<id>, task:<id>, or global',
        fix: 'Use format: epic:T1234, task:T5678, or global',
      });
    }
  }

  // Notes required for completion (if configured)
  if (context.operation === 'complete' && context.params?.notes === undefined) {
    violations.push({
      layer: GateLayer.SEMANTIC,
      severity: ErrorSeverity.WARNING,
      code: 'E_NOTES_RECOMMENDED',
      message: 'Completion notes are recommended',
      field: 'notes',
      constraint: 'should be present',
      fix: 'Add --notes "..." to document completion',
    });
  }

  return {
    layer: GateLayer.SEMANTIC,
    status: violations.filter((v) => v.severity === ErrorSeverity.ERROR).length > 0
      ? GateStatus.FAILED
      : GateStatus.PASSED,
    passed: violations.filter((v) => v.severity === ErrorSeverity.ERROR).length === 0,
    violations,
    duration_ms: 0,
  };
}

/**
 * Layer 3: Referential Validation
 *
 * Validates cross-entity references and relationships.
 * Checks task existence, parent/child relationships, dependencies.
 */
export async function validateLayer3Referential(
  context: OperationContext
): Promise<LayerResult> {
  const violations: GateViolation[] = [];

  // Parent task validation (if specified)
  if (context.params?.parent) {
    const parent = context.params.parent as string;
    // Note: In production, this would call CLIExecutor to check existence
    // For now, we validate format
    if (!parent.match(/^T[0-9]+$/)) {
      violations.push({
        layer: GateLayer.REFERENTIAL,
        severity: ErrorSeverity.ERROR,
        code: 'E_INVALID_PARENT_REF',
        message: `Invalid parent reference: ${parent}`,
        field: 'parent',
        value: parent,
        constraint: 'Must be valid task ID',
        fix: 'Verify parent task exists with: cleo exists <id>',
      });
    }
  }

  // Dependency validation
  if (context.params?.depends) {
    const depends = context.params.depends as string[];
    for (const depId of depends) {
      if (!depId.match(/^T[0-9]+$/)) {
        violations.push({
          layer: GateLayer.REFERENTIAL,
          severity: ErrorSeverity.ERROR,
          code: 'E_INVALID_DEPENDENCY_REF',
          message: `Invalid dependency reference: ${depId}`,
          field: 'depends',
          value: depId,
          constraint: 'Must be valid task ID',
          fix: 'Verify dependency exists with: cleo find --id <id>',
        });
      }
    }
  }

  // Task existence validation (for update/complete/delete operations)
  if (['update', 'complete', 'delete', 'archive', 'reopen'].includes(context.operation)) {
    const taskId = context.params?.taskId as string | undefined;
    if (!taskId) {
      violations.push({
        layer: GateLayer.REFERENTIAL,
        severity: ErrorSeverity.ERROR,
        code: 'E_TASK_ID_REQUIRED',
        message: 'Task ID is required for this operation',
        field: 'taskId',
        constraint: 'required',
        fix: 'Provide task ID with --taskId T####',
      });
    }
  }

  // Session validation (for focus operations)
  if (context.domain === 'session' && context.operation === 'focus.set') {
    const taskId = context.params?.taskId as string | undefined;
    if (taskId && !taskId.match(/^T[0-9]+$/)) {
      violations.push({
        layer: GateLayer.REFERENTIAL,
        severity: ErrorSeverity.ERROR,
        code: 'E_INVALID_FOCUS_REF',
        message: `Invalid focus task reference: ${taskId}`,
        field: 'taskId',
        value: taskId,
        constraint: 'Must be valid task ID',
        fix: 'Use valid task ID format: T####',
      });
    }
  }

  // Hierarchy depth validation (Section 8.1: max 3 levels)
  if (context.params?.depth !== undefined) {
    const depth = context.params.depth as number;
    if (typeof depth === 'number' && depth > VALIDATION_RULES.MAX_DEPTH) {
      violations.push({
        layer: GateLayer.REFERENTIAL,
        severity: ErrorSeverity.ERROR,
        code: 'E_DEPTH_EXCEEDED',
        message: `Hierarchy depth ${depth} exceeds maximum of ${VALIDATION_RULES.MAX_DEPTH}`,
        field: 'depth',
        value: depth,
        constraint: `max depth: ${VALIDATION_RULES.MAX_DEPTH}`,
        fix: 'Flatten hierarchy to max 3 levels (epic -> task -> subtask)',
      });
    }
  }

  // Sibling limit validation (Section 8.1: max 7 per parent)
  if (context.params?.siblingCount !== undefined) {
    const siblingCount = context.params.siblingCount as number;
    if (typeof siblingCount === 'number' && siblingCount >= VALIDATION_RULES.MAX_SIBLINGS) {
      violations.push({
        layer: GateLayer.REFERENTIAL,
        severity: ErrorSeverity.ERROR,
        code: 'E_SIBLING_LIMIT',
        message: `Parent already has ${siblingCount} children (max ${VALIDATION_RULES.MAX_SIBLINGS})`,
        field: 'siblingCount',
        value: siblingCount,
        constraint: `max siblings: ${VALIDATION_RULES.MAX_SIBLINGS}`,
        fix: 'Create a new parent to group related tasks',
      });
    }
  }

  // Manifest file reference validation (Section 8.2: referenced file readable)
  if (context.params?.manifestEntry) {
    const entry = context.params.manifestEntry as Record<string, unknown>;
    if (typeof entry.file === 'string' && entry.file.length === 0) {
      violations.push({
        layer: GateLayer.REFERENTIAL,
        severity: ErrorSeverity.ERROR,
        code: 'E_EMPTY_FILE_REF',
        message: 'Manifest entry file reference cannot be empty',
        field: 'manifestEntry.file',
        value: entry.file,
        constraint: 'must be non-empty file path',
        fix: 'Provide a valid file path in manifest entry',
      });
    }
  }

  return {
    layer: GateLayer.REFERENTIAL,
    status: violations.length > 0 ? GateStatus.FAILED : GateStatus.PASSED,
    passed: violations.length === 0,
    violations,
    duration_ms: 0,
  };
}

/**
 * Layer 4: Protocol Validation
 *
 * Validates RCSD-IVTR lifecycle compliance and protocol requirements.
 * Checks lifecycle gates, protocol-specific rules, provenance tags.
 */
export async function validateLayer4Protocol(
  context: OperationContext,
  enforcer: ProtocolEnforcer
): Promise<LayerResult> {
  const violations: GateViolation[] = [];

  // Skip protocol validation for non-protocol operations
  if (!context.protocolType) {
    return {
      layer: GateLayer.PROTOCOL,
      status: GateStatus.SKIPPED,
      passed: true,
      violations: [],
      duration_ms: 0,
    };
  }

  // Lifecycle gate validation (for spawn/complete operations)
  if (context.operation === 'spawn' || context.operation === 'complete') {
    const taskId = context.params?.taskId as string | undefined;
    const protocolType = context.protocolType;

    // Check lifecycle prerequisites
    const lifecycleGates: Record<string, string[]> = {
      research: [],
      consensus: ['research'],
      specification: ['research', 'consensus'],
      decomposition: ['research', 'consensus', 'specification'],
      implementation: ['research', 'consensus', 'specification', 'decomposition'],
      validation: ['implementation'],
      testing: ['implementation', 'validation'],
      release: ['implementation', 'validation', 'testing'],
    };

    const requiredGates = lifecycleGates[protocolType] || [];
    if (requiredGates.length > 0) {
      // Note: In production, check actual gate status via CLIExecutor
      // For now, we document the requirement
      violations.push({
        layer: GateLayer.PROTOCOL,
        severity: ErrorSeverity.INFO,
        code: 'E_LIFECYCLE_PREREQUISITES',
        message: `This operation requires prior stages: ${requiredGates.join(', ')}`,
        field: 'lifecycle',
        constraint: `prerequisites: ${requiredGates.join(', ')}`,
        fix: 'Ensure prior lifecycle stages are complete',
      });
    }
  }

  // Manifest validation (for complete operations)
  if (context.operation === 'complete') {
    const manifestEntry = context.params?.manifestEntry as Record<string, unknown> | undefined;
    if (manifestEntry) {
      // Required manifest fields
      const requiredFields = ['id', 'file', 'title', 'date', 'status', 'agent_type'];
      for (const field of requiredFields) {
        if (!manifestEntry[field]) {
          violations.push({
            layer: GateLayer.PROTOCOL,
            severity: ErrorSeverity.ERROR,
            code: 'E_MANIFEST_FIELD_MISSING',
            message: `Manifest entry missing required field: ${field}`,
            field: `manifestEntry.${field}`,
            constraint: 'required',
            fix: `Add ${field} to manifest entry`,
          });
        }
      }

      // Status enum validation
      const status = manifestEntry.status as string;
      if (!['complete', 'partial', 'blocked'].includes(status)) {
        violations.push({
          layer: GateLayer.PROTOCOL,
          severity: ErrorSeverity.ERROR,
          code: 'E_INVALID_MANIFEST_STATUS',
          message: `Invalid manifest status: ${status}`,
          field: 'manifestEntry.status',
          value: status,
          constraint: 'Must be: complete, partial, or blocked',
          fix: 'Set status to complete, partial, or blocked',
        });
      }
    }
  }

  // Key findings validation for research protocol (Section 8.2: 3-7 items)
  if (context.protocolType === 'research' && context.operation === 'complete') {
    const manifestEntry = context.params?.manifestEntry as Record<string, unknown> | undefined;
    if (manifestEntry?.key_findings) {
      const findings = manifestEntry.key_findings;
      if (!Array.isArray(findings) || findings.length < VALIDATION_RULES.KEY_FINDINGS_MIN || findings.length > VALIDATION_RULES.KEY_FINDINGS_MAX) {
        violations.push({
          layer: GateLayer.PROTOCOL,
          severity: ErrorSeverity.ERROR,
          code: 'E_KEY_FINDINGS_COUNT',
          message: `Research must have ${VALIDATION_RULES.KEY_FINDINGS_MIN}-${VALIDATION_RULES.KEY_FINDINGS_MAX} key findings, got ${Array.isArray(findings) ? findings.length : 0}`,
          field: 'manifestEntry.key_findings',
          value: Array.isArray(findings) ? findings.length : findings,
          constraint: `count: ${VALIDATION_RULES.KEY_FINDINGS_MIN}-${VALIDATION_RULES.KEY_FINDINGS_MAX}`,
          fix: 'Adjust key findings to have 3-7 items',
        });
      }
    }
  }

  // Provenance validation (for implementation protocol)
  if (context.protocolType === 'implementation') {
    const files = context.params?.files as string[] | undefined;
    if (files && files.length > 0) {
      violations.push({
        layer: GateLayer.PROTOCOL,
        severity: ErrorSeverity.WARNING,
        code: 'E_PROVENANCE_CHECK',
        message: 'Implementation files should include @task provenance tags',
        field: 'files',
        constraint: 'should include @task comments',
        fix: 'Add @task T#### comments to new functions/classes',
      });
    }
  }

  return {
    layer: GateLayer.PROTOCOL,
    status: violations.filter((v) => v.severity === ErrorSeverity.ERROR).length > 0
      ? GateStatus.FAILED
      : GateStatus.PASSED,
    passed: violations.filter((v) => v.severity === ErrorSeverity.ERROR).length === 0,
    violations,
    duration_ms: 0,
  };
}

/**
 * Validation rule definitions for reuse
 */
export const VALIDATION_RULES = {
  TASK_ID_PATTERN: /^T[0-9]+$/,
  MANIFEST_ID_PATTERN: /^T\d{3,}-[a-z0-9-]+$/,
  DATE_FORMAT_PATTERN: /^\d{4}-\d{2}-\d{2}$/,
  TITLE_MIN_LENGTH: 5,
  TITLE_MAX_LENGTH: 100,
  DESCRIPTION_MIN_LENGTH: 10,
  DESCRIPTION_MAX_LENGTH: 1000,
  VALID_STATUSES: ['pending', 'active', 'blocked', 'done'] as const,
  VALID_MANIFEST_STATUSES: ['complete', 'partial', 'blocked'] as const,
  VALID_AGENT_TYPES: [
    'research', 'analysis', 'specification', 'implementation',
    'testing', 'validation', 'documentation', 'release',
  ] as const,
  PRIORITY_MIN: 1,
  PRIORITY_MAX: 9,
  MAX_DEPTH: 3,
  MAX_SIBLINGS: 7,
  KEY_FINDINGS_MIN: 3,
  KEY_FINDINGS_MAX: 7,
};

/**
 * Helper to check if a field is required for an operation
 */
export function isFieldRequired(
  domain: string,
  operation: string,
  field: string
): boolean {
  const requirements: Record<string, Record<string, string[]>> = {
    tasks: {
      create: ['title', 'description'],
      update: ['taskId'],
      complete: ['taskId'],
      delete: ['taskId'],
    },
    session: {
      start: ['scope'],
      'focus.set': ['taskId'],
    },
  };

  return requirements[domain]?.[operation]?.includes(field) ?? false;
}

// ============================================================================
// Section 7: Workflow Gate Validators
// ============================================================================

/**
 * Valid workflow gate agent names per Section 7.2
 */
export const VALID_WORKFLOW_AGENTS = ['coder', 'testing', 'qa', 'cleanup', 'security', 'docs'] as const;

/**
 * Valid workflow gate status values per Section 7.3
 */
export const VALID_WORKFLOW_GATE_STATUSES = [null, 'passed', 'failed', 'blocked'] as const;

/**
 * Validate a workflow gate name
 *
 * @task T3141
 */
export function validateWorkflowGateName(name: string): boolean {
  return isValidWorkflowGateName(name);
}

/**
 * Validate a workflow gate status value per Section 7.3
 *
 * @task T3141
 */
export function validateWorkflowGateStatus(
  status: unknown
): status is null | 'passed' | 'failed' | 'blocked' {
  return status === null || status === 'passed' || status === 'failed' || status === 'blocked';
}

/**
 * Validate a gate update operation.
 *
 * Checks that:
 * - Gate name is valid
 * - Status value is valid
 * - Agent matches expected agent for the gate
 * - Dependencies are met for pass operations
 *
 * @task T3141
 */
export function validateWorkflowGateUpdate(
  gateName: string,
  status: string,
  agent?: string,
  tracker?: WorkflowGateTracker
): GateViolation[] {
  const violations: GateViolation[] = [];

  // Validate gate name
  if (!isValidWorkflowGateName(gateName)) {
    violations.push({
      layer: GateLayer.PROTOCOL,
      severity: ErrorSeverity.ERROR,
      code: 'E_INVALID_GATE',
      message: `Invalid workflow gate name: ${gateName}`,
      field: 'gateName',
      value: gateName,
      constraint: `Must be one of: ${WORKFLOW_GATE_SEQUENCE.join(', ')}`,
      fix: `Use a valid gate name: ${WORKFLOW_GATE_SEQUENCE.join(', ')}`,
    });
    return violations;
  }

  // Validate status
  if (status !== 'passed' && status !== 'failed') {
    violations.push({
      layer: GateLayer.PROTOCOL,
      severity: ErrorSeverity.ERROR,
      code: 'E_INVALID_GATE_STATUS',
      message: `Invalid gate status for update: ${status}`,
      field: 'status',
      value: status,
      constraint: 'Must be "passed" or "failed" for update operations',
      fix: 'Use status "passed" or "failed"',
    });
  }

  // Validate agent match (if tracker provided for context)
  if (agent && tracker) {
    const gateState = tracker.getGateState(gateName as WorkflowGateName);
    if (gateState && agent !== gateState.agent) {
      violations.push({
        layer: GateLayer.PROTOCOL,
        severity: ErrorSeverity.ERROR,
        code: 'E_INVALID_AGENT',
        message: `Agent "${agent}" is not authorized for gate "${gateName}" (expected: ${gateState.agent})`,
        field: 'agent',
        value: agent,
        constraint: `Must be agent: ${gateState.agent}`,
        fix: `Use the correct agent: ${gateState.agent}`,
      });
    }
  }

  // Validate dependencies are met for pass operations
  if (status === 'passed' && tracker) {
    if (!tracker.canAttempt(gateName as WorkflowGateName)) {
      violations.push({
        layer: GateLayer.PROTOCOL,
        severity: ErrorSeverity.ERROR,
        code: 'E_GATE_DEPENDENCY',
        message: `Cannot pass gate "${gateName}": dependencies not met`,
        field: 'gateName',
        value: gateName,
        constraint: 'All dependency gates must be passed first',
        fix: 'Pass all prerequisite gates first',
      });
    }
  }

  return violations;
}
