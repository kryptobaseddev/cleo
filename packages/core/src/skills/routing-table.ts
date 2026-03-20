/**
 * Dynamic Skill Routing Table
 *
 * Thin wrapper over the merged capability matrix. PreferredChannel data
 * is now stored as part of OperationCapability in the capability matrix
 * (packages/core/src/routing/capability-matrix.ts), which is the single
 * SSoT for both execution mode and channel preference.
 *
 * @task T5240
 * @epic T5149
 * @see packages/core/src/routing/capability-matrix.ts
 */

import { getCapabilityMatrix } from '../routing/capability-matrix.js';

export type { PreferredChannel } from '../routing/capability-matrix.js';

/**
 * Routing entry describing the preferred channel for an operation.
 *
 * Derived from OperationCapability in the capability matrix.
 * Use this type when consuming domain-level routing results from
 * getRoutingForDomain() or getOperationsByChannel().
 */
export interface RoutingEntry {
  /** Domain name (e.g. 'tasks', 'memory', 'session') */
  domain: string;
  /** Operation name (e.g. 'show', 'find') */
  operation: string;
  /** Preferred channel for token efficiency */
  preferredChannel: 'mcp' | 'cli' | 'either';
  /** Reason for the channel preference */
  reason: string;
}

/**
 * Look up the preferred channel for a given domain + operation.
 *
 * Reads from the merged capability matrix (single SSoT).
 *
 * @param domain - Domain name
 * @param operation - Operation name
 * @returns Preferred channel ('mcp', 'cli', or 'either' as fallback)
 */
export function getPreferredChannel(domain: string, operation: string): 'mcp' | 'cli' | 'either' {
  const entry = getCapabilityMatrix().find(
    (cap) => cap.domain === domain && cap.operation === operation,
  );
  return entry?.preferredChannel ?? 'either';
}

/**
 * Get routing entries for a specific domain.
 *
 * Derives entries from the capability matrix.
 *
 * @param domain - Domain name
 * @returns All routing entries for the domain
 */
export function getRoutingForDomain(domain: string): RoutingEntry[] {
  return getCapabilityMatrix()
    .filter((cap) => cap.domain === domain)
    .map((cap) => ({
      domain: cap.domain,
      operation: cap.operation,
      preferredChannel: cap.preferredChannel,
      reason: '',
    }));
}

/**
 * Get all operations that prefer a specific channel.
 *
 * Derives entries from the capability matrix.
 *
 * @param channel - Channel preference to filter by
 * @returns Matching routing entries
 */
export function getOperationsByChannel(channel: 'mcp' | 'cli' | 'either'): RoutingEntry[] {
  return getCapabilityMatrix()
    .filter((cap) => cap.preferredChannel === channel)
    .map((cap) => ({
      domain: cap.domain,
      operation: cap.operation,
      preferredChannel: cap.preferredChannel,
      reason: '',
    }));
}
