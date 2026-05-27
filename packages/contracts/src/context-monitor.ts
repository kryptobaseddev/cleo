/**
 * Context monitor provider interface for CLEO provider adapters.
 * Allows providers to implement context window tracking and statusline integration.
 * @task T5240
 */

export interface AdapterContextMonitorProvider {
  /** Process context window input and return a status string */
  processContextInput(input: unknown, cwd?: string): Promise<string>;
  /** Check if statusline integration is configured */
  checkStatuslineIntegration(): 'configured' | 'not_configured' | 'custom_no_cleo' | 'no_settings';
  /** Get the statusline configuration object */
  getStatuslineConfig(): Record<string, unknown>;
  /** Get human-readable setup instructions */
  getSetupInstructions(): string;
}
