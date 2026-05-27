/**
 * Decision cross-link module for CLEO BRAIN.
 *
 * Extracts file paths and symbol names referenced in a decision's text and
 * rationale, then creates `affects` edges from the decision graph node to
 * matching `file` / `symbol` nodes in brain_page_nodes.  This implements
 * the cross-substrate edge described in
 * docs/plans/brain-synaptic-visualization-research.md §3.2.
 *
 * All database operations are best-effort — they never throw or block the
 * caller.  Nodes for referenced files / symbols are upserted on demand so
 * the graph remains consistent even when the target has not yet been
 * independently indexed.
 *
 * @task T626
 * @epic T626
 */

import { addGraphEdge, upsertGraphNode } from './graph-auto-populate.js';

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** A reference extracted from a decision or rationale string. */
export interface ExtractedRef {
  /** Raw text that matched. */
  raw: string;
  /** Resolved graph node ID: 'file:<path>' or 'symbol:<name>'. */
  nodeId: string;
  /** Discriminated node type. */
  nodeType: 'file' | 'symbol';
  /** Human-readable label for the graph node. */
  label: string;
}

/**
 * Regex patterns used to locate file paths and symbol names inside text.
 *
 * File-path pattern — matches:
 *   - Relative paths:   `src/store/memory-schema.ts`
 *   - Absolute paths:   `/mnt/projects/cleocode/packages/core/src/…`
 *   - Extension-gated:  only `.ts`, `.tsx`, `.js`, `.jsx`, `.rs`, `.json`
 *
 * Symbol pattern — matches:
 *   - PascalCase class/interface names: `BrainPageNodes`
 *   - camelCase function names at word boundaries: `upsertGraphNode`
 *   - snake_case identifiers: `brain_page_edges`
 *
 * Overlapping matches are deduplicated by nodeId before edge creation.
 */

const FILE_PATH_RE =
  /(?:^|[\s`"'([\]{,])((\/[\w.\-/]+|[\w.-]+(?:\/[\w.-]+)+)\.(ts|tsx|js|jsx|rs|json))(?=$|[\s`"')[\]{,])/gm;

const SYMBOL_RE =
  /(?<![`"'/\w.])(?:[A-Z][a-zA-Z0-9]{2,}|[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+|[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*){2,})(?![`"'/\w])/g;

/**
 * Extract file-path and symbol references from free-form text.
 *
 * Symbols shorter than 4 characters or matching common English stop-words
 * are filtered to reduce noise.
 *
 * @param text - Decision text and/or rationale to scan.
 * @returns Deduplicated array of extracted references.
 */
export function extractReferencedSymbols(text: string): ExtractedRef[] {
  const seen = new Set<string>();
  const refs: ExtractedRef[] = [];

  // --- File paths ---
  for (const match of text.matchAll(FILE_PATH_RE)) {
    const raw = match[1];
    if (!raw) continue;
    const nodeId = `file:${raw}`;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    refs.push({ raw, nodeId, nodeType: 'file', label: raw });
  }

  // --- Symbol names ---
  for (const match of text.matchAll(SYMBOL_RE)) {
    const raw = match[0];
    if (!raw || raw.length < 4) continue;
    if (SYMBOL_STOP_WORDS.has(raw.toLowerCase())) continue;
    const nodeId = `symbol:${raw}`;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    refs.push({ raw, nodeId, nodeType: 'symbol', label: raw });
  }

  return refs;
}

/**
 * Common English / technical words that look like camelCase or PascalCase
 * symbols but carry no meaningful code reference.  Filtered out to keep the
 * extracted reference set signal-rich.
 */
const SYMBOL_STOP_WORDS = new Set([
  'this',
  'that',
  'with',
  'from',
  'into',
  'when',
  'then',
  'also',
  'both',
  'each',
  'such',
  'over',
  'after',
  'before',
  'always',
  'never',
  'should',
  'must',
  'will',
  'would',
  'could',
  'have',
  'been',
  'there',
  'their',
  'they',
  'them',
  'these',
  'those',
  'some',
  'only',
  'just',
  'more',
  'most',
  'many',
  'much',
  'well',
  'very',
  'here',
  'where',
  'which',
  'what',
  'why',
  'how',
  'the',
  'and',
  'but',
  'for',
  'not',
  'are',
  'was',
  'were',
  'has',
  'had',
  'its',
  'the',
  'data',
  'true',
  'false',
  'null',
  'none',
  'type',
  'test',
  'spec',
  'todo',
  'fixme',
  'note',
  'example',
  'index',
  'config',
  'error',
  'value',
  'input',
  'output',
  'result',
  'return',
  'default',
  'source',
  'target',
  'import',
  'export',
  'class',
  'interface',
  'function',
  'const',
  'async',
  'await',
]);

// ---------------------------------------------------------------------------
// Edge creation
// ---------------------------------------------------------------------------

/**
 * Create `affects` edges from a decision graph node to every referenced
 * file / symbol node.
 *
 * For each reference:
 *  1. Upsert the target node (file or symbol) so the graph stays consistent.
 *  2. Insert an `applies_to` edge from `decision:<id>` to the target node.
 *
 * All writes are best-effort via {@link upsertGraphNode} and
 * {@link addGraphEdge} — failures are swallowed internally.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param decisionId  - The decision ID (e.g. `D001`).
 * @param refs        - Extracted references returned by {@link extractReferencedSymbols}.
 */
export async function linkDecisionToTargets(
  projectRoot: string,
  decisionId: string,
  refs: ExtractedRef[],
): Promise<void> {
  const fromId = `decision:${decisionId}`;

  const writes = refs.map(async (ref) => {
    // Upsert the target node so the edge has a valid destination even if the
    // file / symbol has not been independently indexed yet.
    await upsertGraphNode(
      projectRoot,
      ref.nodeId,
      ref.nodeType,
      ref.label,
      0.5, // placeholder quality until nexus indexes it
      ref.raw,
    );

    await addGraphEdge(
      projectRoot,
      fromId,
      ref.nodeId,
      'applies_to',
      1.0,
      'auto:decision-cross-link',
    );
  });

  // Fire all writes concurrently — individual failures are swallowed inside
  // upsertGraphNode / addGraphEdge.
  await Promise.allSettled(writes);
}

// ---------------------------------------------------------------------------
// Convenience facade
// ---------------------------------------------------------------------------

/**
 * Extract file/symbol references from a decision and create `applies_to`
 * edges in the brain graph.  Combines {@link extractReferencedSymbols} and
 * {@link linkDecisionToTargets} in one call.
 *
 * This is the function wired into {@link storeDecision} after a new decision
 * is saved.  It is always fire-and-forget: the caller should NOT await it
 * when used inside the decision write path.
 *
 * @param projectRoot  - Absolute path to the project root directory.
 * @param decisionId   - The saved decision ID (e.g. `D001`).
 * @param decisionText - Full decision text.
 * @param rationale    - Full rationale text.
 */
export async function autoCrossLinkDecision(
  projectRoot: string,
  decisionId: string,
  decisionText: string,
  rationale: string,
): Promise<void> {
  try {
    const combined = `${decisionText} ${rationale}`;
    const refs = extractReferencedSymbols(combined);
    if (refs.length === 0) return;
    await linkDecisionToTargets(projectRoot, decisionId, refs);
  } catch {
    /* best-effort — never surface errors to caller */
  }
}
