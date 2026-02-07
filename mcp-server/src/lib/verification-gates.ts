/**
 * Verification Gate System for CLEO MCP Server
 *
 * @task T2936
 * @epic T2908
 *
 * Implements 4-layer validation gate system:
 * Layer 1: Schema Validation (JSON Schema compliance)
 * Layer 2: Semantic Validation (Business rules)
 * Layer 3: Referential Validation (Cross-entity integrity)
 * Layer 4: Protocol Validation (RCSD-IVTR lifecycle)
 *
 * Reference: docs/specs/MCP-SERVER-SPECIFICATION.md Section 7
 */

import { ExitCode, ErrorCategory, ErrorSeverity } from './exit-codes.js';
import { ProtocolEnforcer, ProtocolType } from './protocol-enforcement.js';
import { DomainRequest } from './router.js';
import {
  validateLayer1Schema,
  validateLayer2Semantic,
  validateLayer3Referential,
  validateLayer4Protocol,
} from './gate-validators.js';

/**
 * Gate layer enumeration
 */
export enum GateLayer {
  SCHEMA = 1,
  SEMANTIC = 2,
  REFERENTIAL = 3,
  PROTOCOL = 4,
}

/**
 * Gate status for each layer
 */
export enum GateStatus {
  PENDING = 'pending',
  PASSED = 'passed',
  FAILED = 'failed',
  BLOCKED = 'blocked',
  SKIPPED = 'skipped',
}

/**
 * Violation detail for a specific gate layer
 */
export interface GateViolation {
  layer: GateLayer;
  severity: ErrorSeverity;
  code: string;
  message: string;
  field?: string;
  value?: unknown;
  constraint?: string;
  fix?: string;
}

/**
 * Result from a single gate layer validation
 */
export interface LayerResult {
  layer: GateLayer;
  status: GateStatus;
  passed: boolean;
  violations: GateViolation[];
  duration_ms: number;
}

/**
 * Complete verification result across all 4 layers
 */
export interface VerificationResult {
  passed: boolean;
  layers: Record<GateLayer, LayerResult>;
  totalViolations: number;
  exitCode: ExitCode;
  category: ErrorCategory;
  summary: string;
  blockedAt?: GateLayer;
}

/**
 * Operation context for gate validation
 */
export interface OperationContext {
  domain: string;
  operation: string;
  gateway: 'cleo_query' | 'cleo_mutate';
  params?: Record<string, unknown>;
  taskId?: string;
  protocolType?: ProtocolType;
}

/**
 * Main Verification Gate class
 *
 * Orchestrates 4-layer validation and determines pass/fail status.
 * Each layer must pass before proceeding to the next.
 */
export class VerificationGate {
  private protocolEnforcer: ProtocolEnforcer;
  private strictMode: boolean;

  constructor(strictMode: boolean = true) {
    this.protocolEnforcer = new ProtocolEnforcer(strictMode);
    this.strictMode = strictMode;
  }

  /**
   * Execute all 4 gate layers sequentially
   *
   * Stops at first failure unless in advisory mode.
   */
  async verifyOperation(context: OperationContext): Promise<VerificationResult> {
    const startTime = Date.now();
    const layers: Record<GateLayer, LayerResult> = {} as Record<GateLayer, LayerResult>;

    // Layer 1: Schema Validation
    const schemaResult = await this.runLayer(
      GateLayer.SCHEMA,
      () => validateLayer1Schema(context)
    );
    layers[GateLayer.SCHEMA] = schemaResult;

    if (!schemaResult.passed && this.strictMode) {
      return this.buildFailureResult(layers, GateLayer.SCHEMA);
    }

    // Layer 2: Semantic Validation
    const semanticResult = await this.runLayer(
      GateLayer.SEMANTIC,
      () => validateLayer2Semantic(context)
    );
    layers[GateLayer.SEMANTIC] = semanticResult;

    if (!semanticResult.passed && this.strictMode) {
      return this.buildFailureResult(layers, GateLayer.SEMANTIC);
    }

    // Layer 3: Referential Validation
    const referentialResult = await this.runLayer(
      GateLayer.REFERENTIAL,
      () => validateLayer3Referential(context)
    );
    layers[GateLayer.REFERENTIAL] = referentialResult;

    if (!referentialResult.passed && this.strictMode) {
      return this.buildFailureResult(layers, GateLayer.REFERENTIAL);
    }

    // Layer 4: Protocol Validation
    const protocolResult = await this.runLayer(
      GateLayer.PROTOCOL,
      () => validateLayer4Protocol(context, this.protocolEnforcer)
    );
    layers[GateLayer.PROTOCOL] = protocolResult;

    if (!protocolResult.passed && this.strictMode) {
      return this.buildFailureResult(layers, GateLayer.PROTOCOL);
    }

    // All gates passed
    return this.buildSuccessResult(layers);
  }

  /**
   * Run a single validation layer with timing
   */
  private async runLayer(
    layer: GateLayer,
    validator: () => Promise<LayerResult>
  ): Promise<LayerResult> {
    const startTime = Date.now();

    try {
      const result = await validator();
      result.duration_ms = Date.now() - startTime;
      return result;
    } catch (error) {
      // Convert exceptions to layer failures
      return {
        layer,
        status: GateStatus.FAILED,
        passed: false,
        violations: [
          {
            layer,
            severity: ErrorSeverity.ERROR,
            code: 'E_VALIDATION_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        duration_ms: Date.now() - startTime,
      };
    }
  }

  /**
   * Build success result when all gates pass
   */
  private buildSuccessResult(layers: Record<GateLayer, LayerResult>): VerificationResult {
    return {
      passed: true,
      layers,
      totalViolations: 0,
      exitCode: ExitCode.SUCCESS,
      category: ErrorCategory.GENERAL,
      summary: 'All verification gates passed',
    };
  }

  /**
   * Build failure result when a gate fails
   */
  private buildFailureResult(
    layers: Record<GateLayer, LayerResult>,
    blockedAt: GateLayer
  ): VerificationResult {
    const failedLayer = layers[blockedAt];
    const totalViolations = Object.values(layers).reduce(
      (sum, layer) => sum + layer.violations.length,
      0
    );

    // Determine exit code based on layer and violation type
    let exitCode = ExitCode.E_VALIDATION_ERROR;
    let category = ErrorCategory.GENERAL;

    if (blockedAt === GateLayer.SCHEMA) {
      exitCode = ExitCode.E_VALIDATION_ERROR;
      category = ErrorCategory.GENERAL;
    } else if (blockedAt === GateLayer.SEMANTIC) {
      exitCode = this.determineSemanticExitCode(failedLayer.violations);
      category = ErrorCategory.HIERARCHY;
    } else if (blockedAt === GateLayer.REFERENTIAL) {
      exitCode = this.determineReferentialExitCode(failedLayer.violations);
      category = ErrorCategory.HIERARCHY;
    } else if (blockedAt === GateLayer.PROTOCOL) {
      exitCode = this.determineProtocolExitCode(failedLayer.violations);
      category = ErrorCategory.PROTOCOL;
    }

    return {
      passed: false,
      layers,
      totalViolations,
      exitCode,
      category,
      summary: `Verification failed at layer ${blockedAt}: ${failedLayer.violations[0]?.message || 'Unknown error'}`,
      blockedAt,
    };
  }

  /**
   * Determine semantic layer exit code from violations
   */
  private determineSemanticExitCode(violations: GateViolation[]): ExitCode {
    // Check for specific semantic errors
    for (const v of violations) {
      if (v.code.includes('PARENT')) return ExitCode.E_PARENT_NOT_FOUND;
      if (v.code.includes('DEPTH')) return ExitCode.E_DEPTH_EXCEEDED;
      if (v.code.includes('SIBLING')) return ExitCode.E_SIBLING_LIMIT;
      if (v.code.includes('CIRCULAR')) return ExitCode.E_CIRCULAR_REFERENCE;
      if (v.code.includes('SESSION')) return ExitCode.E_SESSION_REQUIRED;
    }
    return ExitCode.E_VALIDATION_ERROR;
  }

  /**
   * Determine referential layer exit code from violations
   */
  private determineReferentialExitCode(violations: GateViolation[]): ExitCode {
    for (const v of violations) {
      if (v.code.includes('NOT_FOUND')) return ExitCode.E_NOT_FOUND;
      if (v.code.includes('PARENT')) return ExitCode.E_PARENT_NOT_FOUND;
      if (v.code.includes('DEPENDENCY')) return ExitCode.E_DEPENDENCY_ERROR;
    }
    return ExitCode.E_NOT_FOUND;
  }

  /**
   * Determine protocol layer exit code from violations
   */
  private determineProtocolExitCode(violations: GateViolation[]): ExitCode {
    // Protocol violations map directly to 60-70 range
    for (const v of violations) {
      if (v.code.includes('RESEARCH')) return ExitCode.E_PROTOCOL_RESEARCH;
      if (v.code.includes('CONSENSUS')) return ExitCode.E_PROTOCOL_CONSENSUS;
      if (v.code.includes('SPECIFICATION')) return ExitCode.E_PROTOCOL_SPECIFICATION;
      if (v.code.includes('DECOMPOSITION')) return ExitCode.E_PROTOCOL_DECOMPOSITION;
      if (v.code.includes('IMPLEMENTATION')) return ExitCode.E_PROTOCOL_IMPLEMENTATION;
      if (v.code.includes('CONTRIBUTION')) return ExitCode.E_PROTOCOL_CONTRIBUTION;
      if (v.code.includes('RELEASE')) return ExitCode.E_PROTOCOL_RELEASE;
      if (v.code.includes('VALIDATION')) return ExitCode.E_PROTOCOL_VALIDATION;
      if (v.code.includes('TESTING')) return ExitCode.E_TESTS_SKIPPED;
      if (v.code.includes('LIFECYCLE')) return ExitCode.E_LIFECYCLE_GATE_FAILED;
    }
    return ExitCode.E_PROTOCOL_GENERIC;
  }

  /**
   * Check if an operation requires gate validation
   *
   * All mutate operations require validation.
   * Query operations skip validation for performance.
   */
  static requiresValidation(context: OperationContext): boolean {
    // All mutate operations require validation
    if (context.gateway === 'cleo_mutate') {
      return true;
    }

    // Query operations are read-only, skip validation
    return false;
  }

  /**
   * Get human-readable layer name
   */
  static getLayerName(layer: GateLayer): string {
    const names: Record<GateLayer, string> = {
      [GateLayer.SCHEMA]: 'Schema Validation',
      [GateLayer.SEMANTIC]: 'Semantic Validation',
      [GateLayer.REFERENTIAL]: 'Referential Validation',
      [GateLayer.PROTOCOL]: 'Protocol Validation',
    };
    return names[layer];
  }
}

/**
 * Factory function for creating verification gates
 */
export function createVerificationGate(strictMode: boolean = true): VerificationGate {
  return new VerificationGate(strictMode);
}

/**
 * Export gate layer sequence for external use
 */
export const GATE_SEQUENCE = [
  GateLayer.SCHEMA,
  GateLayer.SEMANTIC,
  GateLayer.REFERENTIAL,
  GateLayer.PROTOCOL,
] as const;

// ============================================================================
// Section 7: Workflow Verification Gates
// ============================================================================

/**
 * Workflow gate names per MCP-SERVER-SPECIFICATION.md Section 7.1
 *
 * Sequence: implemented → testsPassed → qaPassed → cleanupDone → securityPassed → documented
 *
 * @task T3141
 */
export enum WorkflowGateName {
  IMPLEMENTED = 'implemented',
  TESTS_PASSED = 'testsPassed',
  QA_PASSED = 'qaPassed',
  CLEANUP_DONE = 'cleanupDone',
  SECURITY_PASSED = 'securityPassed',
  DOCUMENTED = 'documented',
}

/**
 * Workflow gate status values per Section 7.3
 *
 * - null: Not yet attempted
 * - passed: Gate passed successfully
 * - failed: Gate failed (blocks downstream)
 * - blocked: Cannot attempt (dependencies not met)
 */
export type WorkflowGateStatus = null | 'passed' | 'failed' | 'blocked';

/**
 * Agent responsible for each gate per Section 7.2
 */
export type WorkflowGateAgent = 'coder' | 'testing' | 'qa' | 'cleanup' | 'security' | 'docs';

/**
 * Individual workflow gate definition per Section 7.2
 */
export interface WorkflowGateDefinition {
  name: WorkflowGateName;
  agent: WorkflowGateAgent;
  dependsOn: WorkflowGateName[];
  description: string;
}

/**
 * State of a single workflow gate
 */
export interface WorkflowGateState {
  name: WorkflowGateName;
  status: WorkflowGateStatus;
  agent: WorkflowGateAgent;
  updatedAt: string | null;
  failureReason?: string;
}

/**
 * Complete workflow gate definitions per Section 7.2
 */
export const WORKFLOW_GATE_DEFINITIONS: WorkflowGateDefinition[] = [
  {
    name: WorkflowGateName.IMPLEMENTED,
    agent: 'coder',
    dependsOn: [],
    description: 'Code implementation complete',
  },
  {
    name: WorkflowGateName.TESTS_PASSED,
    agent: 'testing',
    dependsOn: [WorkflowGateName.IMPLEMENTED],
    description: 'All tests passing',
  },
  {
    name: WorkflowGateName.QA_PASSED,
    agent: 'qa',
    dependsOn: [WorkflowGateName.TESTS_PASSED],
    description: 'QA review approved',
  },
  {
    name: WorkflowGateName.CLEANUP_DONE,
    agent: 'cleanup',
    dependsOn: [WorkflowGateName.QA_PASSED],
    description: 'Code cleanup finished',
  },
  {
    name: WorkflowGateName.SECURITY_PASSED,
    agent: 'security',
    dependsOn: [WorkflowGateName.CLEANUP_DONE],
    description: 'Security audit passed',
  },
  {
    name: WorkflowGateName.DOCUMENTED,
    agent: 'docs',
    dependsOn: [WorkflowGateName.SECURITY_PASSED],
    description: 'Documentation complete',
  },
];

/**
 * Ordered workflow gate sequence per Section 7.1
 */
export const WORKFLOW_GATE_SEQUENCE: WorkflowGateName[] = [
  WorkflowGateName.IMPLEMENTED,
  WorkflowGateName.TESTS_PASSED,
  WorkflowGateName.QA_PASSED,
  WorkflowGateName.CLEANUP_DONE,
  WorkflowGateName.SECURITY_PASSED,
  WorkflowGateName.DOCUMENTED,
];

/**
 * Map from gate name to definition for fast lookup
 */
const GATE_DEF_MAP: Record<WorkflowGateName, WorkflowGateDefinition> =
  Object.fromEntries(WORKFLOW_GATE_DEFINITIONS.map((d) => [d.name, d])) as Record<
    WorkflowGateName,
    WorkflowGateDefinition
  >;

/**
 * WorkflowGateTracker
 *
 * Tracks the status of all 6 workflow verification gates for a task.
 * Implements Section 7.4 failure cascade behavior: when a gate fails,
 * all downstream gates reset to null.
 *
 * @task T3141
 */
export class WorkflowGateTracker {
  private gates: Map<WorkflowGateName, WorkflowGateState>;

  constructor() {
    this.gates = new Map();
    for (const def of WORKFLOW_GATE_DEFINITIONS) {
      this.gates.set(def.name, {
        name: def.name,
        status: null,
        agent: def.agent,
        updatedAt: null,
      });
    }
  }

  /**
   * Get the status of a specific gate
   */
  getGateStatus(gateName: WorkflowGateName): WorkflowGateStatus {
    const gate = this.gates.get(gateName);
    return gate ? gate.status : null;
  }

  /**
   * Get the full state of a specific gate
   */
  getGateState(gateName: WorkflowGateName): WorkflowGateState | undefined {
    return this.gates.get(gateName);
  }

  /**
   * Get all gate states
   */
  getAllGates(): WorkflowGateState[] {
    return WORKFLOW_GATE_SEQUENCE.map((name) => this.gates.get(name)!);
  }

  /**
   * Check if a gate can be attempted (all dependencies passed)
   */
  canAttempt(gateName: WorkflowGateName): boolean {
    const def = GATE_DEF_MAP[gateName];
    if (!def) return false;

    for (const dep of def.dependsOn) {
      const depState = this.gates.get(dep);
      if (!depState || depState.status !== 'passed') {
        return false;
      }
    }
    return true;
  }

  /**
   * Mark a gate as passed.
   *
   * Returns false if the gate cannot be attempted (dependencies not met).
   */
  passGate(gateName: WorkflowGateName, agent?: string): boolean {
    if (!this.isValidGate(gateName)) return false;

    if (!this.canAttempt(gateName)) return false;

    const gate = this.gates.get(gateName)!;
    const expectedAgent = GATE_DEF_MAP[gateName].agent;
    if (agent && agent !== expectedAgent) return false;

    gate.status = 'passed';
    gate.updatedAt = new Date().toISOString();
    delete gate.failureReason;
    return true;
  }

  /**
   * Mark a gate as failed.
   *
   * Per Section 7.4: When a gate fails, all downstream gates reset to null.
   */
  failGate(gateName: WorkflowGateName, reason?: string): boolean {
    if (!this.isValidGate(gateName)) return false;

    const gate = this.gates.get(gateName)!;
    gate.status = 'failed';
    gate.updatedAt = new Date().toISOString();
    if (reason) gate.failureReason = reason;

    // Section 7.4 failure cascade: reset all downstream gates to null
    this.cascadeReset(gateName);

    return true;
  }

  /**
   * Reset a gate and all downstream gates to null.
   *
   * Used for failure cascade per Section 7.4.
   */
  private cascadeReset(failedGateName: WorkflowGateName): void {
    const failedIndex = WORKFLOW_GATE_SEQUENCE.indexOf(failedGateName);
    if (failedIndex === -1) return;

    // Reset all gates downstream of the failed gate
    for (let i = failedIndex + 1; i < WORKFLOW_GATE_SEQUENCE.length; i++) {
      const downstreamName = WORKFLOW_GATE_SEQUENCE[i];
      const downstreamGate = this.gates.get(downstreamName)!;
      downstreamGate.status = null;
      downstreamGate.updatedAt = null;
      delete downstreamGate.failureReason;
    }
  }

  /**
   * Update blocked status for all gates based on current state.
   *
   * A gate is blocked if it hasn't been attempted (null) and its
   * dependencies are not all passed.
   */
  updateBlockedStatus(): void {
    for (const name of WORKFLOW_GATE_SEQUENCE) {
      const gate = this.gates.get(name)!;
      // Only update gates that are null (not yet attempted)
      if (gate.status === null && !this.canAttempt(name)) {
        gate.status = 'blocked';
      }
      // If a gate was blocked but can now be attempted, reset to null
      if (gate.status === 'blocked' && this.canAttempt(name)) {
        gate.status = null;
      }
    }
  }

  /**
   * Check if all gates have passed
   */
  allPassed(): boolean {
    for (const name of WORKFLOW_GATE_SEQUENCE) {
      if (this.gates.get(name)!.status !== 'passed') return false;
    }
    return true;
  }

  /**
   * Get all gates that are currently blocked or have null status
   */
  getPendingGates(): WorkflowGateState[] {
    return this.getAllGates().filter(
      (g) => g.status === null || g.status === 'blocked'
    );
  }

  /**
   * Get the next gate that can be attempted
   */
  getNextAttemptable(): WorkflowGateName | null {
    for (const name of WORKFLOW_GATE_SEQUENCE) {
      const gate = this.gates.get(name)!;
      if (gate.status !== 'passed' && this.canAttempt(name)) {
        return name;
      }
    }
    return null;
  }

  /**
   * Get downstream gates of a given gate (not including the gate itself)
   */
  getDownstreamGates(gateName: WorkflowGateName): WorkflowGateName[] {
    const index = WORKFLOW_GATE_SEQUENCE.indexOf(gateName);
    if (index === -1) return [];
    return WORKFLOW_GATE_SEQUENCE.slice(index + 1);
  }

  /**
   * Serialize gate states to a plain record
   */
  toRecord(): Record<string, WorkflowGateStatus> {
    const record: Record<string, WorkflowGateStatus> = {};
    for (const name of WORKFLOW_GATE_SEQUENCE) {
      record[name] = this.gates.get(name)!.status;
    }
    return record;
  }

  /**
   * Restore gate states from a record
   */
  fromRecord(record: Record<string, WorkflowGateStatus>): void {
    for (const [name, status] of Object.entries(record)) {
      const gate = this.gates.get(name as WorkflowGateName);
      if (gate) {
        gate.status = status;
      }
    }
  }

  /**
   * Check if a gate name is valid
   */
  private isValidGate(gateName: WorkflowGateName): boolean {
    return this.gates.has(gateName);
  }
}

/**
 * Validate a workflow gate name string
 */
export function isValidWorkflowGateName(name: string): name is WorkflowGateName {
  return WORKFLOW_GATE_SEQUENCE.includes(name as WorkflowGateName);
}

/**
 * Get the definition for a workflow gate
 */
export function getWorkflowGateDefinition(
  name: WorkflowGateName
): WorkflowGateDefinition | undefined {
  return GATE_DEF_MAP[name];
}
