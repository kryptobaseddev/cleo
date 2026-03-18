/**
 * Claude Code context monitor provider.
 *
 * Implements AdapterContextMonitorProvider for Claude Code's context window
 * tracking and statusline integration.
 *
 * @task T5240
 */
import type { AdapterContextMonitorProvider } from '@cleocode/contracts';
/**
 * Context monitor provider for Claude Code.
 *
 * Processes context window JSON from Claude Code and writes state files
 * for statusline display. Also provides statusline configuration
 * and setup instructions specific to Claude Code's settings.json.
 */
export declare class ClaudeCodeContextMonitorProvider implements AdapterContextMonitorProvider {
    private pathProvider;
    processContextInput(input: unknown, cwd?: string): Promise<string>;
    checkStatuslineIntegration(): 'configured' | 'not_configured' | 'custom_no_cleo' | 'no_settings';
    getStatuslineConfig(): Record<string, unknown>;
    getSetupInstructions(): string;
}
//# sourceMappingURL=context-monitor.d.ts.map