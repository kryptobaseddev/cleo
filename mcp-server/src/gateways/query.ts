/**
 * cleo_query Gateway - Read Operations
 *
 * Handles all read-only operations for discovery, status, analysis,
 * and validation checks. Never modifies state.
 *
 * Domains: tasks, session, orchestrate, research, lifecycle, validate, system
 * Total operations: 48
 *
 * @task T2915
 */

import { DomainRequest, DomainResponse } from '../lib/router.js';
import { createError } from '../lib/formatter.js';

/**
 * Query request interface
 */
export interface QueryRequest {
  domain: 'tasks' | 'session' | 'orchestrate' | 'research' | 'lifecycle' | 'validate' | 'system';
  operation: string;
  params?: Record<string, unknown>;
}

/**
 * Query response interface (aliases DomainResponse)
 */
export type QueryResponse = DomainResponse;

/**
 * Query operation matrix - all read operations by domain
 * Reference: MCP-SERVER-SPECIFICATION.md Section 2.1.2
 */
export const QUERY_OPERATIONS: Record<string, string[]> = {
  tasks: [
    'get',        // Get single task details
    'list',       // List tasks with filters
    'find',       // Fuzzy search tasks
    'exists',     // Check task existence
    'tree',       // Hierarchical task view
    'blockers',   // Get blocking tasks
    'deps',       // Get dependencies
    'analyze',    // Triage analysis
    'next',       // Next task suggestion
  ],
  session: [
    'status',     // Current session status
    'list',       // List all sessions
    'show',       // Session details
    'focus.get',  // Get focused task
    'history',    // Session history
  ],
  orchestrate: [
    'status',     // Orchestrator status
    'next',       // Next task to spawn
    'ready',      // Parallel-safe tasks
    'analyze',    // Dependency analysis
    'context',    // Context usage check
    'waves',      // Wave computation
    'skill.list', // Available skills
  ],
  research: [
    'show',           // Research entry details
    'list',           // List research entries
    'query',          // Search research
    'pending',        // Pending research
    'stats',          // Research statistics
    'manifest.read',  // Read manifest entries
  ],
  lifecycle: [
    'check',          // Check stage prerequisites
    'status',         // Current lifecycle state
    'history',        // Stage transition history
    'gates',          // All gate statuses
    'prerequisites',  // Required prior stages
  ],
  validate: [
    'schema',               // JSON Schema validation
    'protocol',             // Protocol compliance
    'task',                 // Anti-hallucination check
    'manifest',             // Manifest entry check
    'output',               // Output file validation
    'compliance.summary',   // Aggregated compliance
    'compliance.violations', // List violations
    'test.status',          // Test suite status
    'test.coverage',        // Coverage metrics
  ],
  system: [
    'version',    // CLEO version
    'doctor',     // Health check
    'config.get', // Get config value
    'stats',      // Project statistics
    'context',    // Context window info
    'job.status', // Get background job status
    'job.list',   // List background jobs
  ],
};

/**
 * Total operation count check
 */
const EXPECTED_QUERY_COUNT = 48;
const actualQueryCount = Object.values(QUERY_OPERATIONS).flat().length;
if (actualQueryCount !== EXPECTED_QUERY_COUNT) {
  console.error(
    `Warning: Query operation count mismatch. Expected ${EXPECTED_QUERY_COUNT}, got ${actualQueryCount}`
  );
}

/**
 * Validate query request parameters
 */
export function validateQueryParams(request: QueryRequest): {
  valid: boolean;
  error?: DomainResponse;
} {
  const { domain, operation } = request;

  // Check if domain is valid
  if (!QUERY_OPERATIONS[domain]) {
    return {
      valid: false,
      error: {
        _meta: {
          gateway: 'cleo_query',
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
          message: `Unknown query domain: ${domain}`,
          fix: `Use one of: ${Object.keys(QUERY_OPERATIONS).join(', ')}`,
          alternatives: Object.keys(QUERY_OPERATIONS).map((d) => ({
            action: `List ${d} operations`,
            command: `Available: ${QUERY_OPERATIONS[d].join(', ')}`,
          })),
        },
      },
    };
  }

  // Check if operation is valid for this domain
  const validOps = QUERY_OPERATIONS[domain];
  if (!validOps.includes(operation)) {
    return {
      valid: false,
      error: {
        _meta: {
          gateway: 'cleo_query',
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
          message: `Operation '${operation}' not supported for cleo_query in domain '${domain}'`,
          fix: `Use one of: ${validOps.join(', ')}`,
          alternatives: validOps.map((op) => ({
            action: `Use ${op}`,
            command: `cleo_query ${domain} ${op}`,
          })),
        },
      },
    };
  }

  return { valid: true };
}

/**
 * Register cleo_query tool with MCP server
 *
 * Returns tool definition for ListToolsRequestSchema handler
 */
export function registerQueryTool() {
  return {
    name: 'cleo_query',
    description:
      'CLEO read operations: task discovery, status checks, analysis, validation, and compliance metrics. Never modifies state.',
    inputSchema: {
      type: 'object',
      required: ['domain', 'operation'],
      properties: {
        domain: {
          type: 'string',
          enum: Object.keys(QUERY_OPERATIONS),
          description: 'Functional domain to query',
        },
        operation: {
          type: 'string',
          description: 'Domain-specific read operation (see operation matrix)',
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
 * Handle cleo_query request
 *
 * Validates parameters and routes to domain handler via DomainRouter
 *
 * @param request Query request with domain, operation, and params
 * @returns Promise resolving to query response
 */
export async function handleQueryRequest(
  request: QueryRequest
): Promise<QueryResponse> {
  // Validate request parameters
  const validation = validateQueryParams(request);
  if (!validation.valid) {
    return validation.error!;
  }

  // Build domain request (will be routed by DomainRouter)
  const domainRequest: DomainRequest = {
    gateway: 'cleo_query',
    domain: request.domain,
    operation: request.operation,
    params: request.params,
  };

  // Return domain request for router to handle
  // (This function is called by the router via index.ts)
  // The actual routing happens in DomainRouter.routeOperation()
  return {
    _meta: {
      gateway: 'cleo_query',
      domain: request.domain,
      operation: request.operation,
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      duration_ms: 0,
    },
    success: true,
    data: domainRequest,
  };
}

/**
 * Get query operation count for specific domain or all domains
 */
export function getQueryOperationCount(domain?: string): number {
  if (domain) {
    return QUERY_OPERATIONS[domain]?.length || 0;
  }
  return actualQueryCount;
}

/**
 * Check if operation is read-only (query)
 */
export function isQueryOperation(domain: string, operation: string): boolean {
  return QUERY_OPERATIONS[domain]?.includes(operation) || false;
}

/**
 * Get all query domains
 */
export function getQueryDomains(): string[] {
  return Object.keys(QUERY_OPERATIONS);
}

/**
 * Get operations for specific query domain
 */
export function getQueryOperations(domain: string): string[] {
  return QUERY_OPERATIONS[domain] || [];
}
