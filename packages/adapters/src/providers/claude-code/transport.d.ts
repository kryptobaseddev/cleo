/**
 * Transport provider for the Claude Code adapter.
 *
 * Implements AdapterTransportProvider to supply Claude Code's
 * native inter-agent transport mechanism.
 *
 * @task T5240
 */
import type { AdapterTransportProvider } from '@cleocode/contracts';
export declare class ClaudeCodeTransportProvider implements AdapterTransportProvider {
    readonly transportName = "claude-code";
    createTransport(): unknown;
}
//# sourceMappingURL=transport.d.ts.map