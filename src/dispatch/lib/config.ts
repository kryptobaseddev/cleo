/**
 * Configuration - Dispatch layer re-export
 *
 * Re-exports from the canonical implementation in mcp/lib.
 * Will be replaced with a standalone implementation when mcp/lib is removed.
 */
export {
  getConfig,
  loadConfig,
  resetConfig,
  validateConfig,
  ConfigValidationError,
} from '../../mcp/lib/config.js';
