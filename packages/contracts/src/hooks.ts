/**
 * Hook provider interface for CLEO provider adapters.
 * Maps provider-specific events to CAAMP hook events.
 *
 * @task T5240
 */

export interface AdapterHookProvider {
  /** Map a provider-specific event name to a CAAMP hook event name, or null if unmapped. */
  mapProviderEvent(providerEvent: string): string | null;
  /** Register the provider's native hook mechanism for a project. */
  registerNativeHooks(projectDir: string): Promise<void>;
  /** Unregister all native hooks previously registered. */
  unregisterNativeHooks(): Promise<void>;
}
