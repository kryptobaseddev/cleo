/**
 * Statusline integration for the Claude Code adapter.
 *
 * Implements the statusline portion of AdapterContextMonitorProvider.
 * Checks and configures Claude Code status line for context monitoring.
 *
 * @task T5240
 */
type StatuslineStatus = 'configured' | 'not_configured' | 'custom_no_cleo' | 'no_settings';
/**
 * Check if statusline integration is configured.
 * Returns the current integration status.
 */
export declare function checkStatuslineIntegration(): StatuslineStatus;
/**
 * Get the statusline setup command for Claude Code settings.
 */
export declare function getStatuslineConfig(cleoHome: string): Record<string, unknown>;
/**
 * Get human-readable setup instructions.
 */
export declare function getSetupInstructions(cleoHome: string): string;
//# sourceMappingURL=statusline.d.ts.map
