/**
 * cleo_query Gateway - Read Operations
 *
 * Handles all read-only operations for discovery, status, analysis,
 * and validation checks. Never modifies state.
 *
 * Canonical domains (10): tasks, session, memory, check, pipeline,
 *   orchestrate, tools, admin, nexus, sharing
 * Legacy aliases (backward compat): research, lifecycle, validate,
 *   release, system, issues, skills, providers
 *
 * The dispatch adapter (src/dispatch/adapters/mcp.ts) resolves legacy
 * domain names to canonical names before routing.
 *
 * @task T2915
 */

import { deriveGatewayMatrix } from '../../dispatch/registry.js';

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
 * All accepted domain names for cleo_query.
 *
 * Includes both canonical dispatch names and legacy MCP names
 * for backward compatibility. The dispatch adapter resolves
 * legacy names to canonical names at routing time.
 */
type QueryDomain =
  // Canonical domains
  | 'tasks' | 'session' | 'memory' | 'check' | 'pipeline'
  | 'orchestrate' | 'tools' | 'admin' | 'nexus' | 'sharing'
  // Legacy aliases (backward compat)
  | 'research' | 'lifecycle' | 'validate'
  | 'system' | 'issues' | 'skills' | 'providers';

/**
 * Query request interface
 */
export interface QueryRequest {
  domain: QueryDomain;
  operation: string;
  params?: Record<string, unknown>;
}

/**
 * Query response interface (aliases DomainResponse)
 */
export type QueryResponse = DomainResponse;

/**
 * Query operation matrix - all read operations by domain.
 *
 * DERIVED from the dispatch registry — single source of truth.
 * Contains both canonical domains and legacy alias domains.
 *
 * Reference: MCP-SERVER-SPECIFICATION.md Section 2.1.2
 */
export const QUERY_OPERATIONS: Record<string, string[]> = deriveGatewayMatrix('query');

/**
 * Dynamic operation count (derived from QUERY_OPERATIONS).
 */
const actualQueryCount = Object.values(QUERY_OPERATIONS).flat().length;
if (actualQueryCount < 1) {
  console.error('Warning: Query operation registry is empty.');
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
      'CLEO read operations: task discovery, status checks, analysis, validation, and compliance metrics. Never modifies state. First call: use domain "admin", operation "help" to discover all available operations.',
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
          description: 'Domain-specific read operation. Call admin.help to see the full operation matrix. Common: tasks.find, tasks.show, tasks.next, session.status, admin.dash',
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
