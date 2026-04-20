/**
 * cleo-os Harness Registry.
 *
 * Centralises construction and lookup of {@link HarnessAdapter} implementations
 * available in cleo-os. Adding a new harness means:
 *
 * 1. Implement {@link HarnessAdapter} in a subdirectory under `harnesses/`.
 * 2. Add an entry to {@link HARNESS_REGISTRY} below.
 * 3. Export the adapter class from the subdirectory's `index.ts`.
 *
 * @packageDocumentation
 */

import { PiCodingAgentAdapter } from './pi-coding-agent/adapter.js';
import type { HarnessAdapter } from './pi-coding-agent/types.js';

// ---------------------------------------------------------------------------
// Registry map
// ---------------------------------------------------------------------------

/**
 * Metadata entry for a registered harness adapter.
 *
 * @public
 */
export interface HarnessRegistryEntry {
  /** Short stable identifier matching {@link HarnessAdapter.id}. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Factory function that creates a fresh adapter instance. */
  create: () => HarnessAdapter;
}

/**
 * All harness adapters registered with cleo-os.
 *
 * Keyed by the adapter's {@link HarnessAdapter.id}.
 */
const HARNESS_REGISTRY: ReadonlyMap<string, HarnessRegistryEntry> = new Map([
  [
    'pi-coding-agent',
    {
      id: 'pi-coding-agent',
      name: 'Pi Coding Agent',
      create: () => new PiCodingAgentAdapter(),
    },
  ],
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a harness adapter by ID.
 *
 * @param id - Harness adapter ID (e.g. `"pi-coding-agent"`).
 * @returns The registry entry, or `undefined` when not found.
 *
 * @example
 * ```typescript
 * const entry = getHarnessEntry('pi-coding-agent');
 * const adapter = entry?.create();
 * ```
 *
 * @public
 */
export function getHarnessEntry(id: string): HarnessRegistryEntry | undefined {
  return HARNESS_REGISTRY.get(id);
}

/**
 * Create a fresh instance of the harness adapter with the given ID.
 *
 * @param id - Harness adapter ID.
 * @returns A new {@link HarnessAdapter} instance, or `null` when the ID is
 *   not registered.
 *
 * @public
 */
export function createHarness(id: string): HarnessAdapter | null {
  return HARNESS_REGISTRY.get(id)?.create() ?? null;
}

/**
 * Return all registered harness adapter entries.
 *
 * @returns Array of all registry entries, in insertion order.
 *
 * @public
 */
export function listHarnesses(): HarnessRegistryEntry[] {
  return Array.from(HARNESS_REGISTRY.values());
}

export { PiCodingAgentAdapter } from './pi-coding-agent/adapter.js';
// Re-export types and the primary adapter for convenience.
export type { HarnessAdapter } from './pi-coding-agent/types.js';
