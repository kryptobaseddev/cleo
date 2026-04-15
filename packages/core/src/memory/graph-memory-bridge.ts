/**
 * Graph Memory Bridge — connects brain.db memory nodes to nexus.db code nodes.
 *
 * Scans brain observations, decisions, patterns, and learnings for entity
 * references (file paths, function names, symbol names) and matches them
 * against nexus_nodes in the global nexus.db. Matching pairs are linked via
 * `code_reference` edges written to brain_page_edges in brain.db.
 *
 * Design constraints:
 * - brain.db is read-write (edges written here).
 * - nexus.db is READ-ONLY from this module — never mutated.
 * - All operations are BEST-EFFORT; failures never surface to callers.
 * - Cross-DB join is handled in-process: read nexus nodes, then write brain edges.
 * - Entity matching: exact match on filePath or symbol name; fuzzy match on
 *   symbol name (case-insensitive substring, minimum 4 chars).
 *
 * @task graph-memory-bridge
 * @epic T523
 */

import type { BrainNodeType } from '../store/brain-schema.js';
import { brainPageEdges, brainPageNodes } from '../store/brain-schema.js';
import { getBrainDb, getBrainNativeDb } from '../store/brain-sqlite.js';
import { getNexusDb, getNexusNativeDb } from '../store/nexus-sqlite.js';
import { typedAll } from '../store/typed-query.js';

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** A single code-reference link created or found by the bridge. */
export interface CodeReferenceLink {
  /** Brain memory node ID (format: '<type>:<source-id>'). */
  brainNodeId: string;
  /** Nexus node ID (format: '<filePath>::<name>' or '<filePath>'). */
  nexusNodeId: string;
  /** Human-readable nexus node label. */
  nexusLabel: string;
  /** Match strategy used: 'exact-file', 'exact-symbol', or 'fuzzy-symbol'. */
  matchStrategy: 'exact-file' | 'exact-symbol' | 'fuzzy-symbol';
  /** Edge weight (exact matches = 1.0, fuzzy = 0.6). */
  weight: number;
}

/** Summary result from autoLinkMemories. */
export interface AutoLinkResult {
  /** Total brain entries scanned for entity references. */
  scanned: number;
  /** Number of new code_reference edges created. */
  linked: number;
  /** Number of links that already existed (skipped). */
  alreadyLinked: number;
  /** Individual links created in this run. */
  links: CodeReferenceLink[];
}

/** Result from queryMemoriesForCode. */
export interface MemoriesForCodeResult {
  /** The nexus node ID that was queried. */
  nexusNodeId: string;
  /** Brain memory nodes reachable from this code node. */
  memories: Array<{
    nodeId: string;
    nodeType: string;
    label: string;
    qualityScore: number;
    edgeWeight: number;
    matchStrategy: string;
  }>;
}

/** Result from queryCodeForMemory. */
export interface CodeForMemoryResult {
  /** The brain memory node ID that was queried. */
  brainNodeId: string;
  /** Nexus code nodes reachable from this memory node. */
  codeNodes: Array<{
    nexusNodeId: string;
    label: string;
    filePath: string | null;
    kind: string;
    edgeWeight: number;
    matchStrategy: string;
  }>;
}

// ---------------------------------------------------------------------------
// Internal raw row types
// ---------------------------------------------------------------------------

interface RawBrainNode {
  id: string;
  node_type: string;
  label: string;
  quality_score: number;
  metadata_json: string | null;
}

interface RawNexusNode {
  id: string;
  label: string;
  name: string | null;
  file_path: string | null;
  kind: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Regex patterns to extract entity references from text.
 *
 * Matches:
 * - File paths: relative paths ending in known source extensions
 * - Function/symbol names: camelCase, PascalCase, snake_case identifiers (≥4 chars)
 */
const FILE_PATH_PATTERN =
  /(?:^|\s|['"`(])([a-zA-Z0-9_\-./]+\.(?:ts|tsx|js|jsx|rs|go|py|mjs|cjs))(?:$|\s|['"`)])/g;

const SYMBOL_PATTERN =
  /\b([a-zA-Z_][a-zA-Z0-9_]*(?:[A-Z][a-zA-Z0-9_]*)+|[a-zA-Z_]{4,}[a-zA-Z0-9_]*)\b/g;

/** Common stop-words to skip in symbol extraction (short-circuits false positives). */
const SYMBOL_STOP_WORDS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'const',
  'async',
  'await',
  'return',
  'export',
  'import',
  'from',
  'type',
  'interface',
  'function',
  'class',
  'this',
  'super',
  'extends',
  'implements',
  'with',
  'that',
  'then',
  'when',
  'have',
  'been',
  'will',
  'should',
  'could',
  'would',
  'error',
  'result',
  'value',
  'data',
  'info',
  'note',
  'todo',
  'done',
  'fail',
  'pass',
]);

/**
 * Extract file paths from text.
 */
function extractFilePaths(text: string): string[] {
  const paths = new Set<string>();
  for (const m of text.matchAll(FILE_PATH_PATTERN)) {
    const p = m[1];
    if (p) paths.add(p);
  }
  return Array.from(paths);
}

/**
 * Extract potential symbol names from text (camelCase / PascalCase / snake_case ≥ 4 chars).
 */
function extractSymbolCandidates(text: string): string[] {
  const syms = new Set<string>();
  for (const m of text.matchAll(SYMBOL_PATTERN)) {
    const s = m[1];
    if (s && s.length >= 4 && !SYMBOL_STOP_WORDS.has(s.toLowerCase())) {
      syms.add(s);
    }
  }
  return Array.from(syms);
}

/**
 * Build a plain-text corpus from a brain_page_nodes metadata_json blob.
 * Returns empty string if metadata is absent or malformed.
 */
function metadataText(metaJson: string | null): string {
  if (!metaJson) return '';
  try {
    const obj = JSON.parse(metaJson) as Record<string, unknown>;
    return Object.values(obj)
      .filter((v) => typeof v === 'string')
      .join(' ');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// linkMemoryToCode — manual single-link creation
// ---------------------------------------------------------------------------

/**
 * Create a `code_reference` edge from a brain memory node to a nexus code node.
 *
 * Writes to brain_page_edges (brain.db). The nexus node must already exist in
 * nexus.db but is never mutated. The brain node is upserted as a stub if it
 * does not yet exist in brain_page_nodes.
 *
 * This function is idempotent — calling it multiple times with the same
 * (memoryId, codeSymbol) pair is safe (the composite PK prevents duplicates).
 *
 * @param projectRoot - Absolute path to project root (locates brain.db)
 * @param memoryId - Brain memory node ID (format: '<type>:<source-id>')
 * @param codeSymbol - Nexus node ID (format: '<filePath>::<name>' or '<filePath>')
 * @returns True if the edge was created or already existed; false on error
 */
export async function linkMemoryToCode(
  projectRoot: string,
  memoryId: string,
  codeSymbol: string,
): Promise<boolean> {
  try {
    const brainDb = await getBrainDb(projectRoot);

    // Ensure nexus.db is initialized so we can verify the target node exists
    await getNexusDb();
    const nexusNative = getNexusNativeDb();

    if (!nexusNative) return false;

    // Verify the nexus node exists (read-only check)
    const nexusNode = nexusNative
      .prepare('SELECT id, label, file_path, kind FROM nexus_nodes WHERE id = ? LIMIT 1')
      .get(codeSymbol) as
      | { id: string; label: string; file_path: string | null; kind: string }
      | undefined;

    if (!nexusNode) return false;

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Upsert the memory node stub in brain_page_nodes so the edge FK is satisfied
    // (the real node may already exist from graph-auto-populate; onConflictDoUpdate
    //  only refreshes lastActivityAt if the node already exists).
    const idParts = memoryId.split(':');
    const nodeType = (idParts[0] as BrainNodeType) ?? 'observation';

    await brainDb
      .insert(brainPageNodes)
      .values({
        id: memoryId,
        nodeType,
        label: memoryId,
        qualityScore: 0.5,
        contentHash: null,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: brainPageNodes.id,
        set: { lastActivityAt: now, updatedAt: now },
      });

    // Write the code_reference edge ('code_reference' is now in BRAIN_EDGE_TYPES — T645)
    await brainDb
      .insert(brainPageEdges)
      .values({
        fromId: memoryId,
        toId: codeSymbol,
        edgeType: 'code_reference',
        weight: 1.0,
        provenance: 'manual',
        createdAt: now,
      })
      .onConflictDoNothing();

    return true;
  } catch (err) {
    console.warn('[graph-memory-bridge] linkMemoryToCode failed:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// autoLinkMemories — scan brain nodes and link to nexus matches
// ---------------------------------------------------------------------------

/**
 * Scan brain memory nodes for entity references and match them against nexus.
 *
 * For each brain node, extracts:
 * - File path references → matched against nexus_nodes.file_path (exact)
 * - Symbol name references → matched against nexus_nodes.name (exact, then fuzzy)
 *
 * Matching edges are written to brain_page_edges with edgeType='code_reference'.
 * This function is idempotent — existing edges are skipped.
 *
 * Should be called from runConsolidation() as a best-effort step. All errors
 * are caught and logged; never throws.
 *
 * @param projectRoot - Absolute path to project root (locates brain.db)
 * @returns Summary of scanned entries and created links
 */
export async function autoLinkMemories(projectRoot: string): Promise<AutoLinkResult> {
  const result: AutoLinkResult = { scanned: 0, linked: 0, alreadyLinked: 0, links: [] };

  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();

    await getNexusDb();
    const nexusNative = getNexusNativeDb();

    if (!brainNative || !nexusNative) return result;

    // Load all brain page nodes that are memory entity types
    const brainNodes = typedAll<RawBrainNode>(
      brainNative.prepare(`
        SELECT id, node_type, label, quality_score, metadata_json
        FROM brain_page_nodes
        WHERE node_type IN ('observation', 'decision', 'pattern', 'learning')
          AND quality_score >= 0.3
        ORDER BY quality_score DESC
        LIMIT 500
      `),
    );

    result.scanned = brainNodes.length;

    if (brainNodes.length === 0) return result;

    // Load nexus nodes into memory (indexed by name and filePath for fast lookup).
    // We load only essential columns to keep memory usage low.
    const nexusNodes = typedAll<RawNexusNode>(
      nexusNative.prepare(`
        SELECT id, label, name, file_path, kind
        FROM nexus_nodes
        WHERE kind NOT IN ('community', 'process', 'folder')
        LIMIT 20000
      `),
    );

    if (nexusNodes.length === 0) return result;

    // Build lookup indexes
    const byFilePath = new Map<string, RawNexusNode[]>();
    const byNameExact = new Map<string, RawNexusNode[]>();
    const byNameLower = new Map<string, RawNexusNode[]>();

    for (const node of nexusNodes) {
      if (node.file_path) {
        const fp = node.file_path.toLowerCase();
        const existing = byFilePath.get(fp) ?? [];
        existing.push(node);
        byFilePath.set(fp, existing);
      }
      if (node.name) {
        // Exact (case-sensitive)
        const exact = byNameExact.get(node.name) ?? [];
        exact.push(node);
        byNameExact.set(node.name, exact);
        // Lowercase for fuzzy
        const lower = node.name.toLowerCase();
        const fuzzy = byNameLower.get(lower) ?? [];
        fuzzy.push(node);
        byNameLower.set(lower, fuzzy);
      }
    }

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Load existing code_reference edges to avoid duplicates
    const existingEdges = new Set<string>();
    const rawEdges = typedAll<{ from_id: string; to_id: string }>(
      brainNative.prepare(`
        SELECT from_id, to_id FROM brain_page_edges WHERE edge_type = 'code_reference'
      `),
    );
    for (const e of rawEdges) {
      existingEdges.add(`${e.from_id}|${e.to_id}`);
    }

    // Process each brain node
    for (const brainNode of brainNodes) {
      const corpus = `${brainNode.label} ${metadataText(brainNode.metadata_json)}`;

      const filePaths = extractFilePaths(corpus);
      const symbolCandidates = extractSymbolCandidates(corpus);

      const candidates: Array<{
        nexusNode: RawNexusNode;
        strategy: CodeReferenceLink['matchStrategy'];
        weight: number;
      }> = [];

      // 1. Exact file path matches
      for (const fp of filePaths) {
        const matches = byFilePath.get(fp.toLowerCase());
        if (matches) {
          for (const n of matches) {
            candidates.push({ nexusNode: n, strategy: 'exact-file', weight: 1.0 });
          }
        }
      }

      // 2. Exact symbol name matches
      for (const sym of symbolCandidates) {
        const exactMatches = byNameExact.get(sym);
        if (exactMatches) {
          for (const n of exactMatches) {
            candidates.push({ nexusNode: n, strategy: 'exact-symbol', weight: 1.0 });
          }
        }
      }

      // 3. Fuzzy (case-insensitive) symbol matches — only for symbols not already exact-matched
      const exactSymSet = new Set(
        symbolCandidates.flatMap((s) => byNameExact.get(s) ?? []).map((n) => n.id),
      );
      for (const sym of symbolCandidates) {
        if (sym.length < 5) continue; // skip very short symbols for fuzzy
        const lower = sym.toLowerCase();
        const fuzzyMatches = byNameLower.get(lower);
        if (fuzzyMatches) {
          for (const n of fuzzyMatches) {
            if (!exactSymSet.has(n.id)) {
              candidates.push({ nexusNode: n, strategy: 'fuzzy-symbol', weight: 0.6 });
            }
          }
        }
      }

      // Deduplicate candidates (keep highest weight per nexus node)
      const bestByNexusId = new Map<string, (typeof candidates)[number]>();
      for (const c of candidates) {
        const existing = bestByNexusId.get(c.nexusNode.id);
        if (!existing || c.weight > existing.weight) {
          bestByNexusId.set(c.nexusNode.id, c);
        }
      }

      // Write edges (cap at 10 per brain node to avoid noise)
      const sortedCandidates = Array.from(bestByNexusId.values())
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 10);

      for (const { nexusNode, strategy, weight } of sortedCandidates) {
        const edgeKey = `${brainNode.id}|${nexusNode.id}`;

        if (existingEdges.has(edgeKey)) {
          result.alreadyLinked++;
          continue;
        }

        // Upsert brain node stub (idempotent — real node may already exist)
        brainNative
          .prepare(`
            INSERT OR IGNORE INTO brain_page_nodes
              (id, node_type, label, quality_score, content_hash, metadata_json, last_activity_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
          `)
          .run(
            brainNode.id,
            brainNode.node_type,
            brainNode.label,
            brainNode.quality_score,
            now,
            now,
            now,
          );

        // Write edge
        try {
          brainNative
            .prepare(`
              INSERT OR IGNORE INTO brain_page_edges
                (from_id, to_id, edge_type, weight, provenance, created_at)
              VALUES (?, ?, 'code_reference', ?, ?, ?)
            `)
            .run(brainNode.id, nexusNode.id, weight, `auto:${strategy}`, now);

          existingEdges.add(edgeKey);
          result.linked++;
          result.links.push({
            brainNodeId: brainNode.id,
            nexusNodeId: nexusNode.id,
            nexusLabel: nexusNode.label,
            matchStrategy: strategy,
            weight,
          });
        } catch (edgeErr) {
          console.warn('[graph-memory-bridge] edge insert failed:', edgeErr);
        }
      }
    }
  } catch (err) {
    console.warn('[graph-memory-bridge] autoLinkMemories failed:', err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// queryMemoriesForCode — find memories related to a code symbol
// ---------------------------------------------------------------------------

/**
 * Given a code symbol (nexus node ID), find related brain memory nodes.
 *
 * Traverses `code_reference` edges in brain_page_edges where the target is
 * the given nexus node ID. Returns the brain memory nodes with edge metadata.
 *
 * @param projectRoot - Absolute path to project root (locates brain.db)
 * @param symbol - Nexus node ID (format: '<filePath>::<name>' or '<filePath>')
 * @returns Memory nodes that reference the given code symbol
 */
export async function queryMemoriesForCode(
  projectRoot: string,
  symbol: string,
): Promise<MemoriesForCodeResult> {
  const result: MemoriesForCodeResult = { nexusNodeId: symbol, memories: [] };

  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();

    if (!brainNative) return result;

    interface RawRow {
      id: string;
      node_type: string;
      label: string;
      quality_score: number;
      weight: number;
      provenance: string | null;
    }

    const rows = typedAll<RawRow>(
      brainNative.prepare(`
        SELECT n.id, n.node_type, n.label, n.quality_score,
               e.weight, e.provenance
        FROM brain_page_edges e
        JOIN brain_page_nodes n ON n.id = e.from_id
        WHERE e.to_id = ?
          AND e.edge_type = 'code_reference'
        ORDER BY e.weight DESC, n.quality_score DESC
        LIMIT 50
      `),
      symbol,
    );

    result.memories = rows.map((r) => ({
      nodeId: r.id,
      nodeType: r.node_type,
      label: r.label,
      qualityScore: r.quality_score,
      edgeWeight: r.weight,
      matchStrategy: r.provenance?.replace('auto:', '') ?? 'manual',
    }));
  } catch (err) {
    console.warn('[graph-memory-bridge] queryMemoriesForCode failed:', err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// queryCodeForMemory — find code nodes related to a memory entry
// ---------------------------------------------------------------------------

/**
 * Given a brain memory node ID, find related nexus code nodes.
 *
 * Traverses `code_reference` edges in brain_page_edges from the given memory
 * node ID, then fetches the corresponding nexus node metadata.
 *
 * @param projectRoot - Absolute path to project root (locates brain.db)
 * @param memoryId - Brain memory node ID (format: '<type>:<source-id>')
 * @returns Nexus code nodes referenced by the given memory entry
 */
export async function queryCodeForMemory(
  projectRoot: string,
  memoryId: string,
): Promise<CodeForMemoryResult> {
  const result: CodeForMemoryResult = { brainNodeId: memoryId, codeNodes: [] };

  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();

    await getNexusDb();
    const nexusNative = getNexusNativeDb();

    if (!brainNative || !nexusNative) return result;

    // Get all code_reference edge targets from brain.db
    interface RawBrainEdgeRow {
      to_id: string;
      weight: number;
      provenance: string | null;
    }

    const brainEdges = typedAll<RawBrainEdgeRow>(
      brainNative.prepare(`
        SELECT to_id, weight, provenance
        FROM brain_page_edges
        WHERE from_id = ?
          AND edge_type = 'code_reference'
        ORDER BY weight DESC
        LIMIT 50
      `),
      memoryId,
    );

    if (brainEdges.length === 0) return result;

    // Fetch nexus node metadata for each target (read-only)
    for (const edge of brainEdges) {
      const nexusNode = nexusNative
        .prepare('SELECT id, label, file_path, kind FROM nexus_nodes WHERE id = ? LIMIT 1')
        .get(edge.to_id) as
        | { id: string; label: string; file_path: string | null; kind: string }
        | undefined;

      if (nexusNode) {
        result.codeNodes.push({
          nexusNodeId: nexusNode.id,
          label: nexusNode.label,
          filePath: nexusNode.file_path,
          kind: nexusNode.kind,
          edgeWeight: edge.weight,
          matchStrategy: edge.provenance?.replace('auto:', '') ?? 'manual',
        });
      }
    }
  } catch (err) {
    console.warn('[graph-memory-bridge] queryCodeForMemory failed:', err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// listCodeLinks — show all code↔memory connections
// ---------------------------------------------------------------------------

/** A single code-memory link for display. */
export interface CodeLinkEntry {
  /** Brain memory node ID. */
  brainNodeId: string;
  /** Brain node type. */
  brainNodeType: string;
  /** Brain node label. */
  brainNodeLabel: string;
  /** Nexus code node ID. */
  nexusNodeId: string;
  /** Nexus node label. */
  nexusNodeLabel: string;
  /** File path in the nexus node (relative to project root). */
  filePath: string | null;
  /** Code kind (function, class, file, etc.). */
  kind: string;
  /** Edge weight. */
  weight: number;
  /** When the edge was created. */
  createdAt: string;
}

/**
 * Return all `code_reference` edges from brain.db enriched with nexus metadata.
 *
 * Used by `cleo memory code-links` CLI command.
 *
 * @param projectRoot - Absolute path to project root (locates brain.db)
 * @param limit - Maximum number of entries to return (default 100)
 * @returns Array of code link entries sorted by weight descending
 */
export async function listCodeLinks(projectRoot: string, limit = 100): Promise<CodeLinkEntry[]> {
  const entries: CodeLinkEntry[] = [];

  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();

    await getNexusDb();
    const nexusNative = getNexusNativeDb();

    if (!brainNative || !nexusNative) return entries;

    // Fetch all code_reference edges with brain node metadata
    interface RawRow {
      from_id: string;
      to_id: string;
      weight: number;
      created_at: string;
      node_type: string;
      label: string;
    }

    const rows = typedAll<RawRow>(
      brainNative.prepare(`
        SELECT e.from_id, e.to_id, e.weight, e.created_at,
               n.node_type, n.label
        FROM brain_page_edges e
        JOIN brain_page_nodes n ON n.id = e.from_id
        WHERE e.edge_type = 'code_reference'
        ORDER BY e.weight DESC, e.created_at DESC
        LIMIT ?
      `),
      limit,
    );

    for (const row of rows) {
      const nexusNode = nexusNative
        .prepare('SELECT id, label, file_path, kind FROM nexus_nodes WHERE id = ? LIMIT 1')
        .get(row.to_id) as
        | { id: string; label: string; file_path: string | null; kind: string }
        | undefined;

      entries.push({
        brainNodeId: row.from_id,
        brainNodeType: row.node_type,
        brainNodeLabel: row.label,
        nexusNodeId: row.to_id,
        nexusNodeLabel: nexusNode?.label ?? row.to_id,
        filePath: nexusNode?.file_path ?? null,
        kind: nexusNode?.kind ?? 'unknown',
        weight: row.weight,
        createdAt: row.created_at,
      });
    }
  } catch (err) {
    console.warn('[graph-memory-bridge] listCodeLinks failed:', err);
  }

  return entries;
}
