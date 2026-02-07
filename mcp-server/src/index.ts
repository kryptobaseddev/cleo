#!/usr/bin/env node
/**
 * CLEO MCP Server Entry Point
 *
 * Exposes CLEO's 65 CLI commands and 280+ library functions through
 * two gateway tools using CQRS pattern:
 * - cleo_query: 45 read operations (never modifies state)
 * - cleo_mutate: 53 write operations (validated, logged, atomic)
 *
 * Wires together:
 * 1. Configuration loader
 * 2. CLI executor wrapper
 * 3. Domain router
 * 4. Gateway tools (query + mutate)
 * 5. MCP SDK server with stdio transport
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
import { loadConfig, getConfig } from './lib/config.js';
import { DomainRouter, DomainRequest } from './lib/router.js';
import { createExecutor } from './lib/executor.js';
import { registerQueryTool } from './gateways/query.js';
import { registerMutateTool } from './gateways/mutate.js';
import { QueryCache } from './lib/cache.js';

/**
 * Server state for cleanup
 */
interface ServerState {
  router: DomainRouter;
  server: Server;
  cache: QueryCache;
}

let serverState: ServerState | null = null;


/**
 * Initialize and start MCP server
 */
async function main(): Promise<void> {
  try {
    // Load configuration
    console.error('[CLEO MCP] Loading configuration...');
    const config = loadConfig();

    // Log startup info (to stderr, not stdout which is used by MCP)
    console.error('[CLEO MCP] Starting server...');
    console.error(`[CLEO MCP] CLI path: ${config.cliPath}`);
    console.error(`[CLEO MCP] Timeout: ${config.timeout}ms`);
    console.error(`[CLEO MCP] Log level: ${config.logLevel}`);
    console.error(`[CLEO MCP] Metrics: ${config.enableMetrics ? 'enabled' : 'disabled'}`);
    console.error(`[CLEO MCP] Max retries: ${config.maxRetries}`);

    // Create CLI executor
    console.error('[CLEO MCP] Creating CLI executor...');
    const executor = createExecutor(config.cliPath, config.timeout, config.maxRetries);

    // Test CLI connection
    console.error('[CLEO MCP] Testing CLI connection...');
    const connected = await executor.testConnection();
    if (!connected) {
      throw new Error(`Failed to connect to CLEO CLI at ${config.cliPath}`);
    }
    console.error('[CLEO MCP] CLI connection successful');

    // Get CLI version
    const cliVersion = await executor.getVersion();
    console.error(`[CLEO MCP] CLI version: ${cliVersion}`);

    // Initialize domain router with executor
    console.error('[CLEO MCP] Initializing domain router...');
    const router = new DomainRouter(executor);
    console.error('[CLEO MCP] Domain router initialized');
    console.error(`[CLEO MCP] Registered domains: ${router.getDomains().join(', ')}`);

    // Initialize query cache
    const cache = new QueryCache(config.queryCacheTtl, config.queryCache);
    console.error(`[CLEO MCP] Query cache: ${config.queryCache ? 'enabled' : 'disabled'} (TTL: ${config.queryCacheTtl}ms)`);

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
      const { name, arguments: args } = request.params;

      console.error(`[CLEO MCP] Tool call: ${name}`);
      if (config.logLevel === 'debug') {
        console.error(`[CLEO MCP] Arguments:`, JSON.stringify(args, null, 2));
      }

      try {
        // Validate gateway name
        if (name !== 'cleo_query' && name !== 'cleo_mutate') {
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
                    message: `Unknown gateway: ${name}. Use 'cleo_query' or 'cleo_mutate'.`,
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

        // Build domain request
        const domainRequest: DomainRequest = {
          gateway: name as 'cleo_query' | 'cleo_mutate',
          domain: args.domain as string,
          operation: args.operation as string,
          params: args.params as Record<string, unknown> | undefined,
        };

        // Check cache bypass flag
        const bypassCache = !!(args.params as Record<string, unknown> | undefined)?.bypassCache;

        // For query operations, check cache first
        if (name === 'cleo_query' && !bypassCache) {
          const domain = args.domain as string;
          const operation = args.operation as string;
          const params = args.params as Record<string, unknown> | undefined;
          const cached = cache.get(domain, operation, params);
          if (cached !== undefined) {
            if (config.logLevel === 'debug') {
              console.error(`[CLEO MCP] Cache hit: ${domain}.${operation}`);
            }
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

        // Route to domain handler
        const result = await router.routeOperation(domainRequest);

        if (config.logLevel === 'debug') {
          console.error(`[CLEO MCP] Result:`, JSON.stringify(result, null, 2));
        }

        // Cache successful query results
        if (name === 'cleo_query' && result.success && !bypassCache) {
          cache.set(
            args.domain as string,
            args.operation as string,
            args.params as Record<string, unknown> | undefined,
            result
          );
        }

        // Invalidate domain cache on mutate operations
        if (name === 'cleo_mutate') {
          const invalidated = cache.invalidateDomain(args.domain as string);
          if (invalidated > 0 && config.logLevel === 'debug') {
            console.error(`[CLEO MCP] Cache invalidated ${invalidated} entries for domain: ${args.domain}`);
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
        console.error(`[CLEO MCP] Error:`, error);

        const errorMessage =
          error instanceof Error ? error.message : String(error);

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
      router,
      server,
      cache,
    };

    // Create transport and connect
    console.error('[CLEO MCP] Connecting to stdio transport...');
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('[CLEO MCP] Server started successfully');
    console.error('[CLEO MCP] Ready for requests');
  } catch (error) {
    console.error('[CLEO MCP] Failed to start server:', error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  console.error(`[CLEO MCP] Received ${signal}, shutting down...`);

  if (serverState) {
    try {
      // Destroy cache
      serverState.cache.destroy();
      // Close server
      await serverState.server.close();
      console.error('[CLEO MCP] Server closed');
    } catch (error) {
      console.error('[CLEO MCP] Error during shutdown:', error);
    }
  }

  process.exit(0);
}

/**
 * Error handler for uncaught exceptions
 */
function handleUncaughtError(error: Error, type: string): void {
  console.error(`[CLEO MCP] ${type}:`, error);

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
  console.error('[CLEO MCP] Fatal error:', error);
  process.exit(1);
});
