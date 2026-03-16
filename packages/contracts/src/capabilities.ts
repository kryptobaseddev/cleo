/**
 * Adapter capability declarations for CLEO provider adapters.
 *
 * @task T5240
 */

export interface AdapterCapabilities {
  supportsHooks: boolean;
  supportedHookEvents: string[];
  supportsSpawn: boolean;
  supportsInstall: boolean;
  supportsMcp: boolean;
  supportsInstructionFiles: boolean;
  /** Provider-specific instruction file name, e.g. "CLAUDE.md", ".cursorrules" */
  instructionFilePattern?: string;
}
