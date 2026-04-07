/**
 * MCP-as-Pi-extension bridge runtime — placeholder entry point.
 *
 * @remarks
 * This module is the public entry point for the MCP bridge runtime that
 * lives inside CAAMP per ADR-035 D4. The full JSON-RPC client, schema
 * translator, and subprocess lifecycle manager land in tasks T268–T272;
 * this file exists today as a typed placeholder so the package's `tsup`
 * `harness/mcp/index` entry resolves and the consumer-facing
 * `@cleocode/caamp/harness/mcp` subpath export type-checks.
 *
 * Wave-1 callers (T263–T267) do not import from this module — they only
 * exist alongside it. The placeholder is intentional and tracked.
 *
 * @see ADR-035 §D4 (MCP wire protocol)
 * @see Task T268 (MCP-as-Pi-extension bridge)
 *
 * @packageDocumentation
 */

/**
 * Placeholder configuration shape for an MCP server bridged into a Pi
 * extension.
 *
 * @remarks
 * The full lifecycle-bound config (transport selection, retry policy,
 * tool namespacing) is defined in T268. This placeholder type exists so
 * downstream callers can reference the symbol without depending on
 * unimplemented runtime behaviour.
 *
 * @public
 */
export interface BridgePlaceholderConfig {
  /** Logical server name. */
  readonly name: string;
}

/**
 * Returns whether the MCP bridge runtime has been activated for this
 * process.
 *
 * @remarks
 * Always returns `false` until T268 lands the real runtime. Provided so
 * feature-detection callers (`if (isBridgeAvailable()) ...`) compile
 * cleanly today and pick up the real implementation when it ships.
 *
 * @returns `true` once the bridge runtime is wired in T268, otherwise `false`.
 *
 * @public
 */
export function isBridgeAvailable(): boolean {
  return false;
}
