/**
 * Structure processor — Phase 2 of the code intelligence ingestion pipeline.
 *
 * Takes the flat `ScannedFile[]` list produced by the filesystem walker and
 * creates File and Folder graph nodes with CONTAINS edges in the in-memory
 * KnowledgeGraph.
 *
 * The processor walks each file's path segments, ensuring parent Folder nodes
 * exist before creating child nodes. Duplicate nodes are skipped (the
 * KnowledgeGraph deduplicates by ID).
 *
 * Ported and adapted from GitNexus:
 * `gitnexus/src/core/ingestion/structure-processor.ts`
 *
 * Key adaptations:
 * - Uses `GraphNode` from `@cleocode/contracts` (not gitnexus-shared)
 * - Relation type `'contains'` (lowercase) matches NEXUS_RELATION_TYPES
 * - Node IDs use relative path for File nodes, `<path>/` for Folder nodes
 * - Language field populated for File nodes from ScannedFile
 *
 * @task T532
 * @module pipeline/structure-processor
 */

import type { GraphNode, GraphRelation } from '@cleocode/contracts';
import type { ScannedFile } from './filesystem-walker.js';
import type { KnowledgeGraph } from './knowledge-graph.js';

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

/**
 * Build a stable node ID for a File node.
 *
 * The ID is the relative file path (forward-slash separated), matching the
 * format expected by nexus_nodes: `packages/core/src/store/brain-schema.ts`.
 *
 * @param relativePath - File path relative to the repository root
 */
function fileNodeId(relativePath: string): string {
  return relativePath;
}

/**
 * Build a stable node ID for a Folder node.
 *
 * Folder IDs use a trailing slash to distinguish them from files with
 * the same base name.
 *
 * @param relativePath - Folder path relative to the repository root
 */
function folderNodeId(relativePath: string): string {
  return `${relativePath}/`;
}

// ---------------------------------------------------------------------------
// Structure processor
// ---------------------------------------------------------------------------

/**
 * Populate the in-memory KnowledgeGraph with File and Folder nodes derived
 * from the scanned file list.
 *
 * For each file path the processor:
 * 1. Walks every path segment, creating Folder nodes for intermediate directories.
 * 2. Creates a File node for the final segment.
 * 3. Creates a CONTAINS edge from each parent Folder to its immediate child.
 *
 * The KnowledgeGraph's `addNode` implementation deduplicates by ID, so shared
 * parent folders are created only once regardless of how many children they have.
 *
 * @param files - Scanned file list from {@link walkRepositoryPaths}
 * @param graph - In-memory KnowledgeGraph to populate
 */
export function processStructure(files: ScannedFile[], graph: KnowledgeGraph): void {
  for (const file of files) {
    const parts = file.path.split('/');
    let currentPath = '';
    let parentId = '';

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const isFile = index === parts.length - 1;

      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let nodeId: string;
      let node: GraphNode;

      if (isFile) {
        nodeId = fileNodeId(currentPath);
        node = {
          id: nodeId,
          kind: 'file',
          name: part,
          filePath: currentPath,
          startLine: 1,
          endLine: 1,
          language: file.language ?? 'unknown',
          exported: false,
        };
      } else {
        nodeId = folderNodeId(currentPath);
        node = {
          id: nodeId,
          kind: 'folder',
          name: part,
          filePath: currentPath,
          startLine: 1,
          endLine: 1,
          language: 'unknown',
          exported: false,
        };
      }

      graph.addNode(node);

      if (parentId) {
        const relation: GraphRelation = {
          source: parentId,
          target: nodeId,
          type: 'contains',
          confidence: 1.0,
          reason: 'filesystem structure',
        };
        graph.addRelation(relation);
      }

      parentId = nodeId;
    }
  }
}
