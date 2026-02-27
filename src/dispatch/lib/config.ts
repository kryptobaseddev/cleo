/**
 * Configuration for the dispatch layer.
 *
 * Re-exports shared configuration utilities from src/mcp/lib/config.ts
 * so that dispatch-layer middleware can access config without depending
 * directly on mcp/lib imports.
 *
 * The MCP config is the canonical config loader for the entire server
 * (MCP + dispatch). Both layers share the same config file (.cleo/config.json)
 * and environment variables (CLEO_MCP_*).
 *
 * @task T4830
 */

export {
  getConfig,
  loadConfig,
  resetConfig,
  validateConfig,
  ConfigValidationError,
} from '../../mcp/lib/config.js';

export type { MCPConfig } from '../../mcp/lib/defaults.js';
