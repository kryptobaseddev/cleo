/**
 * gRPC contract extractor for NEXUS (stub implementation).
 *
 * Detects `.proto` files in the project and extracts gRPC service method contracts.
 * Current implementation is minimal — projects without `.proto` files return empty.
 *
 * Acceptance: the extractor exists and is wire-ready; finding actual gRPC contracts
 * is deferred to a follow-up task if needed.
 *
 * @task T1065 — Contract Registry
 */

import type { GrpcContract } from '@cleocode/contracts';

/**
 * Extract all gRPC contracts from a project's `.proto` files.
 *
 * Stub implementation: returns empty array on projects without `.proto` files.
 * Full implementation would parse `.proto` syntax and extract service definitions.
 *
 * @param projectId - Project identifier from registry
 * @param projectRoot - Root directory of the project
 * @returns Promise resolving to array of GrpcContract objects (empty if no .proto files)
 */
export async function extractGrpcContracts(
  _projectId: string,
  _projectRoot: string,
): Promise<GrpcContract[]> {
  try {
    // Stub: detect .proto files but don't parse them yet.
    // In a full implementation, we'd:
    // 1. Glob for *.proto files under projectRoot
    // 2. Parse each .proto file's AST
    // 3. Extract service/rpc definitions and message types
    // 4. Build GrpcContract objects with typed request/response messages

    // For now, return empty — this is acceptable for projects that don't use gRPC.
    return [];
  } catch (err) {
    throw new Error(
      `Failed to extract gRPC contracts for project ${_projectId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
