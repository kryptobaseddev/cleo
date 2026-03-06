/**
 * CLEO MCP Server Entry Point
 *
 * Routes all MCP requests through the unified dispatch layer.
 * Preserves MCP-specific features: query caching, LAFS budget enforcement,
 * background job management, and cache invalidation on mutate.
 *
 * Gateway tools (CQRS pattern):
 * - query: read operations (never modifies state)
 * - mutate: write operations (validated, logged, atomic)
 *
 * @task T2926
 * @see MCP-SERVER-SPECIFICATION.md for complete API documentation
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { registerQueryTool } from './gateways/query.js';
import { registerMutateTool } from './gateways/mutate.js';
import { QueryCache } from './lib/cache.js';
import { BackgroundJobManager } from './lib/background-jobs.js';
import { enforceBudget } from './lib/budget.js';
import { loadConfig } from './lib/config.js';
import { initMcpDispatcher, handleMcpToolCall } from '../dispatch/adapters/mcp.js';
import { hooks } from '../core/hooks/registry.js';
import '../core/hooks/handlers/index.js';
import { setJobManager } from './lib/job-manager-accessor.js';
import { initLogger, getLogger, closeLogger } from '../core/logger.js';
import { getProjectInfoSync } from '../core/project-info.js';
import { getCleoVersion } from '../core/scaffold.js';
import { pruneAuditLog } from '../core/audit-prune.js';
import { join } from 'node:path';

/**
 * Server state for cleanup
 */
interface ServerState {
  server: Server;
  cache: QueryCache;
  jobManager: BackgroundJobManager;
}

let serverState: ServerState | null = null;

/**
 * Pre-init fallback logger; replaced after initLogger() with a properly
 * initialised child so post-init log calls go to the structured log file.
 */
let startupLog = getLogger('mcp:startup');


/**
 * Initialize and start MCP server
 */
async function main(): Promise<void> {
  // Startup guard: fail fast if Node.js version is below minimum
  const { getNodeVersionInfo, getNodeUpgradeInstructions, MINIMUM_NODE_MAJOR } = await import('../core/platform.js');
  const nodeInfo = getNodeVersionInfo();
  if (!nodeInfo.meetsMinimum) {
    const upgrade = getNodeUpgradeInstructions();
    startupLog.fatal(
      {
        minimumNodeMajor: MINIMUM_NODE_MAJOR,
        nodeVersion: nodeInfo.version,
        recommendedUpgrade: upgrade.recommended,
      },
      'Unsupported Node.js version for MCP startup',
    );
    process.exit(1);
  }

  try {
    // MCP-first bootstrap: ensure global CLEO home baseline exists.
    try {
      const { ensureGlobalBootstrap } = await import('../core/global-bootstrap.js');
      ensureGlobalBootstrap();
    } catch (bootstrapErr) {
      startupLog.warn(
        {
          err: bootstrapErr,
          errorMessage:
            bootstrapErr instanceof Error
              ? bootstrapErr.message
              : String(bootstrapErr),
        },
        'Global bootstrap warning',
      );
    }

    // Load configuration
    const config = loadConfig();

    // Initialize structured logger (after config, before request handling)
    const projectInfo = getProjectInfoSync();
    const cleoDir = join(process.cwd(), '.cleo');
    initLogger(cleoDir, {
      level: config.logLevel ?? 'info',
      filePath: 'logs/cleo.log',
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 5,
    }, projectInfo?.projectHash);

    // Re-acquire startup logger now that initLogger has been called,
    // so all subsequent log calls go to the structured log file.
    startupLog = getLogger('mcp:startup');
    const log = startupLog;

    // Log startup info with version and projectHash for production correlation
    const cleoVersion = getCleoVersion();
    log.info(
      { version: cleoVersion, projectHash: projectInfo?.projectHash, logLevel: config.logLevel },
      'CLEO MCP server starting',
    );
    log.info({ enableMetrics: config.enableMetrics }, `Metrics: ${config.enableMetrics ? 'enabled' : 'disabled'}`);

    // Fire-and-forget audit log pruning (T5339)
    import('../core/config.js').then(({ loadConfig: loadCoreConfig }) =>
      loadCoreConfig().then(coreConfig =>
        pruneAuditLog(cleoDir, coreConfig.logging),
      ),
    ).catch(err => log.warn({ err }, 'audit log pruning failed'));

    // Initialize dispatch layer (replaces DomainRouter + executor + mode detection)
    log.info('Initializing dispatch layer');
    initMcpDispatcher({
      rateLimiting: config.rateLimiting,
      strictMode: true,
    });
    log.info('Dispatch layer initialized');

    // Initialize background job manager
    const jobManager = new BackgroundJobManager({ maxJobs: 10, retentionMs: 3600000 });
    setJobManager(jobManager);
    log.info({ maxJobs: 10, retentionMs: 3600000 }, 'Background job manager initialized');

    // Initialize query cache
    const cache = new QueryCache(config.queryCacheTtl, config.queryCache);
    log.info({ enabled: config.queryCache, ttlMs: config.queryCacheTtl }, `Query cache: ${config.queryCache ? 'enabled' : 'disabled'}`);

    // Create MCP server
    const server = new Server(
      {
        name: 'cleo-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Register tools (ListTools handler)
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          registerQueryTool(),
          registerMutateTool(),
        ],
      };
    });

    // Handle tool calls (CallTool handler)
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const rawName = request.params.name;
      const name = rawName === 'query' ? 'query' : rawName === 'mutate' ? 'mutate' : rawName;
      const { arguments: args } = request.params;

      const reqLog = getLogger('mcp:request');
      reqLog.debug({ tool: name }, `Tool call: ${name}`);
      reqLog.debug({ args }, 'Tool call arguments');

      try {
        // Validate gateway name
        if (name !== 'query' && name !== 'mutate' && name !== 'query' && name !== 'mutate') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  _meta: {
                    gateway: name,
                    version: '1.0.0',
                    timestamp: new Date().toISOString(),
                  },
                  success: false,
                  error: {
                    code: 'E_INVALID_GATEWAY',
                    exitCode: 2,
                    message: `Unknown gateway: ${name}. Use 'query' or 'mutate'.`,
                  },
                }),
              },
            ],
          };
        }

        // Validate required parameters
        if (!args?.domain || !args?.operation) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  _meta: {
                    gateway: name,
                    version: '1.0.0',
                    timestamp: new Date().toISOString(),
                  },
                  success: false,
                  error: {
                    code: 'E_INVALID_INPUT',
                    exitCode: 2,
                    message: 'Missing required parameters: domain and operation',
                  },
                }),
              },
            ],
          };
        }

        const domain = args.domain as string;
        const operation = args.operation as string;
        const params = args.params as Record<string, unknown> | undefined;

        // Check cache bypass flag
        const bypassCache = !!params?.bypassCache;

        // For query operations, check cache first
        if (name === 'query' && !bypassCache) {
          const cached = cache.get(domain, operation, params);
          if (cached !== undefined) {
            reqLog.debug({ domain, operation }, `Cache hit: ${domain}.${operation}`);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(cached, null, 2),
                },
              ],
            };
          }
        }

        // Dispatch onPromptSubmit hook (best-effort, fire-and-forget)
        hooks.dispatch('onPromptSubmit', process.cwd(), {
          timestamp: new Date().toISOString(),
          gateway: name,
          domain,
          operation,
          source: 'mcp',
        }).catch(() => { /* hook errors are non-fatal */ });

        // Route through dispatch layer (handles domain alias resolution)
        const dispatchStart = Date.now();
        let result = await handleMcpToolCall(name, domain, operation, params);

        // Dispatch onResponseComplete hook (best-effort, fire-and-forget)
        hooks.dispatch('onResponseComplete', process.cwd(), {
          timestamp: new Date().toISOString(),
          gateway: name,
          domain,
          operation,
          success: result.success,
          durationMs: Date.now() - dispatchStart,
          errorCode: result.error?.code,
        }).catch(() => { /* hook errors are non-fatal */ });

        reqLog.debug({ result }, 'Tool call result');

        // Apply LAFS token budget enforcement (@task T4701)
        const tokenBudget = params?.tokenBudget as number | undefined;
        if (tokenBudget) {
          const { response: enforced, enforcement } = enforceBudget(
            result as unknown as Record<string, unknown>,
            tokenBudget,
          );
          result = enforced as unknown as typeof result;
          reqLog.debug({ estimatedTokens: enforcement.estimatedTokens, tokenBudget, truncated: enforcement.truncated }, `Budget enforcement: ${enforcement.estimatedTokens}/${tokenBudget} tokens`);
        }

        // Cache successful query results
        if (name === 'query' && result.success && !bypassCache) {
          cache.set(domain, operation, params, result);
        }

        // Invalidate domain cache on mutate operations
        if (name === 'mutate') {
          const invalidated = cache.invalidateDomain(domain);
          if (invalidated > 0) {
            reqLog.debug({ domain, invalidated }, `Cache invalidated ${invalidated} entries for domain: ${domain}`);
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        reqLog.error({ err: error }, 'Tool call error');

        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // Dispatch onError hook (best-effort, fire-and-forget)
        hooks.dispatch('onError', process.cwd(), {
          timestamp: new Date().toISOString(),
          errorCode: 'E_INTERNAL_ERROR',
          message: errorMessage,
          domain: args?.domain as string | undefined,
          operation: args?.operation as string | undefined,
          gateway: name,
          stack: error instanceof Error ? error.stack : undefined,
        }).catch(() => { /* hook errors are non-fatal */ });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  _meta: {
                    gateway: name,
                    version: '1.0.0',
                    timestamp: new Date().toISOString(),
                  },
                  success: false,
                  error: {
                    code: 'E_INTERNAL_ERROR',
                    message: errorMessage,
                  },
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    });

    // Store server state for cleanup
    serverState = {
      server,
      cache,
      jobManager,
    };

    // Create transport and connect
    log.info('Connecting to stdio transport');
    const transport = new StdioServerTransport();
    await server.connect(transport);

    log.info({ transport: 'stdio' }, 'Server started successfully');
    log.info('Ready for requests');
  } catch (error) {
    startupLog.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  startupLog.info({ signal }, 'Received shutdown signal');

  if (serverState) {
    try {
      // Destroy background job manager
      serverState.jobManager.destroy();
      // Destroy cache
      serverState.cache.destroy();
      // Close server
      await serverState.server.close();
      startupLog.info({ signal }, 'Server closed');
    } catch (error) {
      startupLog.error({ err: error, signal }, 'Error during shutdown');
    }
  }

  // Flush and close logger before exit
  closeLogger();

  process.exit(0);
}

/**
 * Error handler for uncaught exceptions
 */
function handleUncaughtError(error: Error, type: string): void {
  startupLog.fatal({ err: error, errorType: type }, 'Unhandled MCP process error');

  // Attempt graceful shutdown
  if (serverState) {
    shutdown('ERROR').catch(() => {
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
}

// Register signal handlers for graceful shutdown
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Register error handlers
process.on('uncaughtException', (error) =>
  handleUncaughtError(error, 'Uncaught Exception')
);
process.on('unhandledRejection', (reason) =>
  handleUncaughtError(
    reason instanceof Error ? reason : new Error(String(reason)),
    'Unhandled Rejection'
  )
);

// Start server
main().catch((error) => {
  startupLog.fatal({ err: error }, 'Fatal startup error in main()');
  process.exit(1);
});
