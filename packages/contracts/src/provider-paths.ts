/**
 * Path provider interface for CLEO provider adapters.
 * Allows providers to declare their OS-specific directory locations.
 * @task T5240
 */

export interface AdapterPathProvider {
  /** Get the provider's global config directory (e.g., ~/.claude/) */
  getProviderDir(): string;
  /** Get the path to the provider's settings file, or null if N/A */
  getSettingsPath(): string | null;
  /** Get the directory where this provider installs agents, or null if N/A */
  getAgentInstallDir(): string | null;
  /** Get the path to a third-party memory DB if applicable, or null */
  getMemoryDbPath(): string | null;
}
