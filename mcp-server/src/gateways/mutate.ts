/**
 * cleo_mutate Gateway - Write Operations
 *
 * Handles all state-modifying operations with strict validation,
 * audit logging, and rollback support.
 *
 * Domains: tasks, session, orchestrate, research, lifecycle, validate, release, system
 * Total operations: 51
 *
 * @task T2929
 */

import { DomainRequest, DomainResponse } from '../lib/router.js';
import { createError } from '../lib/formatter.js';
import { logMutation, AuditEntry } from '../lib/audit.js';

/**
 * Mutate request interface
 */
export interface MutateRequest {
  domain: 'tasks' | 'session' | 'orchestrate' | 'research' | 'lifecycle' | 'validate' | 'release' | 'system' | 'issues';
  operation: string;
  params?: Record<string, unknown>;
}

/**
 * Mutate response interface (aliases DomainResponse)
 */
export type MutateResponse = DomainResponse;

/**
 * Mutate operation matrix - all write operations by domain
 * Reference: MCP-SERVER-SPECIFICATION.md Section 2.2.2
 */
export const MUTATE_OPERATIONS: Record<string, string[]> = {
  tasks: [
    'create',      // Create new task
    'update',      // Update task fields
    'complete',    // Mark task done
    'delete',      // Delete task
    'archive',     // Archive done tasks
    'unarchive',   // Restore from archive
    'reparent',    // Change task parent
    'promote',     // Promote subtask to task
    'reorder',     // Reorder siblings
    'reopen',      // Reopen completed task
    'relates.add', // Add task relationship
  ],
  session: [
    'start',       // Start new session
    'end',         // End current session
    'resume',      // Resume existing session
    'suspend',     // Suspend session
    'focus.set',   // Set focused task
    'focus.clear', // Clear focus
    'gc',          // Garbage collect sessions
  ],
  orchestrate: [
    'startup',         // Initialize orchestration
    'spawn',           // Generate spawn prompt
    'validate',        // Validate spawn readiness
    'parallel.start',  // Start parallel wave
    'parallel.end',    // End parallel wave
  ],
  research: [
    'inject',          // Get protocol injection
    'link',            // Link research to task
    'manifest.append', // Append manifest entry
    'manifest.archive', // Archive old entries
  ],
  lifecycle: [
    'progress',    // Record stage completion
    'skip',        // Skip optional stage
    'reset',       // Reset stage (emergency)
    'gate.pass',   // Mark gate as passed
    'gate.fail',   // Mark gate as failed
  ],
  validate: [
    'compliance.record', // Record compliance check
    'test.run',         // Execute test suite
  ],
  release: [
    'prepare',     // Prepare release
    'changelog',   // Generate changelog
    'commit',      // Create release commit
    'tag',         // Create git tag
    'push',        // Push to remote
    'gates.run',   // Run release gates
    'rollback',    // Rollback release
  ],
  system: [
    'init',        // Initialize CLEO
    'config.set',  // Set config value
    'backup',      // Create backup
    'restore',     // Restore from backup
    'migrate',     // Run migrations
    'sync',        // Sync with TodoWrite
    'cleanup',     // Cleanup stale data
    'job.cancel',  // Cancel background job
    'safestop',    // Graceful agent shutdown
    'uncancel',    // Restore cancelled tasks
  ],
  issues: [
    'create_bug',     // File a bug report
    'create_feature', // Request a feature
    'create_help',    // Ask a question
  ],
};

/**
 * Total operation count check
 */
const EXPECTED_MUTATE_COUNT = 54;
const actualMutateCount = Object.values(MUTATE_OPERATIONS).flat().length;
if (actualMutateCount !== EXPECTED_MUTATE_COUNT) {
  console.error(
    `Warning: Mutate operation count mismatch. Expected ${EXPECTED_MUTATE_COUNT}, got ${actualMutateCount}`
  );
}

/**
 * Idempotent operations that may return success for already-completed actions
 * These operations use exit codes 100+ to signal "already done" vs "just completed"
 */
const IDEMPOTENT_OPERATIONS: Record<string, string[]> = {
  tasks: ['complete', 'archive'],
  session: ['end', 'focus.clear', 'gc'],
  lifecycle: ['progress', 'skip', 'gate.pass'],
  validate: ['compliance.record'],
  release: ['tag', 'push'],
  system: ['init', 'migrate', 'cleanup'],
};

/**
 * Operations that require session binding
 */
const SESSION_REQUIRED_OPERATIONS: Record<string, string[]> = {
  tasks: ['create', 'update', 'complete'],
  session: ['start', 'focus.set'],
  orchestrate: ['startup', 'spawn'],
};

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
          gateway: 'cleo_mutate',
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
          gateway: 'cleo_mutate',
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
          message: `Operation '${operation}' not supported for cleo_mutate in domain '${domain}'`,
          fix: `Use one of: ${validOps.join(', ')}`,
          alternatives: validOps.map((op) => ({
            action: `Use ${op}`,
            command: `cleo_mutate ${domain} ${op}`,
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
  params?: Record<string, unknown>
): {
  valid: boolean;
  error?: DomainResponse;
} {
  // Domain-specific parameter validation
  switch (domain) {
    case 'tasks':
      return validateTasksParams(operation, params);
    case 'session':
      return validateSessionParams(operation, params);
    case 'orchestrate':
      return validateOrchestrateParams(operation, params);
    case 'research':
      return validateResearchParams(operation, params);
    case 'lifecycle':
      return validateLifecycleParams(operation, params);
    case 'validate':
      return validateValidateParams(operation, params);
    case 'release':
      return validateReleaseParams(operation, params);
    case 'system':
      return validateSystemParams(operation, params);
    default:
      return { valid: true };
  }
}

/**
 * Validate tasks domain parameters
 */
function validateTasksParams(
  operation: string,
  params?: Record<string, unknown>
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'create':
      if (!params?.title || !params?.description) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'cleo_mutate',
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
              gateway: 'cleo_mutate',
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
    case 'unarchive':
    case 'reparent':
    case 'promote':
    case 'reorder':
    case 'reopen':
      if (!params?.taskId) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'cleo_mutate',
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

    case 'relates.add':
      if (!params?.taskId || !params?.targetId || !params?.type || !params?.reason) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'cleo_mutate',
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
              message: 'Missing required parameters: taskId, targetId, type, and reason',
              fix: 'Provide taskId, targetId, type, and reason parameters',
            },
          },
        };
      }
      break;
  }

  return { valid: true };
}

/**
 * Validate session domain parameters
 */
function validateSessionParams(
  operation: string,
  params?: Record<string, unknown>
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'start':
      if (!params?.scope) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'cleo_mutate',
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
              gateway: 'cleo_mutate',
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

    case 'focus.set':
      if (!params?.taskId) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'cleo_mutate',
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
              message: 'Missing required parameter: taskId',
              fix: 'Provide taskId parameter',
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
  params?: Record<string, unknown>
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'startup':
      if (!params?.epicId) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'cleo_mutate',
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
              gateway: 'cleo_mutate',
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

    case 'parallel.start':
    case 'parallel.end':
      if (!params?.epicId || params?.wave === undefined) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'cleo_mutate',
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
 * Validate research domain parameters
 */
function validateResearchParams(
  operation: string,
  params?: Record<string, unknown>
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'inject':
      if (!params?.protocolType) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'cleo_mutate',
              domain: 'research',
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
              gateway: 'cleo_mutate',
              domain: 'research',
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
              gateway: 'cleo_mutate',
              domain: 'research',
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
 * Validate lifecycle domain parameters
 */
function validateLifecycleParams(
  operation: string,
  params?: Record<string, unknown>
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'progress':
      if (!params?.taskId || !params?.stage || !params?.status) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'cleo_mutate',
              domain: 'lifecycle',
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
              gateway: 'cleo_mutate',
              domain: 'lifecycle',
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
              gateway: 'cleo_mutate',
              domain: 'lifecycle',
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
 * Validate validate domain parameters
 */
function validateValidateParams(
  operation: string,
  params?: Record<string, unknown>
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'compliance.record':
      if (!params?.taskId || !params?.result) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'cleo_mutate',
              domain: 'validate',
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
 * Validate release domain parameters
 */
function validateReleaseParams(
  operation: string,
  params?: Record<string, unknown>
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'prepare':
    case 'changelog':
    case 'commit':
    case 'tag':
    case 'push':
    case 'rollback':
      if (!params?.version) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'cleo_mutate',
              domain: 'release',
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
              fix: 'Provide version parameter (semver format)',
            },
          },
        };
      }
      break;
  }

  return { valid: true };
}

/**
 * Validate system domain parameters
 */
function validateSystemParams(
  operation: string,
  params?: Record<string, unknown>
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'config.set':
      if (!params?.key || params?.value === undefined) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'cleo_mutate',
              domain: 'system',
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
              gateway: 'cleo_mutate',
              domain: 'system',
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
              gateway: 'cleo_mutate',
              domain: 'system',
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
              gateway: 'cleo_mutate',
              domain: 'system',
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

    case 'uncancel':
      if (!params?.taskId) {
        return {
          valid: false,
          error: {
            _meta: {
              gateway: 'cleo_mutate',
              domain: 'system',
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
              fix: 'Provide taskId parameter for the cancelled task to restore',
            },
          },
        };
      }
      break;
  }

  return { valid: true };
}

/**
 * Register cleo_mutate tool with MCP server
 *
 * Returns tool definition for ListToolsRequestSchema handler
 */
export function registerMutateTool() {
  return {
    name: 'cleo_mutate',
    description:
      'CLEO write operations: create, update, complete tasks; manage sessions; spawn agents; progress lifecycle; execute releases. Modifies state with validation.',
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
          description: 'Domain-specific write operation (see operation matrix)',
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
 * Handle cleo_mutate request
 *
 * Validates parameters, logs to audit trail, routes to domain handler,
 * and handles idempotency
 *
 * @param request Mutate request with domain, operation, and params
 * @returns Promise resolving to mutate response
 */
export async function handleMutateRequest(
  request: MutateRequest
): Promise<MutateResponse> {
  const startTime = Date.now();

  // Validate request parameters
  const validation = validateMutateParams(request);
  if (!validation.valid) {
    return validation.error!;
  }

  // Extract task ID from params if present
  const taskId = typeof request.params?.taskId === 'string' ? request.params.taskId : undefined;
  const sessionId = process.env.CLEO_SESSION_ID || null;

  // Log mutation attempt to audit trail
  const auditEntry: AuditEntry = {
    timestamp: new Date().toISOString(),
    sessionId,
    domain: request.domain,
    operation: request.operation,
    params: request.params || {},
    result: {
      success: false,
      exitCode: 0,
      duration: 0,
    },
    metadata: {
      taskId,
      source: 'mcp',
      gateway: 'cleo_mutate',
    },
  };

  try {
    // Build domain request (will be routed by DomainRouter)
    const domainRequest: DomainRequest = {
      gateway: 'cleo_mutate',
      domain: request.domain,
      operation: request.operation,
      params: request.params,
    };

    // Create response (this function is called by the router)
    const response: MutateResponse = {
      _meta: {
        gateway: 'cleo_mutate',
        domain: request.domain,
        operation: request.operation,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
      success: true,
      data: domainRequest,
    };

    // Update audit entry with success
    auditEntry.result.success = true;
    auditEntry.result.exitCode = 0;
    auditEntry.result.duration = Date.now() - startTime;

    // Log to audit trail (async, non-blocking)
    logMutation(auditEntry).catch((err) => {
      console.error('Failed to log mutation to audit trail:', err);
    });

    return response;
  } catch (error) {
    // Update audit entry with failure
    auditEntry.result.success = false;
    auditEntry.result.exitCode = 1; // TODO: Extract actual exit code from CLI response
    auditEntry.result.duration = Date.now() - startTime;
    auditEntry.error = error instanceof Error ? error.message : String(error);

    // Log to audit trail (async, non-blocking)
    logMutation(auditEntry).catch((err) => {
      console.error('Failed to log mutation error to audit trail:', err);
    });

    throw error;
  }
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
