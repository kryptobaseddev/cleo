/**
 * Graph auto-population helpers for CLEO BRAIN.
 *
 * Provides upsertGraphNode and addGraphEdge helpers that write to the
 * brain_page_nodes and brain_page_edges tables whenever memory entries
 * are created via the legitimate write paths (storeDecision, observeBrain,
 * storePattern, storeLearning, and task completion).
 *
 * Design constraints:
 * - All writes are BEST-EFFORT — never block or fail the primary operation.
 * - All writes are gated on brain.autoCapture via isAutoCaptureEnabled.
 * - Uses INSERT OR REPLACE (onConflictDoUpdate) for upsert semantics.
 * - Edge inserts are idempotent via the composite PK (fromId, toId, edgeType).
 *
 * @task T537
 * @epic T523
 */

import { createHash } from 'node:crypto';
import type { BrainEdgeType, BrainNodeType } from '../store/brain-schema.js';
import { brainPageEdges, brainPageNodes } from '../store/brain-schema.js';
import { getBrainDb } from '../store/brain-sqlite.js';

// Re-export types so callers can import them from this module without
// reaching into brain-schema directly.
export type { BrainEdgeType, BrainNodeType };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return true when brain.autoCapture is enabled for the project.
 * Delegates to the shared isAutoCaptureEnabled helper in handler-helpers.ts.
 * Returns false on any error to keep graph writes safely disabled when the
 * config or brain.db is unavailable.
 */
async function shouldAutoPopulateGraph(projectRoot: string): Promise<boolean> {
  try {
    const { isAutoCaptureEnabled } = await import('../hooks/handlers/handler-helpers.js');
    return isAutoCaptureEnabled(projectRoot);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upsert a graph node for a typed table entry.
 *
 * Uses INSERT OR REPLACE to handle both new and existing entries. If the
 * node already exists (same id), its label, qualityScore, lastActivityAt,
 * updatedAt, and metadataJson are refreshed while createdAt is preserved.
 *
 * The contentHash is derived from a SHA-256 prefix of the canonical content.
 * External-reference nodes (task, session, epic) may pass an empty string for
 * content; their hash will be null so duplicates are not rejected.
 *
 * This function is gated on brain.autoCapture. If the gate is disabled or any
 * error occurs, it returns silently without throwing.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param nodeId - Stable composite ID in the form '<type>:<source-id>'.
 * @param nodeType - Discriminated type from BRAIN_NODE_TYPES.
 * @param label - Human-readable label (title, task ID, etc.).
 * @param qualityScore - 0.0 (noise) to 1.0 (canonical).
 * @param content - Canonical text used to derive the content hash.
 * @param metadata - Optional type-specific metadata blob.
 *
 * @task T537
 */
export async function upsertGraphNode(
  projectRoot: string,
  nodeId: string,
  nodeType: BrainNodeType,
  label: string,
  qualityScore: number,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    if (!(await shouldAutoPopulateGraph(projectRoot))) return;

    const db = await getBrainDb(projectRoot);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Only compute a content hash for non-trivial content (external reference
    // nodes like task/session/epic may have empty content).
    const trimmed = content.trim().toLowerCase();
    const contentHash = trimmed
      ? createHash('sha256').update(trimmed).digest('hex').substring(0, 16)
      : null;

    await db
      .insert(brainPageNodes)
      .values({
        id: nodeId,
        nodeType,
        label: label.substring(0, 200),
        qualityScore,
        contentHash,
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: brainPageNodes.id,
        set: {
          label: label.substring(0, 200),
          qualityScore,
          lastActivityAt: now,
          updatedAt: now,
          metadataJson: metadata ? JSON.stringify(metadata) : null,
        },
      });
  } catch (err) {
    // Log but never surface — this is a best-effort side effect.
    console.warn('[brain-graph] upsertGraphNode failed:', err);
  }
}

/**
 * Add a directed, typed edge between two graph nodes (idempotent).
 *
 * The composite primary key (fromId, toId, edgeType) prevents duplicate edges
 * of the same type. Conflicting rows are ignored so this is safe to call
 * multiple times with the same arguments.
 *
 * This function is gated on brain.autoCapture. If the gate is disabled or any
 * error occurs, it returns silently without throwing.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param fromId - Source node ID (brain_page_nodes.id).
 * @param toId - Target node ID (brain_page_nodes.id or external nexus ID).
 * @param edgeType - Typed relationship from BRAIN_EDGE_TYPES.
 * @param weight - Edge confidence/weight (0.0–1.0). Defaults to 1.0.
 * @param provenance - Human-readable note on why this edge was emitted.
 *
 * @task T537
 */
export async function addGraphEdge(
  projectRoot: string,
  fromId: string,
  toId: string,
  edgeType: BrainEdgeType,
  weight = 1.0,
  provenance?: string,
): Promise<void> {
  try {
    if (!(await shouldAutoPopulateGraph(projectRoot))) return;

    const db = await getBrainDb(projectRoot);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    await db
      .insert(brainPageEdges)
      .values({
        fromId,
        toId,
        edgeType,
        weight,
        provenance: provenance ?? null,
        createdAt: now,
      })
      .onConflictDoNothing();
  } catch (err) {
    console.warn('[brain-graph] addGraphEdge failed:', err);
  }
}
