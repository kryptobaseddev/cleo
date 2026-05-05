/**
 * Access processor — Phase 3f of the code intelligence ingestion pipeline.
 *
 * Walks tree-sitter ASTs to detect field/property accesses and emits ACCESSES
 * graph edges. Fills the gap identified in the T1042 audit (T1844-2): the
 * `accesses` edge type was declared in `@cleocode/contracts` but no extractor
 * produced it.
 *
 * Extraction strategy:
 * - **Read access** (`member_expression`): Any `object.field` expression that
 *   is not the left-hand side of an assignment emits an ACCESSES edge with
 *   `accessMode: 'read'`.
 * - **Write access** (`assignment_expression` / `assignment` whose left side
 *   is a `member_expression`): emits `accessMode: 'write'`.
 * - **Read-write**: When the same source→target pair occurs as both read and
 *   write within the same enclosing scope, the pair is collapsed to
 *   `accessMode: 'readwrite'`.
 *
 * Resolution strategy follows the same tiered approach as `call-processor.ts`:
 * - Tier 1 (same-file): target symbol defined in the same file
 * - Tier 3 (global): target symbol found via global name lookup (exact match
 *   with single candidate only — ambiguous matches are skipped)
 *
 * Unresolved member names are still recorded in the {@link ExtractedAccess}
 * record so future waves can add cross-file resolution (Tier 2a).
 *
 * Confidence for ACCESSES edges: 0.8 (matches the value documented in
 * `packages/contracts/src/graph.ts`).
 *
 * @task T1837
 * @module pipeline/processors/access-processor
 */

import type { GraphRelation } from '@cleocode/contracts';
import type { KnowledgeGraph } from '../knowledge-graph.js';
import { TIER_CONFIDENCE } from '../resolution-context.js';
import type { SymbolTable } from '../symbol-table.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The access mode for a member expression.
 *
 * - `'read'`  — value of the member is consumed (`obj.field` on the right-hand
 *               side of an expression, or standalone)
 * - `'write'` — the member is assigned to (`obj.field = value`)
 * - `'readwrite'` — the same source→target pair appears with both modes in the
 *                   same enclosing scope (collapsed during deduplication)
 */
export type AccessMode = 'read' | 'write' | 'readwrite';

/**
 * A member-access site extracted from the AST, ready for resolution into an
 * ACCESSES graph edge.
 *
 * Covers both read accesses (`obj.field`) and write accesses
 * (`obj.field = value`). The `accessMode` field distinguishes the two.
 */
export interface ExtractedAccess {
  /** File where the access appears (relative to repo root). */
  filePath: string;
  /**
   * Node ID of the enclosing function/method.
   * Falls back to `<filePath>::__file__` for module-level accesses.
   */
  sourceId: string;
  /**
   * Unqualified property name being accessed (e.g., `'save'` from
   * `entity.save`). Used as the resolution target name.
   */
  memberName: string;
  /**
   * Simple receiver identifier, when statically known.
   * E.g., `'user'` for `user.save`. `undefined` for complex expressions.
   */
  receiverName?: string;
  /** Whether the member is read, written, or both. */
  accessMode: AccessMode;
}

/**
 * Counters returned by {@link resolveAccesses}.
 */
export interface AccessResolutionResult {
  /** ACCESSES edges emitted at Tier 1 (same-file). */
  tier1Count: number;
  /** ACCESSES edges emitted at Tier 3 (global fallback). */
  tier3Count: number;
  /** Access sites that could not be resolved to a node ID. */
  unresolvedCount: number;
}

// ---------------------------------------------------------------------------
// Minimal SyntaxNode interface (mirrors typescript-extractor.ts)
// ---------------------------------------------------------------------------

/**
 * Minimal tree-sitter SyntaxNode shape required by this processor.
 * Avoids a hard dependency on any particular tree-sitter type package.
 */
interface SyntaxNode {
  type: string;
  text: string;
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  namedChildCount: number;
  parent: SyntaxNode | null;
  childForFieldName(fieldName: string): SyntaxNode | null;
  namedChild(index: number): SyntaxNode | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a stable node ID from file path and symbol name. */
function makeNodeId(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}

/**
 * AST node types that constitute a function/method definition boundary.
 * Used to determine the enclosing scope for access sites.
 */
const ENCLOSING_FUNCTION_TYPES = new Set([
  // TypeScript / JavaScript
  'function_declaration',
  'function_expression',
  'arrow_function',
  'generator_function_declaration',
  'generator_function',
  'method_definition',
  // Python
  'function_definition',
  // Go
  'function_declaration',
  'method_declaration',
  // Rust
  'function_item',
]);

/**
 * Build a stable source node ID for an access site.
 *
 * Walks up the AST to find the nearest enclosing function/method and returns
 * its node ID (matching the format from definition extraction:
 * `<filePath>::<qualifiedName>`). Falls back to `<filePath>::__file__` for
 * module-level accesses.
 */
function buildSourceId(node: SyntaxNode, filePath: string): string {
  let current = node.parent;

  while (current) {
    if (ENCLOSING_FUNCTION_TYPES.has(current.type)) {
      // method_definition (TS/JS)
      if (current.type === 'method_definition') {
        const nameNode = current.childForFieldName('name');
        if (nameNode?.text) {
          const classBody = current.parent;
          const classDecl = classBody?.parent;
          if (
            classDecl &&
            (classDecl.type === 'class_declaration' ||
              classDecl.type === 'abstract_class_declaration')
          ) {
            const classNameNode = classDecl.childForFieldName('name');
            if (classNameNode?.text) {
              return makeNodeId(filePath, `${classNameNode.text}.${nameNode.text}`);
            }
          }
          return makeNodeId(filePath, nameNode.text);
        }
      }

      // function_declaration / generator_function_declaration (TS/JS) or
      // function_declaration (Go)
      if (
        current.type === 'function_declaration' ||
        current.type === 'generator_function_declaration'
      ) {
        const nameNode = current.childForFieldName('name');
        if (nameNode?.text) {
          return makeNodeId(filePath, nameNode.text);
        }
      }

      // function_expression / arrow_function (TS/JS) — look for named declarator
      if (current.type === 'function_expression' || current.type === 'arrow_function') {
        const parent = current.parent;
        if (parent?.type === 'variable_declarator') {
          const nameNode = parent.childForFieldName('name');
          if (nameNode?.text) {
            return makeNodeId(filePath, nameNode.text);
          }
        }
      }

      // function_definition (Python) or method_declaration (Go)
      if (current.type === 'function_definition' || current.type === 'method_declaration') {
        const nameNode = current.childForFieldName('name');
        if (nameNode?.text) {
          return makeNodeId(filePath, nameNode.text);
        }
      }

      // function_item (Rust)
      if (current.type === 'function_item') {
        const nameNode = current.childForFieldName('name');
        if (nameNode?.text) {
          return makeNodeId(filePath, nameNode.text);
        }
      }
    }

    current = current.parent;
  }

  return `${filePath}::__file__`;
}

/**
 * Determine whether a `member_expression` (or attribute access) node is the
 * direct left-hand side of an assignment.
 *
 * Handles:
 * - `assignment_expression` (TS/JS): `left = right`
 * - `augmented_assignment_expression` (TS/JS): `left += right`
 * - `assignment` (Python): `left = right`
 * - `compound_assignment_expr` (Rust)
 *
 * Returns `true` when the node is the `left` (or `left_side`) field of one
 * of these parent types.
 */
function isWriteTarget(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;

  const writeParents = new Set([
    'assignment_expression',
    'augmented_assignment_expression',
    'assignment',
    'compound_assignment_expr',
  ]);

  if (!writeParents.has(parent.type)) return false;

  // Check that `node` is the left child, not the right
  const leftNode =
    parent.childForFieldName('left') ??
    parent.childForFieldName('left_side') ??
    parent.childForFieldName('pattern');
  if (leftNode && leftNode === node) return true;

  // For assignment nodes without a named `left` field, the first named child
  // is conventionally the left-hand side.
  if (!leftNode && parent.namedChild(0) === node) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Walk the full AST of a single file and collect all member-access sites.
 *
 * Extracted access forms:
 * - `member_expression` (TS/JS): `object.property`
 * - `attribute` (Python): `object.attribute`
 * - `field_expression` (Rust): `expr.field`
 * - `selector_expression` (Go): `expr.selector`
 *
 * Write accesses are detected when the member node is the left-hand side of
 * an assignment-family node (see {@link isWriteTarget}).
 *
 * Consecutive read+write of the same source→target pair are collapsed to
 * `readwrite` by {@link resolveAccesses} (deduplication happens there to keep
 * extraction simple and fast).
 *
 * @param rootNode - AST root node (program, module, source_file, etc.)
 * @param filePath - File path relative to repo root
 * @returns Array of extracted access records
 */
export function extractAccesses(rootNode: SyntaxNode, filePath: string): ExtractedAccess[] {
  const results: ExtractedAccess[] = [];

  /**
   * Member-expression node types across all supported languages.
   * Each value maps to a `{ object: fieldName, property: fieldName }` pair.
   */
  const ACCESS_NODE_TYPES: Record<string, { object: string; property: string }> = {
    member_expression: { object: 'object', property: 'property' },
    attribute: { object: 'object', property: 'attribute' },
    field_expression: { object: 'value', property: 'field' },
    selector_expression: { object: 'operand', property: 'field' },
  };

  function walk(node: SyntaxNode): void {
    const spec = ACCESS_NODE_TYPES[node.type];

    if (spec) {
      const objNode = node.childForFieldName(spec.object);
      const propNode = node.childForFieldName(spec.property);

      if (propNode?.text) {
        const memberName = propNode.text;
        const receiverName =
          objNode?.type === 'identifier' || objNode?.type === 'this' ? objNode.text : undefined;

        const accessMode: AccessMode = isWriteTarget(node) ? 'write' : 'read';

        results.push({
          filePath,
          sourceId: buildSourceId(node, filePath),
          memberName,
          receiverName,
          accessMode,
        });
      }
    }

    // Recurse into all children
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  }

  walk(rootNode);
  return results;
}

// ---------------------------------------------------------------------------
// Resolution (emit ACCESSES graph edges)
// ---------------------------------------------------------------------------

/**
 * Deduplicate extracted access records.
 *
 * When the same `sourceId → memberName` pair appears with both `'read'` and
 * `'write'` access modes, collapse them into a single `'readwrite'` record.
 * Keeps the first occurrence's `receiverName` for the merged record.
 */
function deduplicateAccesses(accesses: ExtractedAccess[]): ExtractedAccess[] {
  /** Key: `${sourceId}::${memberName}` */
  const seen = new Map<string, { access: ExtractedAccess; hasRead: boolean; hasWrite: boolean }>();

  for (const acc of accesses) {
    const key = `${acc.sourceId}::${acc.memberName}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, {
        access: { ...acc },
        hasRead: acc.accessMode === 'read',
        hasWrite: acc.accessMode === 'write',
      });
    } else {
      if (acc.accessMode === 'read') existing.hasRead = true;
      if (acc.accessMode === 'write') existing.hasWrite = true;
    }
  }

  const result: ExtractedAccess[] = [];
  for (const { access, hasRead, hasWrite } of seen.values()) {
    if (hasRead && hasWrite) {
      result.push({ ...access, accessMode: 'readwrite' });
    } else {
      result.push(access);
    }
  }
  return result;
}

/**
 * Attempt to resolve a single extracted access record to a target node ID.
 *
 * Resolution order:
 * 1. Tier 1 — same-file exact lookup (`symbolTable.lookupExact`)
 * 3. Tier 3 — global callable fallback (`symbolTable.lookupCallableByName`),
 *             only when exactly one candidate exists
 *
 * Returns `null` when neither tier resolves the name.
 */
function resolveSingleAccess(
  access: ExtractedAccess,
  symbolTable: SymbolTable,
): { nodeId: string; confidence: number; tier: 'same-file' | 'global' } | null {
  const { filePath, memberName } = access;

  // Tier 1: same-file (capped at 0.8 — accesses have inherent indirection)
  const tier1Id = symbolTable.lookupExact(filePath, memberName);
  if (tier1Id) {
    return {
      nodeId: tier1Id,
      confidence: Math.min(TIER_CONFIDENCE['same-file'], 0.8),
      tier: 'same-file',
    };
  }

  // Tier 3: global (single candidate only — skip ambiguous)
  const candidates = symbolTable.lookupCallableByName(memberName);
  if (candidates.length === 1) {
    const candidate = candidates[0];
    return {
      nodeId: candidate.nodeId,
      confidence: Math.min(TIER_CONFIDENCE.global, 0.8),
      tier: 'global',
    };
  }

  return null;
}

/**
 * Resolve all extracted access sites and emit ACCESSES edges into the graph.
 *
 * Must be called **after all files are parsed** so the SymbolTable is fully
 * populated. Access records are first deduplicated (read+write pairs of the
 * same source→target are collapsed to `'readwrite'`) before resolution.
 *
 * @param accesses - All access records accumulated during the parse loop
 * @param graph - KnowledgeGraph to write ACCESSES edges into
 * @param symbolTable - Fully-populated SymbolTable (all files parsed)
 * @returns Resolution counters
 */
export async function resolveAccesses(
  accesses: ExtractedAccess[],
  graph: KnowledgeGraph,
  symbolTable: SymbolTable,
): Promise<AccessResolutionResult> {
  let tier1Count = 0;
  let tier3Count = 0;
  let unresolvedCount = 0;

  // Deduplicate read+write pairs before resolution
  const deduped = deduplicateAccesses(accesses);

  let processed = 0;
  for (const access of deduped) {
    processed++;

    // Yield to event loop periodically on large repos
    if (processed % 100 === 0) {
      await Promise.resolve();
    }

    const resolved = resolveSingleAccess(access, symbolTable);
    if (!resolved) {
      unresolvedCount++;
      continue;
    }

    const rel: GraphRelation = {
      source: access.sourceId,
      target: resolved.nodeId,
      type: 'accesses',
      confidence: resolved.confidence,
      reason: `${access.accessMode} access to ${access.memberName} (tier: ${resolved.tier})`,
    };

    graph.addRelation(rel);

    if (resolved.tier === 'same-file') {
      tier1Count++;
    } else {
      tier3Count++;
    }
  }

  return { tier1Count, tier3Count, unresolvedCount };
}
