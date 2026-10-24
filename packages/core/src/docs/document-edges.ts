/**
 * Backfill of the canonical document link (T13985, owner decision D11180).
 *
 * A document attached to an owner is recorded in BRAIN as the edge
 * `llmtxt:<sha256> --documents--> <ownerType>:<ownerId>`. `cleo docs add` writes
 * it through the docs projection; this backfill writes it for attachments that
 * predate the edge, or that were attached while the projection could not run.
 * It replaces the "Doc attached" observation the backfill used to emit.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module docs/document-edges
 * @task T13985
 */

import {
  addGraphEdge,
  DOCUMENTS_EDGE_PROVENANCE,
  upsertGraphNode,
} from '../memory/graph-auto-populate.js';
import { createAttachmentStore } from '../store/attachment-store.js';

/** Outcome of {@link backfillDocumentEdges}. */
export interface DocumentEdgeBackfillResult {
  /** Attachment bindings examined (one per owner of each attachment). */
  total: number;
  /** Bindings whose `documents` edge was written by this run. */
  written: number;
  /** Bindings that already had the edge, or carry no content hash to link. */
  skipped: number;
  /** Attachment ids whose edge this run wrote. */
  writtenAttachmentIds: string[];
}

/**
 * Write the missing `llmtxt --documents--> owner` edges for every attachment
 * binding in the project. Idempotent: an existing edge is left alone.
 *
 * @param projectRoot - Project whose attachments and brain are read.
 * @returns Counts of written and skipped bindings.
 * @example
 * ```ts
 * const { written } = await backfillDocumentEdges(projectRoot);
 * ```
 */
export async function backfillDocumentEdges(
  projectRoot: string,
): Promise<DocumentEdgeBackfillResult> {
  const bindings = await createAttachmentStore().listAllInProject(projectRoot);
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const db = getBrainNativeDb(projectRoot);
  // @sync-invariant none:local-only the backfill cannot open the brain, so it writes nothing
  if (!db) throw new Error('BRAIN database unavailable while backfilling document edges');
  const hasEdge = db.prepare(
    `SELECT 1 AS found FROM main.brain_page_edges
     WHERE from_id = ? AND to_id = ? AND edge_type = 'documents'`,
  );
  const result: DocumentEdgeBackfillResult = {
    total: bindings.length,
    written: 0,
    skipped: 0,
    writtenAttachmentIds: [],
  };
  for (const binding of bindings) {
    const sha256 = binding.metadata.sha256;
    const nodeId = `llmtxt:${sha256}`;
    const ownerId = `${binding.ownerType}:${binding.ownerId}`;
    // A URL never cached and an llmtxt-doc carry no content hash to link.
    if (!sha256 || hasEdge.get(nodeId, ownerId) !== undefined) {
      result.skipped++;
      continue;
    }
    const label = binding.slug ?? binding.metadata.id;
    await upsertGraphNode(
      projectRoot,
      nodeId,
      'llmtxt',
      label,
      0.8,
      sha256,
      { sha256 },
      undefined,
      { explicit: true, ifAbsent: true },
    );
    await addGraphEdge(
      projectRoot,
      nodeId,
      ownerId,
      'documents',
      1,
      DOCUMENTS_EDGE_PROVENANCE,
      undefined,
      { explicit: true },
    );
    result.written++;
    result.writtenAttachmentIds.push(binding.metadata.id);
  }
  return result;
}
