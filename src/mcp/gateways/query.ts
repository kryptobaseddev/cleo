/**
 * cleo_query Gateway - Read Operations
 *
 * Handles all read-only operations for discovery, status, analysis,
 * and validation checks. Never modifies state.
 *
 * Canonical domains (9): tasks, session, memory, check, pipeline,
 *   orchestrate, tools, admin, nexus
 * Legacy aliases (backward compat): research, lifecycle, validate,
 *   release, system, issues, skills, providers
 *
 * The dispatch adapter (src/dispatch/adapters/mcp.ts) resolves legacy
 * domain names to canonical names before routing.
 *
 * @task T2915
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
 * All accepted domain names for cleo_query.
 *
 * Includes both canonical dispatch names and legacy MCP names
 * for backward compatibility. The dispatch adapter resolves
 * legacy names to canonical names at routing time.
 */
type QueryDomain =
  // Canonical domains
  | 'tasks' | 'session' | 'memory' | 'check' | 'pipeline'
  | 'orchestrate' | 'tools' | 'admin' | 'nexus'
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
 * Query operation matrix - all read operations by domain
 *
 * Contains BOTH legacy domain names (for backward compatibility with
 * existing agents) AND canonical domain aliases (for the dispatch layer).
 * The dispatch adapter resolves legacy -> canonical at routing time.
 *
 * Reference: MCP-SERVER-SPECIFICATION.md Section 2.1.2
 */
export const QUERY_OPERATIONS: Record<string, string[]> = {
  // ── Canonical domains ──────────────────────────────────────────────
  tasks: [
    'show',       // Get single task details
    'list',       // List tasks with filters
    'find',       // Fuzzy search tasks
    'exists',     // Check task existence
    'tree',       // Hierarchical task view
    'blockers',   // Get blocking tasks
    'depends',    // Get dependencies
    'analyze',    // Triage analysis
    'next',       // Next task suggestion
    'plan',       // Composite planning view
    'relates',              // Query task relationships
    'complexity.estimate',  // Deterministic complexity scoring
    'current',              // Get currently active task
  ],
  session: [
    'status',       // Current session status
    'list',         // List all sessions
    'show',         // Session details
    'history',      // Session history
    'decision.log',   // Decision audit log
    'context.drift',  // Session context drift analysis
    'handoff.show',   // Show handoff data
    'briefing.show',  // Composite session-start context
  ],
  orchestrate: [
    'status',     // Orchestrator status
    'next',       // Next task to spawn
    'ready',      // Parallel-safe tasks
    'analyze',    // Dependency analysis
    'context',    // Context usage check
    'waves',      // Wave computation
    'bootstrap',  // Brain state bootstrap
    'unblock.opportunities', // Unblocking opportunities analysis
    'critical.path', // Longest dependency chain analysis
  ],

  // ── Canonical: memory (research alias) ─────────────────────────────
  memory: [
    'show',           // Research entry details
    'list',           // List research entries
    'find',           // Find research
    'pending',        // Pending research
    'stats',            // Research statistics
    'manifest.read',    // Read manifest entries
    'contradictions',   // Find conflicting research findings
    'superseded',       // Find superseded research entries
    'pattern.search',   // Search BRAIN pattern memory
    'pattern.stats',    // Pattern memory statistics
    'learning.search',  // Search BRAIN learning memory
    'learning.stats',   // Learning memory statistics
  ],

  // ── Canonical: check (validate alias) ──────────────────────────────
  check: [
    'schema',               // JSON Schema validation
    'protocol',             // Protocol compliance
    'task',                 // Anti-hallucination check
    'manifest',             // Manifest entry check
    'output',               // Output file validation
    'compliance.summary',   // Aggregated compliance
    'compliance.violations', // List violations
    'test.status',          // Test suite status
    'test.coverage',        // Coverage metrics
    'coherence.check',      // Task graph consistency
  ],

  // ── Canonical: pipeline (lifecycle + release alias) ────────────────
  pipeline: [
    // lifecycle operations (stage.* prefix used in dispatch)
    'stage.validate',       // Check stage prerequisites
    'stage.status',         // Current lifecycle state
    'stage.history',        // Stage transition history
    'stage.gates',          // All gate statuses
    'stage.prerequisites',  // Required prior stages
  ],

  // ── Canonical: admin (system alias) ────────────────────────────────
  admin: [
    'version',        // CLEO version
    'health',         // Health check
    'config.show',    // Show config value
    'config.get',     // Alias (backward compat)
    'stats',          // Project statistics
    'context',        // Context window info
    'job.status',     // Get background job status
    'job.list',       // List background jobs
    'dash',           // Project overview dashboard
    'log',            // Audit log entries
    'sequence',       // ID sequence inspection
  ],

  // ── Canonical: tools (skills + issues + providers alias) ───────────
  tools: [
    // skill.* operations
    'skill.list',           // List available skills
    'skill.show',           // Skill details
    'skill.find',           // Find skills
    'skill.dispatch',       // Simulate skill dispatch
    'skill.verify',         // Validate skill frontmatter
    'skill.dependencies',   // Skill dependency tree
    // issue.* operations
    'issue.diagnostics',    // System diagnostics for bug reports
    // provider.* operations
    'provider.list',           // List all registered providers
    'provider.detect',         // Detect installed providers
    'provider.inject.status',  // Check injection status
  ],

  // ── Canonical: nexus (BRAIN Network placeholder) ───────────────────
  nexus: [
    // Placeholder — NexusHandler returns E_NOT_IMPLEMENTED for all ops.
    // Entries here allow domain routing to reach the handler without
    // triggering E_INVALID_DOMAIN at the gateway validation layer.
    'status',         // Nexus network status (not yet implemented)
  ],

  // ── Legacy aliases (backward compat) ───────────────────────────────
  research: [
    'show',           // Research entry details
    'list',           // List research entries
    'find',           // Find research
    'pending',        // Pending research
    'stats',            // Research statistics
    'manifest.read',    // Read manifest entries
    'contradictions',   // Find conflicting research findings
    'superseded',       // Find superseded research entries
  ],
  lifecycle: [
    'validate',       // Check stage prerequisites
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
    'coherence.check',      // Task graph consistency
  ],
  system: [
    'version',        // CLEO version
    'health',         // Health check
    'config.show',    // Show config value
    'config.get',     // Alias (backward compat)
    'stats',          // Project statistics
    'context',        // Context window info
    'job.status',     // Get background job status
    'job.list',       // List background jobs
    'dash',           // Project overview dashboard
    'log',            // Audit log entries
    'sequence',       // ID sequence inspection
  ],
  issues: [
    'diagnostics',    // System diagnostics for bug reports
  ],
  skills: [
    'list',           // List available skills
    'show',           // Skill details
    'find',           // Find skills
    'dispatch',       // Simulate skill dispatch
    'verify',         // Validate skill frontmatter
    'dependencies',   // Skill dependency tree
  ],
  providers: [
    'list',           // List all registered providers
    'detect',         // Detect installed providers
    'inject.status',  // Check injection status
  ],
};

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
