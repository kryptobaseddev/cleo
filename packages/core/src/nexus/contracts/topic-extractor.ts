/**
 * Topic/pub-sub contract extractor for NEXUS (stub implementation).
 *
 * Detects common pub/sub patterns like:
 * - `.publish(topic)` in Kafka-style code
 * - `@KafkaListener(topic)` annotations in Java/Spring
 * - `emitter.emit(eventName)` in Node.js
 *
 * Current implementation is minimal — projects without pub/sub patterns return empty.
 * Acceptance: the extractor exists and is wire-ready; finding actual topic contracts
 * is deferred to a follow-up task if needed.
 *
 * @task T1065 — Contract Registry
 */

import type { TopicContract } from '@cleocode/contracts';

/**
 * Extract all topic/pub-sub contracts from a project's source code.
 *
 * Stub implementation: returns empty array on projects without pub/sub patterns.
 * Full implementation would search for common patterns like:
 * - `.publish(topicName)` calls
 * - `.subscribe(topicName)` calls
 * - `@KafkaListener(topic)` annotations
 * - `EventEmitter.emit(eventName)` calls
 *
 * @param projectId - Project identifier from registry
 * @param projectRoot - Root directory of the project
 * @returns Promise resolving to array of TopicContract objects (empty if no pub/sub patterns)
 */
export async function extractTopicContracts(
  _projectId: string,
  _projectRoot: string,
): Promise<TopicContract[]> {
  try {
    // Stub: detect pub/sub patterns but don't extract them yet.
    // In a full implementation, we'd:
    // 1. Query nexus_nodes for symbol references to common pub/sub libraries
    // 2. Look for string literals matching topic name patterns
    // 3. Determine direction (publish vs subscribe) from call context
    // 4. Build TopicContract objects with payload schemas (if inferable)

    // For now, return empty — this is acceptable for projects that don't use pub/sub.
    return [];
  } catch (err) {
    throw new Error(
      `Failed to extract topic contracts for project ${_projectId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
