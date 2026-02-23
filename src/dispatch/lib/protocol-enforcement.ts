/**
 * Protocol Enforcement - Dispatch layer re-export
 *
 * Re-exports from the canonical implementation in mcp/lib.
 * Will be replaced with a standalone implementation when mcp/lib is removed.
 */
export {
  ProtocolEnforcer,
  ProtocolType,
  protocolEnforcer,
  type ViolationLogEntry,
} from '../../mcp/lib/protocol-enforcement.js';
