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

// ---------------------------------------------------------------------------
// T945 Stage A — universal semantic graph hooks
// ---------------------------------------------------------------------------
//
// These helpers ensure every first-class CLEO entity (task, attachment,
// CONDUIT message, git commit) is represented as a node in the brain graph
// at write time, not deferred to completion/consolidation. They close three
// gaps identified in the T945 Round 2 research:
//
//   1. `cleo docs add` never minted `llmtxt:<sha256>` nodes or `embeds` edges
//   2. CONDUIT messages had no node type, so `discusses` edges were unwritable
//   3. `addTask` never minted `task:<id>` nodes — only `completeTask` did,
//      leaving tasks invisible in the graph until completion
//
// All hooks are best-effort wrappers around upsertGraphNode / addGraphEdge:
// failures are swallowed (the graph is a side-effect, never a gate).
//
// Provenance tags follow the `auto:<source>-<event>` convention so consolidation
// passes can trace edge origins and apply the correct plasticity class.

/**
 * Regex matching CLEO task IDs within free-form text.
 *
 * Captures T followed by 3+ digits, with a word boundary on either side so we
 * don't match hex fragments like `T12ab`. Anchored to `T` only — no lowercase
 * `t` to avoid stop-word collisions (`The`, `This`, etc.).
 *
 * @task T945
 */
const TASK_ID_REGEX = /\bT\d{3,}\b/g;

/**
 * Upsert a `task:T###` graph node for a task at creation time (not completion).
 *
 * Prior to T945 Stage A, task nodes were only minted by `completeTask`, which
 * meant brand-new tasks were invisible in the graph until they shipped. This
 * hook fixes that gap by wiring `task:T###` nodes into `addTask` with a
 * quality score of 0.7 (provisional, not yet verified by gate evidence).
 *
 * Best-effort: any failure is swallowed so graph writes never block the
 * task-creation write path.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param taskId - CLEO task ID in `T###` format.
 * @param title - Task title (used as node label).
 * @param metadata - Optional type-specific metadata (priority, type, etc.).
 *
 * @task T945
 */
export async function ensureTaskNode(
  projectRoot: string,
  taskId: string,
  title: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await upsertGraphNode(
      projectRoot,
      `task:${taskId}`,
      'task',
      `${taskId}: ${title}`.substring(0, 200),
      0.7, // provisional; completion upgrades to 1.0 via existing complete.ts hook
      title,
      metadata,
    );
  } catch (err) {
    console.warn('[brain-graph] ensureTaskNode failed:', err);
  }
}

/**
 * Upsert an `llmtxt:<sha256>` graph node for an attachment blob and emit an
 * `embeds` edge from the owning entity to the blob.
 *
 * `cleo docs add` stores attachment blobs content-addressably; the blob's
 * SHA-256 becomes its canonical node ID so duplicate attachments across tasks
 * collapse to a single graph node with multiple incoming `embeds` edges.
 *
 * Best-effort: any failure is swallowed.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param sha256 - Hex-encoded SHA-256 of the blob (content-address).
 * @param ownerId - Full graph node ID of the owner (e.g. `task:T123`).
 * @param label - Human-readable label for the blob (filename or title).
 *
 * @task T945
 */
export async function ensureLlmtxtNode(
  projectRoot: string,
  sha256: string,
  ownerId: string,
  label: string,
): Promise<void> {
  try {
    const nodeId = `llmtxt:${sha256}`;
    await upsertGraphNode(
      projectRoot,
      nodeId,
      'llmtxt',
      label.substring(0, 200),
      0.8, // attachments are explicitly added by humans/agents → high confidence
      sha256, // content hash is the identity; re-deriving is consistent
      { sha256 },
    );
    await addGraphEdge(projectRoot, ownerId, nodeId, 'embeds', 1.0, 'auto:docs-add');
  } catch (err) {
    console.warn('[brain-graph] ensureLlmtxtNode failed:', err);
  }
}

/**
 * Upsert a `msg:<id>` graph node for a CONDUIT message and, when the message
 * body references one or more `T###` task IDs, emit `discusses` edges from
 * the message to each referenced task.
 *
 * Task IDs are extracted from the message content via `TASK_ID_REGEX`. Only
 * unique IDs are linked; duplicates within the same message collapse.
 *
 * Best-effort: any failure is swallowed.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param msgId - CONDUIT message ID (soft FK into conduit.db).
 * @param content - Full message body (scanned for task references).
 *
 * @task T945
 */
export async function ensureMessageNode(
  projectRoot: string,
  msgId: string,
  content: string,
): Promise<void> {
  try {
    const nodeId = `msg:${msgId}`;
    // Truncate label for display; full content still drives the hash
    const label = content.length > 200 ? `${content.substring(0, 197)}...` : content;
    await upsertGraphNode(
      projectRoot,
      nodeId,
      'msg',
      label || msgId,
      0.5, // messages are ephemeral chatter; consolidation can promote
      content,
      { msgId },
    );

    // Extract unique task references and link them via `discusses` edges.
    const matches = content.match(TASK_ID_REGEX);
    if (!matches) return;
    const unique = Array.from(new Set(matches));
    for (const taskId of unique) {
      await addGraphEdge(
        projectRoot,
        nodeId,
        `task:${taskId}`,
        'discusses',
        0.8,
        'auto:conduit-message',
      );
    }
  } catch (err) {
    console.warn('[brain-graph] ensureMessageNode failed:', err);
  }
}

/**
 * Upsert a `commit:<sha>` graph node for a git commit and emit a `touches_code`
 * edge from the associated task to the commit node.
 *
 * Used by the Tier 3 autonomy audit trail: every commit produced by an agent
 * is recorded as a graph node so operators can traverse task → commit → files
 * touched to reconstruct the audit chain.
 *
 * Best-effort: any failure is swallowed.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param sha - Full git commit SHA (40 hex chars; short SHAs accepted).
 * @param taskId - CLEO task ID this commit resolves (`T###`).
 *
 * @task T945
 */
export async function ensureCommitNode(
  projectRoot: string,
  sha: string,
  taskId: string,
): Promise<void> {
  try {
    const nodeId = `commit:${sha}`;
    await upsertGraphNode(
      projectRoot,
      nodeId,
      'commit',
      `${sha.substring(0, 12)} (${taskId})`,
      1.0, // commits are immutable ground truth
      sha,
      { sha, taskId },
    );
    await addGraphEdge(
      projectRoot,
      `task:${taskId}`,
      nodeId,
      'touches_code',
      1.0,
      'auto:commit-hook',
    );
  } catch (err) {
    console.warn('[brain-graph] ensureCommitNode failed:', err);
  }
}
