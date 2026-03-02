/**
 * MCP Adapter for the CQRS Dispatch Layer.
 *
 * Provides handleMcpToolCall() — the single entry point for MCP requests
 * that route through the dispatch pipeline.
 *
 * @epic T4820
 * @task T4819
 */

import { randomUUID } from 'node:crypto';
import type { Gateway, DispatchRequest, DispatchResponse } from '../types.js';
import { LEGACY_DOMAIN_ALIASES } from '../registry.js';
import { Dispatcher } from '../dispatcher.js';
import { createDomainHandlers } from '../domains/index.js';
import { createSessionResolver } from '../middleware/session-resolver.js';
import { createSanitizer } from '../middleware/sanitizer.js';
import { createFieldFilter } from '../middleware/field-filter.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';
import { createVerificationGates } from '../middleware/verification-gates.js';
import { createProtocolEnforcement } from '../middleware/protocol-enforcement.js';
import { createAudit } from '../middleware/audit.js';
import { createProjectionMiddleware } from '../middleware/projection.js';
import { getProjectRoot } from '../../core/paths.js';
import type { RateLimitingConfig } from '../../mcp/lib/rate-limiter.js';

export interface McpDispatcherConfig {
  rateLimiting?: Partial<RateLimitingConfig>;
  strictMode?: boolean;
}

let _dispatcher: Dispatcher | null = null;

/**
 * Initialize and get the singleton MCP dispatcher.
 */
export function initMcpDispatcher(config: McpDispatcherConfig = {}): Dispatcher {
  if (_dispatcher) return _dispatcher;

  const handlers = createDomainHandlers();
  const strictMode = config.strictMode ?? true;

  _dispatcher = new Dispatcher({
    handlers,
    middlewares: [
      createSessionResolver(),  // T4959: session identity first
      createSanitizer(() => getProjectRoot()),
      createProjectionMiddleware(),  // T5096: MVI tier-based domain/field projection
      createFieldFilter(),
      createRateLimiter(config.rateLimiting),
      createVerificationGates(strictMode),
      createProtocolEnforcement(strictMode),
      createAudit(),
    ],
  });

  return _dispatcher;
}

/**
 * Get the initialized singleton MCP dispatcher.
 */
export function getMcpDispatcher(): Dispatcher {
  if (!_dispatcher) {
    return initMcpDispatcher();
  }
  return _dispatcher;
}

/**
 * Reset the singleton dispatcher (for testing).
 */
export function resetMcpDispatcher(): void {
  _dispatcher = null;
}

/**
 * Resolve legacy MCP domain names to canonical dispatch domain/operation.
 *
 * Uses LEGACY_DOMAIN_ALIASES from the registry as the single source of truth
 * for domain alias mapping. Legacy domain names are translated to the
 * canonical 10-domain dispatch model with operation prefix rewriting.
 *
 * Also handles the undocumented 'issue' (singular) alias for 'issues'.
 */
function resolveDomainAlias(
  domain: string,
  operation: string,
): { domain: string; operation: string } {
  // Handle 'issue' (singular) as synonym for 'issues'
  const normalizedDomain = domain === 'issue' ? 'issues' : domain;

  const alias = LEGACY_DOMAIN_ALIASES[normalizedDomain];
  if (!alias) return { domain, operation };

  return {
    domain: alias.canonical,
    operation: alias.prefix ? `${alias.prefix}${operation}` : operation,
  };
}

/**
 * Resolve legacy operation aliases to canonical operation names.
 *
 * Canonical mapping follows ADR-017 verb standards while preserving
 * backward-compatible MCP aliases.
 */
function resolveOperationAlias(
  domain: string,
  operation: string,
): string {
  if ((domain === 'admin' || domain === 'system') && operation === 'config.get') {
    return 'config.show';
  }

  if ((domain === 'tools' || domain === 'issues' || domain === 'issue') && operation === 'issue.create.bug') {
    return 'issue.add.bug';
  }

  if ((domain === 'tools' || domain === 'issues' || domain === 'issue') && operation === 'issue.create.feature') {
    return 'issue.add.feature';
  }

  if ((domain === 'tools' || domain === 'issues' || domain === 'issue') && operation === 'issue.create.help') {
    return 'issue.add.help';
  }

  return operation;
}

/**
 * Handle an MCP tool call (cleo_query or cleo_mutate).
 *
 * Translates the MCP parameters into a DispatchRequest, executes it
 * through the dispatcher, and formats the response back to the standard
 * MCP SDK format. Resolves legacy domain aliases to canonical names.
 */
export async function handleMcpToolCall(
  gateway: string,
  domain: string,
  operation: string,
  params?: Record<string, unknown>,
  requestId?: string
): Promise<DispatchResponse> {
  const dispatcher = getMcpDispatcher();

  // Validate gateway
  if (gateway !== 'cleo_query' && gateway !== 'cleo_mutate') {
    return {
      _meta: {
        gateway: gateway as Gateway,
        domain: domain || 'system',
        operation: operation || 'unknown',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
      },
      success: false,
      error: {
        code: 'E_INVALID_GATEWAY',
        exitCode: 2,
        message: `Unknown gateway: ${gateway}. Use 'cleo_query' or 'cleo_mutate'.`,
      },
    } as DispatchResponse;
  }

  // Validate required parameters
  if (!domain || !operation) {
    return {
      _meta: {
        gateway: gateway as Gateway,
        domain: domain || 'system',
        operation: operation || 'unknown',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
      },
      success: false,
      error: {
        code: 'E_INVALID_INPUT',
        exitCode: 2,
        message: 'Missing required parameters: domain and operation',
      },
    } as DispatchResponse;
  }

  // Normalize gateway: 'cleo_query' → 'query', 'cleo_mutate' → 'mutate'
  // The dispatch registry and router use canonical 'query'/'mutate' values.
  const normalizedGateway: Gateway = gateway === 'cleo_query' ? 'query' : 'mutate';

  // Resolve legacy domain aliases to canonical dispatch names
  const resolved = resolveDomainAlias(domain, operation);
  const canonicalOperation = resolveOperationAlias(resolved.domain, resolved.operation);

  const req: DispatchRequest = {
    gateway: normalizedGateway,
    domain: resolved.domain,
    operation: canonicalOperation,
    params,
    source: 'mcp',
    requestId: requestId || randomUUID(),
  };

  return dispatcher.dispatch(req);
}
