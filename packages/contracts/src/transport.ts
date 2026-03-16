/**
 * Transport provider interface for CLEO provider adapters.
 * Allows providers to supply custom inter-agent transport mechanisms.
 * @task T5240
 */

export interface AdapterTransportProvider {
  /** Create a transport instance for inter-agent communication */
  createTransport(): unknown;
  /** Name of this transport type for logging/debugging */
  readonly transportName: string;
}
