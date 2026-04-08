/**
 * Install provider interface for CLEO provider adapters.
 * Handles registration with the provider and instruction file references.
 *
 * @task T5240
 */

export interface AdapterInstallProvider {
  install(options: InstallOptions): Promise<InstallResult>;
  uninstall(): Promise<void>;
  isInstalled(): Promise<boolean>;
  /** Ensure the provider's instruction file references CLEO (e.g. @AGENTS.md in CLAUDE.md). */
  ensureInstructionReferences(projectDir: string): Promise<void>;
}

export interface InstallOptions {
  projectDir: string;
  global?: boolean;
}

export interface InstallResult {
  success: boolean;
  installedAt: string;
  instructionFileUpdated: boolean;
  details?: Record<string, unknown>;
}
