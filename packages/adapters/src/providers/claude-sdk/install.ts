/**
 * Claude SDK install provider.
 *
 * The Claude SDK adapter is a programmatic LLM bridge, not a native CLI
 * integration surface. CLEO installation is therefore a no-op: project
 * instruction files are managed by the active CLI provider (for example
 * `claude-code`) while this provider supplies SDK-backed spawning.
 *
 * @task T933
 * @packageDocumentation
 */

import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';

/**
 * No-op install provider for the SDK-backed Claude provider.
 *
 * @remarks
 * `CLEOProviderAdapter` requires an install provider. This implementation
 * preserves that contract without pretending the Anthropic SDK has a native
 * instruction-file or hook installation target.
 */
export class ClaudeSDKInstallProvider implements AdapterInstallProvider {
  /**
   * Report a successful no-op installation.
   *
   * @param options - Installation options. Currently accepted for contract
   *   parity and not mutated.
   * @returns A successful install result with `instructionFileUpdated=false`.
   */
  async install(options: InstallOptions): Promise<InstallResult> {
    return {
      success: true,
      installedAt: new Date().toISOString(),
      instructionFileUpdated: false,
      details: {
        provider: 'claude-sdk',
        projectDir: options.projectDir,
        mode: 'programmatic-sdk',
      },
    };
  }

  /**
   * No-op uninstall for the SDK provider.
   */
  async uninstall(): Promise<void> {}

  /**
   * Return true because the SDK provider requires no filesystem installation.
   *
   * @returns Always `true`.
   */
  async isInstalled(): Promise<boolean> {
    return true;
  }

  /**
   * No-op instruction-file reference hook.
   *
   * @param projectDir - Project directory accepted for interface parity.
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    void projectDir;
  }
}
