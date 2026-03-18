/**
 * Protocol Enforcement Middleware for CLEO MCP Server
 *
 * Re-exports from canonical location at src/core/compliance/protocol-enforcement.ts.
 * Retained for backward compatibility.
 *
 * @task T2918
 * @task T5707
 * @epic T2908
 */

export {
  ProtocolEnforcer,
  ProtocolType,
  protocolEnforcer,
  type ViolationLogEntry,
} from '@cleocode/core/internal';
