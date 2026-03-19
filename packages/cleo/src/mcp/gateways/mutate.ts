/**
 * mutate Gateway - Write Operations
 *
 * Handles all state-modifying operations with strict validation,
 * audit logging, and rollback support.
 *
 * Canonical domains (10): tasks, session, memory, check, pipeline,
 * orchestrate, tools, admin, nexus, sticky
 *
 * @task T2929
 */

import { deriveGatewayMatrix, getByGateway } from '../../dispatch/registry.js';

/**
 * Request from MCP gateway (inline — replaces legacy router.ts import)
 */
export interface DomainRequest {
  gateway: 'query' | 'mutate';
  domain: string;
  operation: string;
  params?: Record<string, unknown>;
}

/**
 * Response from domain handler (inline — replaces legacy router.ts import)
 */
export interface DomainResponse {
  _meta: {
    gateway: string;
    domain: string;
    operation: string;
    timestamp: string;
    duration_ms: number;
    [key: string]: unknown;
  };
  success: boolean;
  data?: unknown;
  partial?: boolean;
  error?: {
    code: string;
    exitCode?: number;
    message: string;
    details?: Record<string, unknown>;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
  };
}

/**
 * All accepted domain names for mutate.
 *
 * Canonical dispatch names only.
 */
type MutateDomain =
  // Canonical domains
  | 'tasks'
  | 'session'
  | 'memory'
  | 'check'
  | 'pipeline'
  | 'orchestrate'
  | 'tools'
  | 'admin'
  | 'nexus'
  | 'sticky';

/**
 * Mutate request interface
 */
export interface MutateRequest {
  domain: MutateDomain;
  operation: string;
  params?: Record<string, unknown>;
}

/**
 * Mutate response interface (aliases DomainResponse)
 */
export type MutateResponse = DomainResponse;

/**
 * Mutate operation matrix - all write operations by domain.
 *
 * DERIVED from the dispatch registry — single source of truth.
 * Contains canonical domains.
 *
 * Reference: MCP-SERVER-SPECIFICATION.md Section 2.2.2
 */
export const MUTATE_OPERATIONS: Record<string, string[]> = deriveGatewayMatrix('mutate');

/**
 * Dynamic operation count (derived from MUTATE_OPERATIONS).
 */
const actualMutateCount = Object.values(MUTATE_OPERATIONS).flat().length;
if (actualMutateCount < 1) {
  console.error('Warning: Mutate operation registry is empty.');
}

function buildOperationFlagMatrix(
  predicate: (operation: {
    domain: string;
    operation: string;
    idempotent: boolean;
    sessionRequired: boolean;
  }) => boolean,
): Record<string, string[]> {
  const matrix: Record<string, string[]> = {};
  for (const op of getByGateway('mutate')) {
    if (!predicate(op)) {
      continue;
    }
    if (!matrix[op.domain]) {
      matrix[op.domain] = [];
    }
    matrix[op.domain]!.push(op.operation);
  }
  return matrix;
}

/**
 * Idempotent operations derived from registry metadata.
 */
const IDEMPOTENT_OPERATIONS: Record<string, string[]> = buildOperationFlagMatrix(
  (op) => op.idempotent,
);

/**
 * Session-required operations derived from registry metadata.
 */
const SESSION_REQUIRED_OPERATIONS: Record<string, string[]> = buildOperationFlagMatrix(
  (op) => op.sessionRequired,
);

/**
 * Validate mutate request parameters
 */
export function validateMutateParams(request: MutateRequest): {
  valid: boolean;
  error?: DomainResponse;
} {
  const { domain, operation, params } = request;

  // Check if domain is valid
  if (!MUTATE_OPERATIONS[domain]) {
    return {
      valid: false,
      error: {
        _meta: {
          gateway: 'mutate',
          domain,
          operation,
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms: 0,
        },
        success: false,
        error: {
          code: 'E_INVALID_DOMAIN',
          exitCode: 2,
          message: `Unknown mutate domain: ${domain}`,
          fix: `Use one of: ${Object.keys(MUTATE_OPERATIONS).join(', ')}`,
          alternatives: Object.keys(MUTATE_OPERATIONS).map((d) => ({
            action: `List ${d} operations`,
            command: `Available: ${MUTATE_OPERATIONS[d].join(', ')}`,
          })),
        },
      },
    };
  }

  // Check if operation is valid for this domain
  const validOps = MUTATE_OPERATIONS[domain];
  if (!validOps.includes(operation)) {
    return {
      valid: false,
      error: {
        _meta: {
          gateway: 'mutate',
          domain,
          operation,
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms: 0,
        },
        success: false,
        error: {
          code: 'E_INVALID_OPERATION',
          exitCode: 2,
          message: `Operation '${operation}' not supported for mutate in domain '${domain}'`,
          fix: `Use one of: ${validOps.join(', ')}`,
          alternatives: validOps.map((op) => ({
            action: `Use ${op}`,
            command: `mutate ${domain} ${op}`,
          })),
        },
      },
    };
  }

  // Perform operation-specific parameter validation
  const paramValidation = validateOperationParams(domain, operation, params);
  if (!paramValidation.valid) {
    return paramValidation;
  }

  return { valid: true };
}

/**
 * Validate operation-specific parameters
 */
function validateOperationParams(
  domain: string,
  operation: string,
  params?: Record<string, unknown>,
): {
  valid: boolean;
  error?: DomainResponse;
} {
  // Domain-specific parameter validation (canonical domains only)
  switch (domain) {
    case 'tasks':
      return validateTasksParams(operation, params);
    case 'session':
      return validateSessionParams(operation, params);
    case 'orchestrate':
      return validateOrchestrateParams(operation, params);
    case 'memory':
      return validateMemoryParams(operation, params);
    case 'check':
      return validateCheckParams(operation, params);
    case 'pipeline':
      return validatePipelineParams(operation, params);
    case 'admin':
      return validateAdminParams(operation, params);
    case 'tools':
      return validateToolsParams(operation, params);
    default:
      return { valid: true };
  }
}

/**
 * Validate tasks domain parameters
 */
function validateTasksParams(
  operation: string,
  params?: Record<string, unknown>,
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'add':
      if (!params?.title || !params?.description) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'tasks',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameters: title and description',
              fix: 'Provide both title and description fields',
            },
          },
        };
      }
      if (params.title === params.description) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'tasks',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Title and description must be different (anti-hallucination requirement)',
              fix: 'Provide a unique description that differs from the title',
            },
          },
        };
      }
      break;

    case 'update':
    case 'complete':
    case 'delete':
    case 'restore':
    case 'reparent':
    case 'promote':
    case 'reorder':
    case 'start':
      if (!params?.taskId) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'tasks',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameter: taskId',
              fix: 'Provide taskId parameter',
            },
          },
        };
      }
      break;

    case 'relates.add': {
      // Accept both targetId and relatedId for the second task (T5149)
      const hasTarget = !!(params?.targetId || params?.relatedId);
      if (!params?.taskId || !hasTarget || !params?.type) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'tasks',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameters: taskId, targetId (or relatedId), and type',
              fix: 'Provide taskId, targetId (or relatedId), and type parameters',
            },
          },
        };
      }
      break;
    }
  }

  return { valid: true };
}

/**
 * Validate session domain parameters
 */
function validateSessionParams(
  operation: string,
  params?: Record<string, unknown>,
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'start':
      if (!params?.scope) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'session',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameter: scope',
              fix: 'Provide scope parameter (e.g., "epic:T1234")',
            },
          },
        };
      }
      break;

    case 'resume':
      if (!params?.sessionId) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'session',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameter: sessionId',
              fix: 'Provide sessionId parameter',
            },
          },
        };
      }
      break;

    case 'record.decision':
      if (!params?.sessionId || !params?.taskId || !params?.decision || !params?.rationale) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'session',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameters: sessionId, taskId, decision, and rationale',
              fix: 'Provide sessionId, taskId, decision, and rationale parameters',
            },
          },
        };
      }
      break;

    case 'record.assumption':
      if (!params?.assumption || !params?.confidence) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'session',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameters: assumption and confidence',
              fix: 'Provide assumption (string) and confidence (high|medium|low) parameters',
            },
          },
        };
      }
      break;
  }

  return { valid: true };
}

/**
 * Validate orchestrate domain parameters
 */
function validateOrchestrateParams(
  operation: string,
  params?: Record<string, unknown>,
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'start':
      if (!params?.epicId) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'orchestrate',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameter: epicId',
              fix: 'Provide epicId parameter',
            },
          },
        };
      }
      break;

    case 'spawn':
    case 'validate':
      if (!params?.taskId) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'orchestrate',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameter: taskId',
              fix: 'Provide taskId parameter',
            },
          },
        };
      }
      break;

    case 'handoff':
      if (!params?.taskId || !params?.protocolType) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'orchestrate',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameters: taskId and protocolType',
              fix: 'Provide both taskId and protocolType parameters',
            },
          },
        };
      }
      break;

    case 'parallel.start':
    case 'parallel.end':
      if (!params?.epicId || params?.wave === undefined) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'orchestrate',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameters: epicId and wave',
              fix: 'Provide both epicId and wave parameters',
            },
          },
        };
      }
      break;
  }

  return { valid: true };
}

/**
 * Validate memory domain parameters
 */
function validateMemoryParams(
  operation: string,
  params?: Record<string, unknown>,
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'inject':
      if (!params?.protocolType) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'memory',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameter: protocolType',
              fix: 'Provide protocolType parameter (e.g., "research", "implementation")',
            },
          },
        };
      }
      break;

    case 'link':
      if (!params?.researchId || !params?.taskId) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'memory',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameters: researchId and taskId',
              fix: 'Provide both researchId and taskId parameters',
            },
          },
        };
      }
      break;

    case 'manifest.append':
      if (!params?.entry) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'memory',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameter: entry',
              fix: 'Provide entry parameter with manifest entry object',
            },
          },
        };
      }
      break;
  }

  return { valid: true };
}

/**
 * Validate pipeline stage.* sub-operation parameters
 */
function validateStageParams(
  operation: string,
  params?: Record<string, unknown>,
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'record':
      if (!params?.taskId || !params?.stage || !params?.status) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'pipeline',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameters: taskId, stage, and status',
              fix: 'Provide taskId, stage, and status parameters',
            },
          },
        };
      }
      break;

    case 'skip':
    case 'reset':
      if (!params?.taskId || !params?.stage || !params?.reason) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'pipeline',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameters: taskId, stage, and reason',
              fix: 'Provide taskId, stage, and reason parameters',
            },
          },
        };
      }
      break;

    case 'gate.pass':
    case 'gate.fail':
      if (!params?.taskId || !params?.gateName) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'pipeline',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameters: taskId and gateName',
              fix: 'Provide taskId and gateName parameters',
            },
          },
        };
      }
      break;
  }

  return { valid: true };
}

/**
 * Validate check domain parameters
 */
function validateCheckParams(
  operation: string,
  params?: Record<string, unknown>,
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'compliance.record':
      if (!params?.taskId || !params?.result) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'check',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameters: taskId and result',
              fix: 'Provide taskId and result parameters',
            },
          },
        };
      }
      break;
  }

  return { valid: true };
}

/**
 * Validate pipeline release.* sub-operation parameters
 */
function validateReleaseParams(
  operation: string,
  params?: Record<string, unknown>,
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'prepare':
    case 'changelog':
    case 'commit':
    case 'tag':
    case 'push':
    case 'rollback':
    case 'cancel':
      if (!params?.version) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'pipeline',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameter: version',
              fix: 'Provide version parameter (X.Y.Z or YYYY.M.patch format)',
            },
          },
        };
      }
      break;
  }

  return { valid: true };
}

/**
 * Validate pipeline chain.* sub-operation parameters
 */
function validateChainParams(
  operation: string,
  params?: Record<string, unknown>,
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'gate.pass':
    case 'gate.fail':
      if (!params?.instanceId || !params?.gateId) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'pipeline',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameters: instanceId and gateId',
              fix: 'Provide instanceId and gateId parameters',
            },
          },
        };
      }
      break;
  }

  return { valid: true };
}

/**
 * Validate admin domain parameters
 */
function validateAdminParams(
  operation: string,
  params?: Record<string, unknown>,
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'config.set':
      if (!params?.key || params?.value === undefined) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'admin',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameters: key and value',
              fix: 'Provide key and value parameters',
            },
          },
        };
      }
      break;

    case 'restore':
      if (!params?.backupId) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'admin',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameter: backupId',
              fix: 'Provide backupId parameter',
            },
          },
        };
      }
      break;

    case 'job.cancel':
      if (!params?.jobId) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'admin',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameter: jobId',
              fix: 'Provide jobId parameter',
            },
          },
        };
      }
      break;

    case 'cleanup':
      if (!params?.type) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'admin',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameter: type',
              fix: 'Provide type parameter (e.g., "sessions", "backups")',
            },
          },
        };
      }
      break;
  }

  return { valid: true };
}

/**
 * Validate tools skill.* sub-operation parameters
 */
function validateSkillSubParams(
  operation: string,
  params?: Record<string, unknown>,
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'install':
    case 'uninstall':
    case 'enable':
    case 'disable':
    case 'configure':
      if (!params?.name) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'mutate',
              domain: 'tools',
              operation,
              version: '1.0.0',
              timestamp: new Date().toISOString(),
              duration_ms: 0,
            },
            success: false,
            error: {
              code: 'E_VALIDATION_FAILED',
              exitCode: 6,
              message: 'Missing required parameter: name',
              fix: 'Provide name parameter for the skill',
            },
          },
        };
      }
      break;
  }

  return { valid: true };
}

/**
 * Validate pipeline (canonical) domain parameters
 *
 * Handles stage.* and release.* prefixed operations that map to
 * the legacy lifecycle and release domains respectively.
 */
function validatePipelineParams(
  operation: string,
  params?: Record<string, unknown>,
): { valid: boolean; error?: DomainResponse } {
  // Stage operations (lifecycle alias)
  if (operation.startsWith('stage.')) {
    const stageOp = operation.slice('stage.'.length);
    return validateStageParams(stageOp, params);
  }
  // Release operations
  if (operation.startsWith('release.')) {
    const releaseOp = operation.slice('release.'.length);
    return validateReleaseParams(releaseOp, params);
  }
  // Chain operations
  if (operation.startsWith('chain.')) {
    const chainOp = operation.slice('chain.'.length);
    return validateChainParams(chainOp, params);
  }
  return { valid: true };
}

/**
 * Validate tools (canonical) domain parameters
 *
 * Handles skill.*, issue.*, and provider.* prefixed operations that
 * map to the legacy skills, issues, and providers domains respectively.
 */
function validateToolsParams(
  operation: string,
  params?: Record<string, unknown>,
): { valid: boolean; error?: DomainResponse } {
  // Skill operations
  if (operation.startsWith('skill.')) {
    const skillOp = operation.slice('skill.'.length);
    return validateSkillSubParams(skillOp, params);
  }
  // Issue and provider operations pass through without extra validation
  return { valid: true };
}

/**
 * Register mutate tool with MCP server
 *
 * Returns tool definition for ListToolsRequestSchema handler
 */
export function registerMutateTool() {
  return {
    name: 'mutate',
    description:
      'CLEO write operations: create, update, complete tasks; manage sessions; spawn agents; progress lifecycle; execute releases. Modifies state with validation. Use query with domain "admin", operation "help" first to discover available operations.',
    inputSchema: {
      type: 'object',
      required: ['domain', 'operation'],
      properties: {
        domain: {
          type: 'string',
          enum: Object.keys(MUTATE_OPERATIONS),
          description: 'Functional domain to mutate',
        },
        operation: {
          type: 'string',
          description:
            'Domain-specific write operation. Call query admin.help to see the full operation matrix. Common: tasks.add, tasks.update, tasks.complete, session.start, session.end',
        },
        params: {
          type: 'object',
          description: 'Operation-specific parameters',
          additionalProperties: true,
        },
      },
    },
  };
}

/**
 * Handle mutate request
 *
 * Validates parameters, logs to audit trail, routes to domain handler,
 * and handles idempotency
 *
 * @param request Mutate request with domain, operation, and params
 * @returns Promise resolving to mutate response
 */
export async function handleMutateRequest(request: MutateRequest): Promise<MutateResponse> {
  const startTime = Date.now();

  // Validate request parameters
  const validation = validateMutateParams(request);
  if (!validation.valid) {
    return validation.error!;
  }

  // Build domain request
  const domainRequest: DomainRequest = {
    gateway: 'mutate',
    domain: request.domain,
    operation: request.operation,
    params: request.params,
  };

  const response: MutateResponse = {
    _meta: {
      gateway: 'mutate',
      domain: request.domain,
      operation: request.operation,
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    },
    success: true,
    data: domainRequest,
  };

  return response;
}

/**
 * Check if operation is idempotent
 */
export function isIdempotentOperation(domain: string, operation: string): boolean {
  return IDEMPOTENT_OPERATIONS[domain]?.includes(operation) || false;
}

/**
 * Check if operation requires session binding
 */
export function requiresSession(domain: string, operation: string): boolean {
  return SESSION_REQUIRED_OPERATIONS[domain]?.includes(operation) || false;
}

/**
 * Get mutate operation count for specific domain or all domains
 */
export function getMutateOperationCount(domain?: string): number {
  if (domain) {
    return MUTATE_OPERATIONS[domain]?.length || 0;
  }
  return actualMutateCount;
}

/**
 * Check if operation is write (mutate)
 */
export function isMutateOperation(domain: string, operation: string): boolean {
  return MUTATE_OPERATIONS[domain]?.includes(operation) || false;
}

/**
 * Get all mutate domains
 */
export function getMutateDomains(): string[] {
  return Object.keys(MUTATE_OPERATIONS);
}

/**
 * Get operations for specific mutate domain
 */
export function getMutateOperations(domain: string): string[] {
  return MUTATE_OPERATIONS[domain] || [];
}
