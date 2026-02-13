/**
 * Domain Router for CLEO MCP Server
 *
 * Routes operations to appropriate domain handlers based on:
 * 1. Gateway type (query vs mutate)
 * 2. Domain (tasks, session, orchestrate, etc.)
 * 3. Operation (get, list, create, update, etc.)
 *
 * @task T2911
 * @task T2912
 * @task T3144 - Security hardening integration
 */

import { TasksHandler } from '../domains/tasks.js';
import { SessionHandler } from '../domains/session.js';
import { OrchestrateHandler } from '../domains/orchestrate.js';
import { ResearchHandler } from '../domains/research.js';
import { LifecycleHandler } from '../domains/lifecycle.js';
import { ValidateHandler } from '../domains/validate.js';
import { ReleaseHandler } from '../domains/release.js';
import { SystemHandler } from '../domains/system.js';
import { IssuesHandler } from '../domains/issues.js';
import { formatError, createError } from './formatter.js';
import { CLIExecutor } from './executor.js';
import type { ResolvedMode } from './mode-detector.js';
import { protocolEnforcer, ProtocolType } from './protocol-enforcement.js';
import { VerificationGate, OperationContext } from './verification-gates.js';
import { sanitizeParams, SecurityError } from './security.js';
import { RateLimiter, RateLimitResult, RateLimitingConfig } from './rate-limiter.js';

/**
 * Request from MCP gateway
 */
export interface DomainRequest {
  gateway: 'cleo_query' | 'cleo_mutate';
  domain: string;
  operation: string;
  params?: Record<string, unknown>;
}

/**
 * Response from domain handler
 *
 * Per MCP-SERVER-SPECIFICATION Section 3, all responses include
 * _meta with duration_ms timing.
 */
export interface DomainResponse {
  _meta: {
    gateway: string;
    domain: string;
    operation: string;
    version: string;
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
    alternatives?: Array<{
      action: string;
      command: string;
    }>;
  };
}

/**
 * Domain handler interface that all handlers must implement
 */
export interface DomainHandler {
  /**
   * Execute a query (read-only) operation
   */
  query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse>;

  /**
   * Execute a mutate (write) operation
   */
  mutate(operation: string, params?: Record<string, unknown>): Promise<DomainResponse>;

  /**
   * Get supported operations for this domain
   */
  getSupportedOperations(): {
    query: string[];
    mutate: string[];
  };
}

/**
 * Domain routing validation error
 */
export class RouterError extends Error {
  constructor(
    message: string,
    public code: string = 'E_ROUTING_ERROR',
    public exitCode: number = 1
  ) {
    super(message);
    this.name = 'RouterError';
  }
}

/**
 * Main domain router that dispatches operations to appropriate handlers
 */
export class DomainRouter {
  private handlers: Map<string, DomainHandler>;
  private useProtocolEnforcement: boolean;
  private verificationGate: VerificationGate;
  private rateLimiter: RateLimiter;

  constructor(
    executor: CLIExecutor,
    useProtocolEnforcement: boolean = true,
    rateLimitConfig?: Partial<RateLimitingConfig>,
    executionMode: ResolvedMode = 'cli'
  ) {
    // Initialize all domain handlers with execution mode
    this.handlers = new Map<string, DomainHandler>([
      ['tasks', new TasksHandler(executor, undefined, executionMode)],
      ['session', new SessionHandler(executor, executionMode)],
      ['orchestrate', new OrchestrateHandler(executor)],
      ['research', new ResearchHandler(executor)],
      ['lifecycle', new LifecycleHandler(executor)],
      ['validate', new ValidateHandler(executor)],
      ['release', new ReleaseHandler(executor)],
      ['system', new SystemHandler(executor, undefined, executionMode)],
      ['issues', new IssuesHandler(executor)],
    ]);
    this.useProtocolEnforcement = useProtocolEnforcement;
    this.verificationGate = new VerificationGate(useProtocolEnforcement);
    this.rateLimiter = new RateLimiter(rateLimitConfig);
  }

  /**
   * Route an operation to the appropriate domain handler
   */
  async routeOperation(request: DomainRequest): Promise<DomainResponse> {
    const startTime = Date.now();

    try {
      // Validate the route
      this.validateRoute(request);

      // Rate limiting check (Section 13.3)
      // Support bypassRateLimit param for testing
      const bypassRateLimit = !!request.params?.bypassRateLimit;
      const rateLimitResult = bypassRateLimit
        ? { allowed: true, remaining: Infinity, limit: Infinity, resetMs: 0, category: 'bypassed' as const }
        : this.rateLimiter.check(request.gateway, request.domain, request.operation);

      if (!rateLimitResult.allowed) {
        return {
          _meta: {
            gateway: request.gateway,
            domain: request.domain,
            operation: request.operation,
            version: '1.0.0',
            timestamp: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
            rateLimit: {
              limit: rateLimitResult.limit,
              remaining: rateLimitResult.remaining,
              resetMs: rateLimitResult.resetMs,
              category: rateLimitResult.category,
            },
          },
          success: false,
          error: {
            code: 'E_RATE_LIMITED',
            exitCode: 429,
            message: `Rate limit exceeded for ${rateLimitResult.category} operations. Limit: ${rateLimitResult.limit}/min. Retry after ${Math.ceil(rateLimitResult.resetMs / 1000)}s.`,
            details: {
              category: rateLimitResult.category,
              limit: rateLimitResult.limit,
              resetMs: rateLimitResult.resetMs,
            },
            fix: `Wait ${Math.ceil(rateLimitResult.resetMs / 1000)} seconds before retrying`,
          },
        };
      }

      // Sanitize input parameters (T3144)
      if (request.params) {
        try {
          request = {
            ...request,
            params: sanitizeParams(request.params),
          };
        } catch (sanitizeError) {
          if (sanitizeError instanceof SecurityError) {
            const response = formatError(
              `${request.domain}.${request.operation}`,
              createError(
                sanitizeError.code,
                sanitizeError.message,
                2,
                { context: { field: sanitizeError.field } }
              )
            ) as any;
            response._meta.duration_ms = Date.now() - startTime;
            return response as DomainResponse;
          }
          throw sanitizeError;
        }
      }

      // Get the handler
      const handler = this.handlers.get(request.domain);
      if (!handler) {
        throw new RouterError(
          `Unknown domain: ${request.domain}`,
          'E_INVALID_DOMAIN',
          2
        );
      }

      // Apply verification gate middleware if enabled
      if (this.useProtocolEnforcement && request.gateway === 'cleo_mutate') {
        // Build operation context for verification
        const context: OperationContext = {
          domain: request.domain,
          operation: request.operation,
          gateway: request.gateway,
          params: request.params,
          taskId: request.params?.taskId as string | undefined,
          protocolType: this.inferProtocolType(request),
        };

        // Run 4-layer verification gate
        const gateResult = await this.verificationGate.verifyOperation(context);

        // If verification fails, return error response
        if (!gateResult.passed) {
          const failedLayer = gateResult.layers[gateResult.blockedAt!];
          const response = formatError(
            `${request.domain}.${request.operation}`,
            createError(
              failedLayer.violations[0]?.code || 'E_VERIFICATION_FAILED',
              gateResult.summary,
              gateResult.exitCode
            )
          ) as any;
          response._meta.duration_ms = Date.now() - startTime;
          response._meta.verificationGate = {
            blockedAt: gateResult.blockedAt,
            violations: failedLayer.violations,
          };
          return response as DomainResponse;
        }

        // Verification passed, apply protocol enforcement
        const response = await protocolEnforcer.enforceProtocol(request, async () => {
          // Dispatch to appropriate gateway method
          if (request.gateway === 'cleo_query') {
            return await handler.query(request.operation, request.params);
          } else {
            return await handler.mutate(request.operation, request.params);
          }
        });

        // Add duration and rate limit metadata
        (response as any)._meta.duration_ms = Date.now() - startTime;
        this.addRateLimitMeta(response, rateLimitResult);
        return response;
      }

      // Dispatch without middleware
      let response: DomainResponse;
      if (request.gateway === 'cleo_query') {
        response = await handler.query(request.operation, request.params);
      } else {
        response = await handler.mutate(request.operation, request.params);
      }

      // Add duration and rate limit metadata
      (response as any)._meta.duration_ms = Date.now() - startTime;
      this.addRateLimitMeta(response, rateLimitResult);

      return response;
    } catch (error) {
      // Handle routing errors
      if (error instanceof RouterError) {
        const response = formatError(
          `${request.domain}.${request.operation}`,
          createError(error.code, error.message, error.exitCode)
        ) as any;
        response._meta.duration_ms = Date.now() - startTime;
        return response as DomainResponse;
      }

      // Handle unexpected errors
      const response = formatError(
        `${request.domain}.${request.operation}`,
        createError(
          'E_INTERNAL_ERROR',
          error instanceof Error ? error.message : String(error),
          1
        )
      ) as any;
      response._meta.duration_ms = Date.now() - startTime;
      return response as DomainResponse;
    }
  }

  /**
   * Validate that the domain/operation combination is valid
   */
  validateRoute(request: DomainRequest): void {
    const { gateway, domain, operation } = request;

    // Validate domain exists
    const handler = this.handlers.get(domain);
    if (!handler) {
      throw new RouterError(
        `Unknown domain: ${domain}`,
        'E_INVALID_DOMAIN',
        2
      );
    }

    // Get supported operations for this domain
    const supported = handler.getSupportedOperations();

    // Validate operation for gateway type
    const gatewayType = gateway === 'cleo_query' ? 'query' : 'mutate';
    const validOps = supported[gatewayType];

    if (!validOps.includes(operation)) {
      throw new RouterError(
        `Operation '${operation}' not supported for ${gateway} in domain '${domain}'`,
        'E_INVALID_OPERATION',
        2
      );
    }

    // Validate gateway/domain combination
    if (gateway === 'cleo_query' && domain === 'release') {
      throw new RouterError(
        `Domain 'release' only supports mutate operations`,
        'E_INVALID_GATEWAY',
        2
      );
    }
  }

  /**
   * Get list of all domains
   */
  getDomains(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Get supported operations for a specific domain
   */
  getDomainOperations(domain: string): {
    query: string[];
    mutate: string[];
  } | null {
    const handler = this.handlers.get(domain);
    return handler ? handler.getSupportedOperations() : null;
  }

  /**
   * Get the rate limiter instance (for testing/diagnostics)
   */
  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  /**
   * Add rate limit metadata to response _meta
   */
  private addRateLimitMeta(response: DomainResponse, rateLimitResult: RateLimitResult): void {
    (response._meta as any).rateLimit = {
      limit: rateLimitResult.limit,
      remaining: rateLimitResult.remaining,
      resetMs: rateLimitResult.resetMs,
      category: rateLimitResult.category,
    };
  }

  /**
   * Infer protocol type from request context
   *
   * Used to determine which protocol validation rules apply.
   */
  private inferProtocolType(request: DomainRequest): ProtocolType | undefined {
    // Orchestrate domain operations map to protocol types
    if (request.domain === 'orchestrate' && request.operation === 'spawn') {
      return request.params?.protocolType as ProtocolType | undefined;
    }

    // Research domain operations
    if (request.domain === 'research') {
      return ProtocolType.RESEARCH;
    }

    // Lifecycle domain operations map to lifecycle stages
    if (request.domain === 'lifecycle') {
      return request.params?.stage as ProtocolType | undefined;
    }

    // Release domain operations
    if (request.domain === 'release') {
      return ProtocolType.RELEASE;
    }

    // Validate domain operations
    if (request.domain === 'validate') {
      return ProtocolType.VALIDATION;
    }

    return undefined;
  }
}
