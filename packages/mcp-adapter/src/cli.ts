#!/usr/bin/env node
/**
 * CLI entry point for the CLEO MCP adapter server.
 *
 * Usage:
 *   npx cleo-mcp-server
 *   node dist/cli.js
 *
 * The server reads JSON-RPC 2.0 requests from stdin and writes responses to
 * stdout, following the MCP stdio transport protocol.
 *
 * @task T1148 W8-9
 */

import { startServer } from './server.js';

startServer({ cwd: process.cwd() });
