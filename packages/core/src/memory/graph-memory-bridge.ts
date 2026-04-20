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

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { getConduitDbPath } from '../store/conduit-sqlite.js';
import type { BrainNodeType } from '../store/memory-schema.js';
import { brainPageEdges, brainPageNodes } from '../store/memory-schema.js';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';
import { getNexusDb, getNexusNativeDb } from '../store/nexus-sqlite.js';
import { typedAll } from '../store/typed-query.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

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
// linkObservationToModifiedFiles — observation → files_modified_json
// ---------------------------------------------------------------------------

/**
 * Write `modified_by` edges from file nodes to observation nodes.
 *
 * For each file path in the observation's files_modified_json, finds the
 * corresponding file node in nexus_nodes and writes a `modified_by` edge.
 *
 * This function is idempotent — calling it multiple times is safe.
 *
 * @param obsId - Brain observation node ID (format: 'observation:<source-id>')
 * @param filesModifiedJson - JSON array of file paths (may be null)
 * @param projectRoot - Absolute path to project root
 * @param nexusNative - Optional pre-loaded nexus database handle
 * @returns Count of edges written
 */
export async function linkObservationToModifiedFiles(
  obsId: string,
  filesModifiedJson: string | null,
  projectRoot: string,
  nexusNative?: ReturnType<typeof getNexusNativeDb>,
): Promise<number> {
  let edgeCount = 0;

  if (!filesModifiedJson) return 0;

  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();
    if (!brainNative) return 0;

    const nexusDb = nexusNative ?? getNexusNativeDb();
    if (!nexusDb) return 0;

    const filesArray = JSON.parse(filesModifiedJson) as string[];
    if (!Array.isArray(filesArray)) return 0;

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    for (const filePath of filesArray) {
      if (!filePath || typeof filePath !== 'string') continue;

      // Find nexus node by exact file path match
      const nexusNode = nexusDb
        .prepare('SELECT id FROM nexus_nodes WHERE file_path = ? LIMIT 1')
        .get(filePath) as { id: string } | undefined;

      if (!nexusNode) continue;

      // Write modified_by edge (file → observation)
      try {
        brainNative
          .prepare(`
            INSERT OR IGNORE INTO brain_page_edges
              (from_id, to_id, edge_type, weight, provenance, created_at)
            VALUES (?, ?, 'modified_by', 1.0, 'auto:file-modify', ?)
          `)
          .run(nexusNode.id, obsId, now);
        edgeCount++;
      } catch (err) {
        console.warn('[graph-memory-bridge] modified_by edge insert failed:', err);
      }
    }
  } catch (err) {
    console.warn('[graph-memory-bridge] linkObservationToModifiedFiles failed:', err);
  }

  return edgeCount;
}

// ---------------------------------------------------------------------------
// linkObservationToMentionedSymbols — observation text → symbol NER
// ---------------------------------------------------------------------------

/**
 * Write `mentions` edges from observation nodes to symbol nodes found in text.
 *
 * Scans the observation text for symbol names present in nexus_nodes using
 * case-sensitive word-boundary matching. Caps results at 20 matches per
 * observation to prevent runaway on large-text observations.
 *
 * This function is idempotent — calling it multiple times is safe.
 *
 * @param obsId - Brain observation node ID
 * @param text - Text content to scan for symbol names
 * @param projectRoot - Absolute path to project root
 * @param nexusNative - Optional pre-loaded nexus database handle
 * @returns Count of edges written
 */
export async function linkObservationToMentionedSymbols(
  obsId: string,
  text: string,
  projectRoot: string,
  nexusNative?: ReturnType<typeof getNexusNativeDb>,
): Promise<number> {
  let edgeCount = 0;

  if (!text || text.length === 0) return 0;

  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();
    if (!brainNative) return 0;

    const nexusDb = nexusNative ?? getNexusNativeDb();
    if (!nexusDb) return 0;

    // Load all nexus node names into memory
    interface RawNexusName {
      id: string;
      name: string;
    }

    const nexusNames = typedAll<RawNexusName>(
      nexusDb.prepare('SELECT id, name FROM nexus_nodes WHERE name IS NOT NULL LIMIT 10000'),
    );

    if (nexusNames.length === 0) return 0;

    // Build a set of symbol names for fast lookup
    const symbolNameSet = new Set(nexusNames.map((n) => n.name));
    const symbolNames = Array.from(symbolNameSet);

    // Extract symbol candidates from text using word boundaries
    const candidates: string[] = [];
    for (const name of symbolNames) {
      // Case-sensitive word-boundary match
      const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (pattern.test(text)) {
        candidates.push(name);
      }
    }

    // Cap at 20 matches per observation to prevent noise
    const matches = candidates.slice(0, 20);

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Write mentions edges
    for (const name of matches) {
      const nexusNode = nexusNames.find((n) => n.name === name);
      if (!nexusNode) continue;

      try {
        brainNative
          .prepare(`
            INSERT OR IGNORE INTO brain_page_edges
              (from_id, to_id, edge_type, weight, provenance, created_at)
            VALUES (?, ?, 'mentions', 1.0, 'auto:symbol-ner', ?)
          `)
          .run(obsId, nexusNode.id, now);
        edgeCount++;
      } catch (err) {
        console.warn('[graph-memory-bridge] mentions edge insert failed:', err);
      }
    }
  } catch (err) {
    console.warn('[graph-memory-bridge] linkObservationToMentionedSymbols failed:', err);
  }

  return edgeCount;
}

// ---------------------------------------------------------------------------
// linkDecisionToSymbols — decision context → symbol NER
// ---------------------------------------------------------------------------

/**
 * Write `documents` edges from decision nodes to symbol nodes found in context.
 *
 * Scans the decision's context text for symbol names present in nexus_nodes.
 * Same NER pattern as linkObservationToMentionedSymbols but for decisions.
 * Caps results at 20 matches per decision to prevent runaway.
 *
 * This function is idempotent — calling it multiple times is safe.
 *
 * @param decisionId - Brain decision node ID (format: 'decision:D-<id>')
 * @param contextText - Context/rationale text to scan for symbol names
 * @param projectRoot - Absolute path to project root
 * @param nexusNative - Optional pre-loaded nexus database handle
 * @returns Count of edges written
 */
export async function linkDecisionToSymbols(
  decisionId: string,
  contextText: string,
  projectRoot: string,
  nexusNative?: ReturnType<typeof getNexusNativeDb>,
): Promise<number> {
  let edgeCount = 0;

  if (!contextText || contextText.length === 0) return 0;

  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();
    if (!brainNative) return 0;

    const nexusDb = nexusNative ?? getNexusNativeDb();
    if (!nexusDb) return 0;

    // Load all nexus node names into memory
    interface RawNexusName {
      id: string;
      name: string;
    }

    const nexusNames = typedAll<RawNexusName>(
      nexusDb.prepare('SELECT id, name FROM nexus_nodes WHERE name IS NOT NULL LIMIT 10000'),
    );

    if (nexusNames.length === 0) return 0;

    // Build a set of symbol names for fast lookup
    const symbolNameSet = new Set(nexusNames.map((n) => n.name));
    const symbolNames = Array.from(symbolNameSet);

    // Extract symbol candidates from text using word boundaries
    const candidates: string[] = [];
    for (const name of symbolNames) {
      // Case-sensitive word-boundary match
      const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (pattern.test(contextText)) {
        candidates.push(name);
      }
    }

    // Cap at 20 matches per decision to prevent noise
    const matches = candidates.slice(0, 20);

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Write documents edges
    for (const name of matches) {
      const nexusNode = nexusNames.find((n) => n.name === name);
      if (!nexusNode) continue;

      try {
        brainNative
          .prepare(`
            INSERT OR IGNORE INTO brain_page_edges
              (from_id, to_id, edge_type, weight, provenance, created_at)
            VALUES (?, ?, 'documents', 1.0, 'auto:decision-ner', ?)
          `)
          .run(decisionId, nexusNode.id, now);
        edgeCount++;
      } catch (err) {
        console.warn('[graph-memory-bridge] documents edge insert failed:', err);
      }
    }
  } catch (err) {
    console.warn('[graph-memory-bridge] linkDecisionToSymbols failed:', err);
  }

  return edgeCount;
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
 * - Files modified (observations) → writes modified_by edges via linkObservationToModifiedFiles
 * - Symbol mentions (observations/decisions) → writes mentions/documents edges via symbol NER
 *
 * Matching edges are written to brain_page_edges with edge types: code_reference, modified_by,
 * mentions, documents. This function is idempotent — existing edges are skipped.
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

    // Process specialized edge writers for observations and decisions
    try {
      // Link observations to modified files
      interface RawObservation {
        id: string;
        files_modified_json: string | null;
        narrative: string | null;
      }

      const observations = typedAll<RawObservation>(
        brainNative.prepare(`
          SELECT id, files_modified_json, narrative
          FROM brain_observations
          WHERE quality_score >= 0.3
          LIMIT 200
        `),
      );

      for (const obs of observations) {
        if (obs.files_modified_json) {
          const edgesWritten = await linkObservationToModifiedFiles(
            `observation:${obs.id}`,
            obs.files_modified_json,
            projectRoot,
            nexusNative,
          );
          result.linked += edgesWritten;
        }

        if (obs.narrative) {
          const edgesWritten = await linkObservationToMentionedSymbols(
            `observation:${obs.id}`,
            obs.narrative,
            projectRoot,
            nexusNative,
          );
          result.linked += edgesWritten;
        }
      }

      // Link decisions to symbols in context
      interface RawDecision {
        id: string;
        decision: string | null;
        rationale: string | null;
      }

      const decisions = typedAll<RawDecision>(
        brainNative.prepare(`
          SELECT id, decision, rationale
          FROM brain_decisions
          WHERE quality_score >= 0.3
          LIMIT 200
        `),
      );

      for (const dec of decisions) {
        // Combine decision and rationale text for context analysis
        const contextText = `${dec.decision ?? ''} ${dec.rationale ?? ''}`;
        if (contextText.trim().length > 0) {
          const edgesWritten = await linkDecisionToSymbols(
            `decision:${dec.id}`,
            contextText,
            projectRoot,
            nexusNative,
          );
          result.linked += edgesWritten;
        }
      }
    } catch (err) {
      console.warn('[graph-memory-bridge] specialized edge writers failed:', err);
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

// ---------------------------------------------------------------------------
// linkConduitMessagesToSymbols — conduit→nexus ingestion (T1071)
// ---------------------------------------------------------------------------

/**
 * Result from linkConduitMessagesToSymbols.
 */
export interface ConduitSymbolLinkResult {
  /** Number of new `conduit_mentions_symbol` edges created. */
  linked: number;
  /** Total messages scanned. */
  scanned: number;
}

/**
 * Scan conduit.messages for symbol name mentions and link them to nexus_nodes.
 *
 * Scope per HITL-4:
 * - Query messages where `attachments != '[]'` OR `content` FTS5-matches symbol names
 * - Build symbolNames FTS query from top 200 nexus nodes (most plastically weighted)
 * - For each matched message, write `conduit_mentions_symbol` edges to brain_page_edges
 * - Idempotent via UNIQUE (source, target, type) constraint
 *
 * Gracefully no-ops if:
 * - conduit.db file does not exist (not initialized)
 * - nexus.db is unavailable
 *
 * All errors are caught and logged; never throws.
 *
 * @param projectRoot - Absolute path to project root (locates conduit.db)
 * @returns Summary of scanned messages and created edges
 * @task T1071
 * @epic T1042
 */
export async function linkConduitMessagesToSymbols(
  projectRoot: string,
): Promise<ConduitSymbolLinkResult> {
  const result: ConduitSymbolLinkResult = { linked: 0, scanned: 0 };

  try {
    // Check if conduit.db exists
    const conduitDbPath = getConduitDbPath(projectRoot);
    if (!existsSync(conduitDbPath)) {
      return result; // Graceful no-op
    }

    // Open conduit.db (read-only for this operation)
    const conduitDb = new DatabaseSync(conduitDbPath);
    try {
      // Ensure brain.db is available for edge writes
      await getBrainDb(projectRoot);
      const brainNative = getBrainNativeDb();

      // Ensure nexus.db is available for symbol lookup
      await getNexusDb();
      const nexusNative = getNexusNativeDb();

      if (!brainNative || !nexusNative) return result;

      // Load top 200 nexus nodes ordered by plasticity weight (or name frequency as fallback)
      // We use the most-accessed/weighted symbols to bound FTS query size
      interface RawNexusSymbol {
        id: string;
        name: string | null;
        label: string;
      }

      const topSymbols = typedAll<RawNexusSymbol>(
        nexusNative.prepare(`
          SELECT id, name, label
          FROM nexus_nodes
          WHERE name IS NOT NULL AND name != ''
          AND kind NOT IN ('community', 'process', 'folder')
          ORDER BY weight DESC NULLS LAST, name ASC
          LIMIT 200
        `),
      );

      if (topSymbols.length === 0) return result;

      // Build FTS query: "symbol1" OR "symbol2" OR ... (escaped for FTS5)
      // Collect all symbol names for matching
      const symbolNames = new Set<string>();
      const symbolMap = new Map<string, RawNexusSymbol>(); // Map name -> first node with that name

      for (const sym of topSymbols) {
        if (sym.name) {
          symbolNames.add(sym.name);
          if (!symbolMap.has(sym.name)) {
            symbolMap.set(sym.name, sym);
          }
        }
      }

      if (symbolNames.size === 0) return result;

      // Build FTS query: quoted terms OR'd together
      const ftsQuery = Array.from(symbolNames)
        .map((name) => `"${name.replace(/"/g, '""')}"`)
        .join(' OR ');

      // Query conduit messages: attachments != '[]' OR content matches FTS
      interface RawConduitMessage {
        id: string;
        content: string;
        attachments: string;
      }

      const messages = typedAll<RawConduitMessage>(
        conduitDb.prepare(`
          SELECT id, content, attachments
          FROM messages
          WHERE attachments != '[]'
             OR id IN (SELECT rowid FROM messages_fts WHERE content MATCH ?)
          LIMIT 10000
        `),
        ftsQuery,
      );

      result.scanned = messages.length;

      if (messages.length === 0) return result;

      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      let edgesCreated = 0;

      // For each message, scan content and attachments for symbol mentions
      for (const msg of messages) {
        const corpus = `${msg.content}`;

        for (const [symbolName, nexusNode] of symbolMap.entries()) {
          // Case-insensitive check: does the symbol name appear in the message?
          const corpusLower = corpus.toLowerCase();
          const nameLower = symbolName.toLowerCase();

          if (corpusLower.includes(nameLower)) {
            const messageNodeId = `conduit:${msg.id}`;

            try {
              // Upsert a stub node for the message in brain_page_nodes (idempotent)
              brainNative
                .prepare(`
                  INSERT OR IGNORE INTO brain_page_nodes
                    (id, node_type, label, quality_score, content_hash, metadata_json, last_activity_at, created_at, updated_at)
                  VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
                `)
                .run(
                  messageNodeId,
                  'observation',
                  `Conduit message: ${msg.id}`,
                  0.5,
                  now,
                  now,
                  now,
                );

              // Write the conduit_mentions_symbol edge (idempotent via INSERT OR IGNORE)
              brainNative
                .prepare(`
                  INSERT OR IGNORE INTO brain_page_edges
                    (from_id, to_id, edge_type, weight, provenance, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)
                `)
                .run(
                  messageNodeId,
                  nexusNode.id,
                  'conduit_mentions_symbol',
                  1.0,
                  'auto:conduit-fts',
                  now,
                );

              edgesCreated++;
            } catch (edgeErr) {
              console.warn('[graph-memory-bridge] conduit edge insert failed:', edgeErr);
            }

            // Only link once per message per symbol (continue to next symbol)
            break;
          }
        }
      }

      result.linked = edgesCreated;
    } finally {
      try {
        if (conduitDb.isOpen) {
          conduitDb.close();
        }
      } catch {
        // Ignore close errors
      }
    }
  } catch (err) {
    console.warn('[graph-memory-bridge] linkConduitMessagesToSymbols failed:', err);
  }

  return result;
}
