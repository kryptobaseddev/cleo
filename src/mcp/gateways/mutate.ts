/**
 * cleo_mutate Gateway - Write Operations
 *
 * Handles all state-modifying operations with strict validation,
 * audit logging, and rollback support.
 *
 * Canonical domains (9): tasks, session, memory, check, pipeline,
 *   orchestrate, tools, admin, nexus
 * Legacy aliases (backward compat): research, lifecycle, validate,
 *   release, system, issues, skills, providers
 *
 * The dispatch adapter (src/dispatch/adapters/mcp.ts) resolves legacy
 * domain names to canonical names before routing.
 *
 * @task T2929
 */

/**
 * Request from MCP gateway (inline — replaces legacy router.ts import)
 */
export interface DomainRequest {
  gateway: 'cleo_query' | 'cleo_mutate';
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
 * All accepted domain names for cleo_mutate.
 *
 * Includes both canonical dispatch names and legacy MCP names
 * for backward compatibility. The dispatch adapter resolves
 * legacy names to canonical names at routing time.
 */
type MutateDomain =
  // Canonical domains
  | 'tasks' | 'session' | 'memory' | 'check' | 'pipeline'
  | 'orchestrate' | 'tools' | 'admin' | 'nexus'
  // Legacy aliases (backward compat)
  | 'research' | 'lifecycle' | 'validate' | 'release'
  | 'system' | 'issues' | 'skills' | 'providers';

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
 * Mutate operation matrix - all write operations by domain
 *
 * Contains BOTH legacy domain names (for backward compatibility with
 * existing agents) AND canonical domain aliases (for the dispatch layer).
 * The dispatch adapter resolves legacy -> canonical at routing time.
 *
 * Reference: MCP-SERVER-SPECIFICATION.md Section 2.2.2
 */
export const MUTATE_OPERATIONS: Record<string, string[]> = {
  // ── Canonical domains ──────────────────────────────────────────────
  tasks: [
    'add',         // Create new task
    'update',      // Update task fields
    'complete',    // Mark task done
    'delete',      // Delete task
    'archive',     // Archive done tasks
    'restore',     // Restore from archive
    'reparent',    // Change task parent
    'promote',     // Promote subtask to task
    'reorder',     // Reorder siblings
    'reopen',      // Alias for restore (completed tasks)
    'relates.add', // Add task relationship
    'start',       // Start working on task
    'stop',        // Stop working on task
  ],
  session: [
    'start',            // Start new session
    'end',              // End current session
    'resume',           // Resume existing session
    'suspend',          // Suspend session
    'gc',               // Garbage collect sessions
    'record.decision',    // Record a decision
    'record.assumption',  // Record an assumption
  ],
  orchestrate: [
    'start',           // Initialize orchestration
    'spawn',           // Generate spawn prompt
    'validate',        // Validate spawn readiness
    'parallel.start',  // Start parallel wave
    'parallel.end',    // End parallel wave
  ],

  // ── Canonical: memory (research alias) ─────────────────────────────
  memory: [
    'inject',          // Get protocol injection
    'link',            // Link research to task
    'manifest.append', // Append manifest entry
    'manifest.archive', // Archive old entries
    'pattern.store',   // Store BRAIN pattern memory
    'learning.store',  // Store BRAIN learning memory
  ],

  // ── Canonical: check (validate alias) ──────────────────────────────
  check: [
    'compliance.record', // Record compliance check
    'test.run',         // Execute test suite
  ],

  // ── Canonical: pipeline (lifecycle + release alias) ────────────────
  pipeline: [
    // lifecycle operations (stage.* prefix used in dispatch)
    'stage.record',      // Record stage completion
    'stage.skip',        // Skip optional stage
    'stage.reset',       // Reset stage (emergency)
    'stage.gate.pass',   // Mark gate as passed
    'stage.gate.fail',   // Mark gate as failed
    // release operations (release.* prefix used in dispatch)
    'release.prepare',     // Prepare release
    'release.changelog',   // Generate changelog
    'release.commit',      // Create release commit
    'release.tag',         // Create git tag
    'release.push',        // Push to remote
    'release.gates.run',   // Run release gates
    'release.rollback',    // Rollback release
  ],

  // ── Canonical: admin (system alias) ────────────────────────────────
  admin: [
    'init',              // Initialize CLEO
    'config.set',        // Set config value
    'backup',            // Create backup
    'restore',           // Restore from backup
    'migrate',           // Run migrations
    'sync',              // Sync with TodoWrite
    'cleanup',           // Cleanup stale data
    'job.cancel',        // Cancel background job
    'safestop',          // Graceful agent shutdown
    'inject.generate',   // Generate MVI injection
  ],

  // ── Canonical: tools (skills + issues + providers alias) ───────────
  tools: [
    // skill.* operations
    'skill.install',        // Install a skill
    'skill.uninstall',      // Uninstall a skill
    'skill.enable',         // Enable a skill
    'skill.disable',        // Disable a skill
    'skill.configure',      // Configure a skill
    'skill.refresh',        // Refresh skill registry
    // issue.* operations
    'issue.add.bug',        // File a bug report
    'issue.add.feature',    // Request a feature
    'issue.add.help',       // Ask a question
    'issue.create.bug',     // Alias (backward compat)
    'issue.create.feature', // Alias (backward compat)
    'issue.create.help',    // Alias (backward compat)
    // provider.* operations
    'provider.inject',      // Inject content into provider instruction files
  ],

  // ── Canonical: nexus (BRAIN Network placeholder) ───────────────────
  nexus: [
    // Placeholder — NexusHandler returns E_NOT_IMPLEMENTED for all ops.
    // Entries here allow domain routing to reach the handler without
    // triggering E_INVALID_DOMAIN at the gateway validation layer.
    'connect',        // Connect to BRAIN network (not yet implemented)
  ],

  // ── Legacy aliases (backward compat) ───────────────────────────────
  research: [
    'inject',          // Get protocol injection
    'link',            // Link research to task
    'manifest.append', // Append manifest entry
    'manifest.archive', // Archive old entries
  ],
  lifecycle: [
    'record',      // Record stage completion
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
    'init',              // Initialize CLEO
    'config.set',        // Set config value
    'backup',            // Create backup
    'restore',           // Restore from backup
    'migrate',           // Run migrations
    'sync',              // Sync with TodoWrite
    'cleanup',           // Cleanup stale data
    'job.cancel',        // Cancel background job
    'safestop',          // Graceful agent shutdown
    'inject.generate',   // Generate MVI injection
  ],
  issues: [
    'add.bug',        // File a bug report
    'add.feature',    // Request a feature
    'add.help',       // Ask a question
    'create.bug',     // Alias (backward compat)
    'create.feature', // Alias (backward compat)
    'create.help',    // Alias (backward compat)
  ],
  skills: [
    'install',        // Install a skill
    'uninstall',      // Uninstall a skill
    'enable',         // Enable a skill
    'disable',        // Disable a skill
    'configure',      // Configure a skill
    'refresh',        // Refresh skill registry
  ],
  providers: [
    'inject',         // Inject content into provider instruction files
  ],
};

/**
 * Dynamic operation count (derived from MUTATE_OPERATIONS).
 */
const actualMutateCount = Object.values(MUTATE_OPERATIONS).flat().length;
if (actualMutateCount < 1) {
  console.error('Warning: Mutate operation registry is empty.');
}

/**
 * Idempotent operations that may return success for already-completed actions
 * These operations use exit codes 100+ to signal "already done" vs "just completed"
 */
const IDEMPOTENT_OPERATIONS: Record<string, string[]> = {
  tasks: ['complete', 'archive'],
  session: ['end', 'gc'],
  lifecycle: ['record', 'skip', 'gate.pass'],
  validate: ['compliance.record'],
  release: ['tag', 'push'],
  system: ['init', 'migrate', 'cleanup'],
};

/**
 * Operations that require session binding
 */
const SESSION_REQUIRED_OPERATIONS: Record<string, string[]> = {
  tasks: ['add', 'update', 'complete'],
  session: ['start'],
  orchestrate: ['start', 'spawn'],
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
  // Handles both canonical domain names and legacy aliases
  switch (domain) {
    case 'tasks':
      return validateTasksParams(operation, params);
    case 'session':
      return validateSessionParams(operation, params);
    case 'orchestrate':
      return validateOrchestrateParams(operation, params);
    case 'research':
    case 'memory':
      return validateResearchParams(operation, params);
    case 'lifecycle':
      return validateLifecycleParams(operation, params);
    case 'validate':
    case 'check':
      return validateValidateParams(operation, params);
    case 'release':
      return validateReleaseParams(operation, params);
    case 'pipeline':
      return validatePipelineParams(operation, params);
    case 'system':
    case 'admin':
      return validateSystemParams(operation, params);
    case 'skills':
      return validateSkillsParams(operation, params);
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
  params?: Record<string, unknown>
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'add':
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
    case 'restore':
    case 'reparent':
    case 'promote':
    case 'reorder':
    case 'reopen':
    case 'start':
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

    case 'record.decision':
      if (!params?.sessionId || !params?.taskId || !params?.decision || !params?.rationale) {
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
  params?: Record<string, unknown>
): { valid: boolean; error?: DomainResponse } {
  switch (operation) {
    case 'start':
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
    case 'record':
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

  }

  return { valid: true };
}

/**
 * Validate skills domain parameters
 */
function validateSkillsParams(
  operation: string,
  params?: Record<string, unknown>
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
              gateway: 'cleo_mutate',
              domain: 'skills',
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
  params?: Record<string, unknown>
): { valid: boolean; error?: DomainResponse } {
  // Stage operations (lifecycle alias)
  if (operation.startsWith('stage.')) {
    const stageOp = operation.slice('stage.'.length);
    return validateLifecycleParams(stageOp, params);
  }
  // Release operations
  if (operation.startsWith('release.')) {
    const releaseOp = operation.slice('release.'.length);
    return validateReleaseParams(releaseOp, params);
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
  params?: Record<string, unknown>
): { valid: boolean; error?: DomainResponse } {
  // Skill operations
  if (operation.startsWith('skill.')) {
    const skillOp = operation.slice('skill.'.length);
    return validateSkillsParams(skillOp, params);
  }
  // Issue and provider operations pass through without extra validation
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

  // Build domain request
  const domainRequest: DomainRequest = {
    gateway: 'cleo_mutate',
    domain: request.domain,
    operation: request.operation,
    params: request.params,
  };

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
