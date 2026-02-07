/**
 * Protocol Enforcement Middleware for CLEO MCP Server
 *
 * @task T2918
 * @epic T2908
 *
 * Validates RCSD-IVTR lifecycle compliance with exit codes 60-70.
 * Intercepts domain operations to enforce protocol requirements before execution.
 *
 * Reference: lib/protocol-validation.sh, docs/specs/MCP-SERVER-SPECIFICATION.md
 */

import { ProtocolRule, ProtocolViolation, ProtocolValidationResult } from './protocol-rules.js';
import { PROTOCOL_RULES } from './protocol-rules.js';
import { DomainRequest, DomainResponse } from './router.js';
import { ExitCode } from './exit-codes.js';

/**
 * Protocol types aligned with RCSD-IVTR lifecycle
 */
export enum ProtocolType {
  RESEARCH = 'research',
  CONSENSUS = 'consensus',
  SPECIFICATION = 'specification',
  DECOMPOSITION = 'decomposition',
  IMPLEMENTATION = 'implementation',
  CONTRIBUTION = 'contribution',
  RELEASE = 'release',
  VALIDATION = 'validation',
  TESTING = 'testing',
}

/**
 * Exit code mapping for protocol violations
 */
const PROTOCOL_EXIT_CODES: Record<ProtocolType, ExitCode> = {
  [ProtocolType.RESEARCH]: ExitCode.E_PROTOCOL_RESEARCH,
  [ProtocolType.CONSENSUS]: ExitCode.E_PROTOCOL_CONSENSUS,
  [ProtocolType.SPECIFICATION]: ExitCode.E_PROTOCOL_SPECIFICATION,
  [ProtocolType.DECOMPOSITION]: ExitCode.E_PROTOCOL_DECOMPOSITION,
  [ProtocolType.IMPLEMENTATION]: ExitCode.E_PROTOCOL_IMPLEMENTATION,
  [ProtocolType.CONTRIBUTION]: ExitCode.E_PROTOCOL_CONTRIBUTION,
  [ProtocolType.RELEASE]: ExitCode.E_PROTOCOL_RELEASE,
  [ProtocolType.VALIDATION]: ExitCode.E_PROTOCOL_VALIDATION,
  [ProtocolType.TESTING]: ExitCode.E_TESTS_SKIPPED,
};

/**
 * Lifecycle stage dependencies
 */
const LIFECYCLE_GATES: Record<string, string[]> = {
  research: [],
  consensus: ['research'],
  specification: ['research', 'consensus'],
  decomposition: ['research', 'consensus', 'specification'],
  implementation: ['research', 'consensus', 'specification', 'decomposition'],
  contribution: [], // Cross-cutting: no strict prerequisites
  validation: ['implementation'],
  testing: ['implementation', 'validation'],
  release: ['implementation', 'validation', 'testing'],
};

/**
 * Violation log entry
 */
export interface ViolationLogEntry {
  timestamp: string;
  taskId?: string;
  protocol: ProtocolType;
  violations: ProtocolViolation[];
  score: number;
  blocked: boolean;
}

/**
 * Main protocol enforcement class
 */
export class ProtocolEnforcer {
  private violations: ViolationLogEntry[] = [];
  private strictMode: boolean;

  constructor(strictMode: boolean = true) {
    this.strictMode = strictMode;
  }

  /**
   * Validate protocol compliance for a manifest entry
   */
  async validateProtocol(
    protocol: ProtocolType,
    manifestEntry: Record<string, unknown>,
    additionalData?: Record<string, unknown>
  ): Promise<ProtocolValidationResult> {
    const rules = PROTOCOL_RULES[protocol];
    if (!rules) {
      return {
        valid: false,
        violations: [
          {
            requirement: 'UNKNOWN',
            severity: 'error',
            message: `Unknown protocol type: ${protocol}`,
            fix: 'Use valid protocol type',
          },
        ],
        score: 0,
      };
    }

    const violations: ProtocolViolation[] = [];
    let score = 100;

    // Validate each rule
    for (const rule of rules) {
      const violation = await this.validateRule(rule, manifestEntry, additionalData);
      if (violation) {
        violations.push(violation);
        score -= this.calculatePenalty(violation.severity);
      }
    }

    return {
      valid: violations.filter((v) => v.severity === 'error').length === 0,
      violations,
      score,
    };
  }

  /**
   * Validate a single rule
   */
  private async validateRule(
    rule: ProtocolRule,
    manifestEntry: Record<string, unknown>,
    additionalData?: Record<string, unknown>
  ): Promise<ProtocolViolation | null> {
    try {
      const isValid = await rule.validate(manifestEntry, additionalData);
      if (!isValid) {
        return {
          requirement: rule.id,
          severity: rule.level === 'MUST' ? 'error' : 'warning',
          message: rule.message,
          fix: rule.fix,
        };
      }
      return null;
    } catch (error) {
      return {
        requirement: rule.id,
        severity: 'error',
        message: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
        fix: rule.fix,
      };
    }
  }

  /**
   * Check lifecycle gate prerequisites
   */
  async checkLifecycleGate(
    taskId: string,
    targetStage: string,
    rcsdManifest?: Record<string, unknown>
  ): Promise<{
    passed: boolean;
    missingPrerequisites: string[];
    message: string;
  }> {
    const prerequisites = LIFECYCLE_GATES[targetStage] || [];

    if (!rcsdManifest) {
      // No manifest available - warn but allow
      return {
        passed: true,
        missingPrerequisites: [],
        message: 'No RCSD manifest found - skipping gate check',
      };
    }

    const missingPrerequisites: string[] = [];

    for (const prereq of prerequisites) {
      const stageStatus = rcsdManifest[prereq];
      if (stageStatus !== 'completed' && stageStatus !== 'skipped') {
        missingPrerequisites.push(prereq);
      }
    }

    if (missingPrerequisites.length > 0) {
      return {
        passed: false,
        missingPrerequisites,
        message: `Lifecycle gate failed: missing prerequisites [${missingPrerequisites.join(', ')}]`,
      };
    }

    return {
      passed: true,
      missingPrerequisites: [],
      message: 'All prerequisites met',
    };
  }

  /**
   * Record a protocol violation
   */
  recordViolation(
    protocol: ProtocolType,
    violations: ProtocolViolation[],
    score: number,
    taskId?: string
  ): void {
    const entry: ViolationLogEntry = {
      timestamp: new Date().toISOString(),
      taskId,
      protocol,
      violations,
      score,
      blocked: this.strictMode && violations.some((v) => v.severity === 'error'),
    };

    this.violations.push(entry);

    // Keep last 1000 violations
    if (this.violations.length > 1000) {
      this.violations.shift();
    }
  }

  /**
   * Get recent violations
   */
  getViolations(limit?: number): ViolationLogEntry[] {
    return limit ? this.violations.slice(-limit) : this.violations;
  }

  /**
   * Calculate penalty for violation severity
   */
  private calculatePenalty(severity: 'error' | 'warning'): number {
    return severity === 'error' ? 20 : 5;
  }

  /**
   * Middleware function for domain router
   *
   * Intercepts operations and validates protocol compliance before execution.
   */
  async enforceProtocol(
    request: DomainRequest,
    next: () => Promise<DomainResponse>
  ): Promise<DomainResponse> {
    // Only enforce on mutate operations that may create outputs
    if (request.gateway !== 'cleo_mutate') {
      return next();
    }

    // Check if operation requires protocol validation
    const requiresValidation = this.requiresProtocolValidation(request);
    if (!requiresValidation) {
      return next();
    }

    // Execute the operation
    const response = await next();

    // Skip validation if operation failed
    if (!response.success) {
      return response;
    }

    // Extract protocol type from request/response
    const protocol = this.detectProtocol(request, response);
    if (!protocol) {
      return response;
    }

    // Validate protocol compliance
    const manifestEntry = this.extractManifestEntry(response);
    if (!manifestEntry) {
      return response; // No manifest to validate
    }

    const result = await this.validateProtocol(protocol, manifestEntry, request.params);

    // Record violation
    const taskId = request.params?.taskId as string | undefined;
    this.recordViolation(protocol, result.violations, result.score, taskId);

    // If strict mode and errors found, block the operation
    if (this.strictMode && !result.valid) {
      return {
        _meta: response._meta,
        success: false,
        error: {
          code: `E_PROTOCOL_${protocol.toUpperCase()}`,
          exitCode: PROTOCOL_EXIT_CODES[protocol],
          message: `Protocol violation: ${protocol}`,
          details: {
            violations: result.violations,
            score: result.score,
          },
          fix: result.violations[0]?.fix || 'Fix protocol violations',
          alternatives: result.violations.map((v) => ({
            action: v.requirement,
            command: v.fix,
          })),
        },
      };
    }

    return response;
  }

  /**
   * Determine if operation requires protocol validation
   */
  private requiresProtocolValidation(request: DomainRequest): boolean {
    // Operations that create outputs requiring validation
    const validatedOperations = [
      'research.inject',
      'research.manifest.append',
      'orchestrate.spawn',
      'tasks.complete',
      'release.prepare',
      'release.commit',
      'validate.compliance.record',
    ];

    const key = `${request.domain}.${request.operation}`;
    return validatedOperations.includes(key);
  }

  /**
   * Detect protocol type from request/response
   */
  private detectProtocol(request: DomainRequest, response: DomainResponse): ProtocolType | null {
    // Check params for explicit protocol
    if (request.params?.protocolType) {
      return request.params.protocolType as ProtocolType;
    }

    // Infer from domain
    const domainProtocolMap: Record<string, ProtocolType> = {
      research: ProtocolType.RESEARCH,
      orchestrate: ProtocolType.DECOMPOSITION,
      release: ProtocolType.RELEASE,
      validate: ProtocolType.VALIDATION,
      testing: ProtocolType.TESTING,
      contribution: ProtocolType.CONTRIBUTION,
    };

    // Infer from operation name
    if (request.operation) {
      const opProtocolMap: Record<string, ProtocolType> = {
        'consensus.record': ProtocolType.CONSENSUS,
        'specification.validate': ProtocolType.SPECIFICATION,
        'implementation.complete': ProtocolType.IMPLEMENTATION,
        'contribution.merge': ProtocolType.CONTRIBUTION,
      };
      const opKey = `${request.domain}.${request.operation}`;
      if (opProtocolMap[opKey]) {
        return opProtocolMap[opKey];
      }
    }

    return domainProtocolMap[request.domain] || null;
  }

  /**
   * Extract manifest entry from response
   */
  private extractManifestEntry(response: DomainResponse): Record<string, unknown> | null {
    const data = response.data as Record<string, unknown> | undefined;
    if (!data) {
      return null;
    }

    // Check for manifest entry in response
    if (data.manifestEntry) {
      return data.manifestEntry as Record<string, unknown>;
    }

    // Check for entry field
    if (data.entry) {
      return data.entry as Record<string, unknown>;
    }

    return null;
  }

  /**
   * Set strict mode
   */
  setStrictMode(strict: boolean): void {
    this.strictMode = strict;
  }

  /**
   * Get strict mode status
   */
  isStrictMode(): boolean {
    return this.strictMode;
  }
}

/**
 * Default protocol enforcer instance
 */
export const protocolEnforcer = new ProtocolEnforcer();
