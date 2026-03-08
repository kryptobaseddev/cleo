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
import { getProjectRoot } from '../../core/paths.js';
import type { RateLimitingConfig } from '../../mcp/lib/rate-limiter.js';
import { Dispatcher } from '../dispatcher.js';
import { createDomainHandlers } from '../domains/index.js';
import { createAudit } from '../middleware/audit.js';
import { createFieldFilter } from '../middleware/field-filter.js';
import { createProjectionMiddleware } from '../middleware/projection.js';
import { createProtocolEnforcement } from '../middleware/protocol-enforcement.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';
import { createSanitizer } from '../middleware/sanitizer.js';
import { createSessionResolver } from '../middleware/session-resolver.js';
import { createVerificationGates } from '../middleware/verification-gates.js';
import type { DispatchRequest, DispatchResponse, Gateway } from '../types.js';

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
      createSessionResolver(), // T4959: session identity first
      createSanitizer(() => getProjectRoot()),
      createProjectionMiddleware(), // T5096: MVI tier-based domain/field projection
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
 * Handle an MCP tool call (query or mutate).
 *
 * Translates the MCP parameters into a DispatchRequest, executes it
 * through the dispatcher, and formats the response back to the standard
 * MCP SDK format.
 */
export async function handleMcpToolCall(
  gateway: string,
  domain: string,
  operation: string,
  params?: Record<string, unknown>,
  requestId?: string,
): Promise<DispatchResponse> {
  const dispatcher = getMcpDispatcher();

  // Validate gateway
  if (
    gateway !== 'query' &&
    gateway !== 'mutate' &&
    gateway !== 'cleo_query' &&
    gateway !== 'cleo_mutate'
  ) {
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
        message: `Unknown gateway: ${gateway}. Use 'query' or 'mutate'.`,
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
  const normalizedGateway: Gateway =
    gateway === 'cleo_query' || gateway === 'query' ? 'query' : 'mutate';

  const req: DispatchRequest = {
    gateway: normalizedGateway,
    domain: domain,
    operation: operation,
    params,
    source: 'mcp',
    requestId: requestId || randomUUID(),
  };

  return dispatcher.dispatch(req);
}
