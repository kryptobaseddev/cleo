/**
 * `@cleocode/core/identity` — signing identity for audit trails.
 *
 * Re-exports the CLEO identity adapter over `llmtxt/identity`. This module
 * is the canonical entry point for anything that needs to produce or verify
 * signatures on `.cleo/audit/*.jsonl` entries or `cleo bug` severity
 * attestations.
 *
 * @task T947
 * @adr ADR-054 (draft)
 */

export {
  AgentIdentity,
  type AuditSignature,
  type CleoIdentityFile,
  getCleoIdentity,
  getCleoIdentityPath,
  signAuditLine,
  verifyAuditLine,
} from './cleo-identity.js';
