/**
 * Transport provider for the Claude Code adapter.
 *
 * Implements AdapterTransportProvider to supply Claude Code's
 * native inter-agent transport mechanism.
 *
 * @task T5240
 */

import type { AdapterTransportProvider } from '@cleocode/contracts';

export class ClaudeCodeTransportProvider implements AdapterTransportProvider {
  readonly transportName = 'claude-code';

  createTransport(): unknown {
    // Returns null — actual transport creation is handled by the signaldock factory
    // which checks for this adapter's transport capability.
    // Full wiring will be completed in Phase 5.
    return null;
  }
}
