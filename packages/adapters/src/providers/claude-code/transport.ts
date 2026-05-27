/**
 * Transport provider for the Claude Code adapter.
 *
 * Implements AdapterTransportProvider to supply Claude Code's
 * native inter-agent transport mechanism.
 *
 * @task T5240
 */

import type { AdapterTransportProvider } from '@cleocode/contracts';

/**
 * Transport provider for Claude Code inter-agent communication.
 *
 * @remarks
 * Currently returns null from {@link createTransport} because actual transport
 * creation is handled by the signaldock factory which checks for this adapter's
 * transport capability flag. Full wiring will be completed in Phase 5 of the
 * adapter system rollout.
 */
export class ClaudeCodeTransportProvider implements AdapterTransportProvider {
  /** Provider-specific transport name used for capability negotiation. */
  readonly transportName = 'claude-code';

  /** Create a transport instance for inter-agent messaging. */
  createTransport(): unknown {
    // Returns null — actual transport creation is handled by the signaldock factory
    // which checks for this adapter's transport capability.
    // Full wiring will be completed in Phase 5.
    return null;
  }
}
