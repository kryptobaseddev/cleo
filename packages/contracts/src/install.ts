/**
 * Install provider interface for CLEO provider adapters.
 * Handles registration with the provider and instruction file references.
 *
 * @task T5240
 */

import type { HeavyCommandHookMode } from './heavy-command-hook.js';

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
  /**
   * The heavy-command hook mode (`resources.heavyCommandHook`, T12983).
   * `rewrite`/`warn` install or refresh the project-level hook entry, `off`
   * removes it, and `undefined` leaves the hook alone (callers that are not a
   * project init/upgrade, such as global bootstrap, pass nothing).
   */
  heavyCommandHook?: HeavyCommandHookMode;
}

export interface InstallResult {
  success: boolean;
  installedAt: string;
  instructionFileUpdated: boolean;
  details?: Record<string, unknown>;
}
