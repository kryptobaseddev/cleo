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
  /** Return the full event mapping for introspection. */
  getEventMap?(): Readonly<Record<string, string>>;
  /**
   * Extract a plain-text transcript from the provider's session data.
   * Returns null if no transcript is available for this session.
   *
   * @param sessionId - The CLEO session ID
   * @param projectDir - Absolute path to the project directory
   * @task T144 @epic T134
   */
  getTranscript?(sessionId: string, projectDir: string): Promise<string | null>;
}
