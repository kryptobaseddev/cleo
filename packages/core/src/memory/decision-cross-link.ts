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

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DecisionCodeEvidenceLink,
  DecisionCodeEvidenceOptions,
  DecisionCodeEvidenceResult,
  KnowledgeEvidenceRef,
} from '@cleocode/contracts';
import { z } from 'zod';
import {
  assessKnowledgeCoverage,
  KnowledgeSymbolAmbiguityError,
  readKnowledgeIndexAssessment,
  resolveKnowledgeSymbol,
} from '../nexus/knowledge.js';
import { getTaskKnowledgeEvidence } from '../nexus/task-evidence.js';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';
import { getNexusDb, getNexusNativeDb } from '../store/nexus-sqlite.js';
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

const evidenceDecisionSchema = z.object({
  id: z.string(),
  decision: z.string(),
  rationale: z.string(),
  context_task_id: z.string().nullable(),
  confirmation_state: z.string(),
  invalid_at: z.string().nullable(),
  superseded_by: z.string().nullable(),
});
const evidenceTargetSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  label: z.string(),
  kind: z.string(),
  file_path: z.string().nullable(),
});
const linkProvenanceSchema = z.object({
  kind: z.literal('decision-evidence-v1'),
  decisionId: z.string(),
  taskId: z.string().nullable(),
  targetId: z.string(),
  precision: z.enum(['file', 'symbol']),
  sourceRoot: z.string(),
  filePath: z.string(),
  generationId: z.string().nullable(),
  revision: z.string().nullable(),
  decisionContentHash: z.string(),
  taskContentHash: z.string().nullable(),
  targetContentHash: z.string(),
  evidence: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      source: z.enum(['task', 'verification', 'commit', 'attachment', 'memory', 'index', 'file']),
      revision: z.string().nullable(),
      precision: z.enum(['project', 'record', 'file', 'symbol']),
      contentHash: z.string().optional(),
      excerpt: z.string().optional(),
    }),
  ),
});
function evidenceHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function readEvidenceDecision(db: DatabaseSync, id: string) {
  return evidenceDecisionSchema.safeParse(
    db
      .prepare(
        'SELECT id, decision, rationale, context_task_id, confirmation_state, invalid_at, superseded_by FROM main.brain_decisions WHERE id = ?',
      )
      .get(id),
  );
}
function decisionEvidenceHash(row: z.infer<typeof evidenceDecisionSchema>): string {
  return evidenceHash(JSON.stringify([row.decision, row.rationale, row.context_task_id]));
}
function generation(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM main._nexus_meta WHERE key = 'graph_generation'").get();
  return typeof row?.value === 'string' ? row.value : null;
}

function taskEvidenceHash(db: DatabaseSync, taskId: string | null): string | null {
  if (!taskId) return null;
  const task = db
    .prepare('SELECT files_json, verification_json FROM main.tasks_tasks WHERE id = ?')
    .get(taskId);
  return task ? evidenceHash(JSON.stringify(task)) : null;
}

/**
 * Decode explicit decision provenance for inspectable link projections.
 * @param provenance - Stored edge provenance; legacy strings are not treated as sourced evidence.
 * @returns Validated provenance or null for legacy/malformed metadata.
 * @remarks Parsing alone does not establish current freshness; use the current-state checker as well.
 * @example
 * ```ts
 * const evidence = readDecisionCodeEvidence(edge.provenance);
 * ```
 */
export function readDecisionCodeEvidence(
  provenance: string | null,
): DecisionCodeEvidenceLink | null {
  if (!provenance?.startsWith('{')) return null;
  try {
    const result = linkProvenanceSchema.safeParse(JSON.parse(provenance));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Check stored decision relationships against current sources without deleting history.
 * @param db - Canonical project brain handle sharing the Nexus graph store.
 * @param provenance - Serialized edge provenance, including legacy provenance strings.
 * @returns False for stale sourced links; legacy links remain explicitly unverified by consumers.
 * @remarks Generation, canonical decision authority/content, and target file hashes are checked.
 * @example
 * ```ts
 * const current = isCurrentDecisionCodeEvidence(db, edge.provenance);
 * ```
 */
export function isCurrentDecisionCodeEvidence(
  db: DatabaseSync,
  provenance: string | null,
): boolean {
  if (!provenance?.startsWith('{')) {
    if (provenance === 'auto:decision-ner' || provenance === 'auto:decision-cross-link')
      return generation(db) === null;
    return true;
  }
  let decoded: z.infer<typeof linkProvenanceSchema>;
  try {
    const parsed = linkProvenanceSchema.safeParse(JSON.parse(provenance));
    if (!parsed.success) return !provenance.includes('decision-evidence-v1');
    decoded = parsed.data;
    const decision = readEvidenceDecision(db, decoded.decisionId);
    return (
      decision.success &&
      decision.data.confirmation_state === 'accepted' &&
      !decision.data.invalid_at &&
      !decision.data.superseded_by &&
      decisionEvidenceHash(decision.data) === decoded.decisionContentHash &&
      taskEvidenceHash(db, decoded.taskId) === decoded.taskContentHash &&
      generation(db) === decoded.generationId &&
      !!db.prepare('SELECT id FROM main.nexus_nodes WHERE id = ?').get(decoded.targetId) &&
      evidenceHash(readFileSync(resolve(decoded.sourceRoot, decoded.filePath), 'utf8')) ===
        decoded.targetContentHash
    );
  } catch {
    return false;
  }
}

/**
 * Assess or backfill explicit decision-to-task-to-file and named-symbol relationships.
 * @param projectRoot - Canonical project identity root, independent of configured source roots.
 * @param decisionId - Canonical accepted decision ID, with or without the decision prefix.
 * @param options - Explicit symbol targets and optional deterministic persistence.
 * @returns Source-bearing links and actionable unresolved findings; repeated backfills apply zero changes.
 * @remarks File evidence targets file nodes only. Historical edge provenance is retained before refresh.
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 * @example
 * ```ts
 * const report = await linkDecisionToCodeEvidence(projectRoot, 'D001', { apply: true });
 * ```
 */
export async function linkDecisionToCodeEvidence(
  projectRoot: string,
  decisionId: string,
  options: DecisionCodeEvidenceOptions = {},
): Promise<DecisionCodeEvidenceResult> {
  const id = decisionId.replace(/^decision:/, '');
  const coverage = await assessKnowledgeCoverage(projectRoot);
  const result: DecisionCodeEvidenceResult = {
    decisionId: id,
    coverage,
    links: [],
    findings: [],
    applied: 0,
  };
  const finding = (
    description: string,
    evidence: KnowledgeEvidenceRef[] = [],
    candidates: string[] = [],
  ): void => {
    result.findings.push({
      id: `decision-evidence:${id}:${evidenceHash(description).slice(0, 16)}`,
      projectId: coverage.projectId,
      affectedRecordIds: [id, ...candidates],
      description,
      evidence,
      repairClass: 'agent-resolvable',
      state: 'unresolved',
      proposedAction: null,
      verification: [
        'Resolve the exact source, qualified target, and current generation, then repeat evidence assessment.',
      ],
      recovery: null,
    });
  };
  try {
    await getBrainDb(projectRoot);
    await getNexusDb(projectRoot);
    const db = getBrainNativeDb(projectRoot);
    const graph = getNexusNativeDb(projectRoot);
    if (!db || !graph) throw new Error('Decision evidence stores are unavailable.');
    const source = readEvidenceDecision(db, id);
    if (
      !source.success ||
      source.data.confirmation_state !== 'accepted' ||
      source.data.invalid_at ||
      source.data.superseded_by
    ) {
      finding('The canonical decision is missing, unaccepted, or historical.');
      return result;
    }
    const decision = source.data;
    const decisionHash = decisionEvidenceHash(decision);
    const sourceRef: KnowledgeEvidenceRef = {
      id,
      source: 'memory',
      projectId: coverage.projectId,
      revision: coverage.assessedRevision,
      precision: 'record',
      contentHash: decisionHash,
    };
    const assessment = await readKnowledgeIndexAssessment(projectRoot);
    const sourceRoot = assessment?.sourceRoot ?? projectRoot;
    const graphGeneration = generation(graph);
    const targets = z
      .array(evidenceTargetSchema)
      .parse(graph.prepare('SELECT id, name, label, kind, file_path FROM main.nexus_nodes').all());
    const fileEvidence = new Map<string, KnowledgeEvidenceRef[]>();
    if (decision.context_task_id) {
      const task = await getTaskKnowledgeEvidence(decision.context_task_id, projectRoot, coverage);
      result.findings.push(...task.findings);
      for (const file of task.files)
        if (file.resolvedPath) fileEvidence.set(file.path, file.evidence);
    }
    const text = `${decision.decision}\n${decision.rationale}`;
    for (const ref of extractReferencedSymbols(text))
      if (ref.nodeType === 'file') fileEvidence.set(ref.raw, [sourceRef]);
    const add = (
      target: z.infer<typeof evidenceTargetSchema>,
      precision: 'file' | 'symbol',
      evidence: KnowledgeEvidenceRef[],
    ): void => {
      if (!target.file_path) {
        finding(`Target has no source path: ${target.id}`, evidence);
        return;
      }
      try {
        const root = realpathSync(sourceRoot);
        const path = realpathSync(resolve(root, target.file_path));
        const rel = relative(root, path);
        if (rel.startsWith('..') || isAbsolute(rel))
          throw new Error('Target lies outside the configured source root.');
        result.links.push({
          kind: 'decision-evidence-v1',
          decisionId: id,
          taskId: decision.context_task_id,
          targetId: target.id,
          precision,
          sourceRoot: root,
          filePath: rel,
          generationId: graphGeneration,
          revision: coverage.assessedRevision,
          decisionContentHash: decisionHash,
          taskContentHash: taskEvidenceHash(db, decision.context_task_id),
          targetContentHash: evidenceHash(readFileSync(path, 'utf8')),
          evidence: [sourceRef, ...evidence],
        });
      } catch (error) {
        finding(
          `Unresolved target ${target.id}: ${error instanceof Error ? error.message : String(error)}`,
          evidence,
        );
      }
    };
    for (const [path, evidence] of fileEvidence) {
      const matches = targets.filter((node) => node.kind === 'file' && node.file_path === path);
      if (matches.length === 1 && matches[0]) add(matches[0], 'file', evidence);
      else
        finding(
          `Evidence file needs one indexed file target: ${path}`,
          evidence,
          matches.map((node) => node.id),
        );
    }
    for (const query of options.symbols ?? []) {
      try {
        const resolved = resolveKnowledgeSymbol(
          query,
          targets.map((node) => ({ ...node, filePath: node.file_path })),
        );
        const target = targets.find((node) => node.id === resolved?.id);
        if (!target) {
          finding(`No indexed symbol matches: ${query}`, [sourceRef]);
          continue;
        }
        if (
          !(target.kind === 'file' && target.file_path && fileEvidence.has(target.file_path)) &&
          !text.includes(query) &&
          (!target.name || !text.includes(target.name))
        ) {
          finding(`The canonical decision does not cite symbol: ${query}`, [sourceRef]);
          continue;
        }
        add(target, target.kind === 'file' ? 'file' : 'symbol', []);
      } catch (error) {
        finding(
          error instanceof Error ? error.message : String(error),
          [sourceRef],
          error instanceof KnowledgeSymbolAmbiguityError
            ? error.candidates.map((candidate) => candidate.id)
            : [],
        );
      }
    }
    result.links = [...new Map(result.links.map((link) => [link.targetId, link])).values()];
    if (!result.links.length && !result.findings.length)
      finding(
        'The decision has no explicit task files, file references, or supplied named-symbol evidence.',
        [sourceRef],
      );
    if (!options.apply || !result.links.length) return result;
    db.exec('SAVEPOINT decision_evidence_links');
    try {
      const current = readEvidenceDecision(db, id);
      if (
        !current.success ||
        decisionEvidenceHash(current.data) !== decisionHash ||
        generation(graph) !== graphGeneration
      )
        throw new Error('Decision or graph changed; reassess before backfill.');
      db.prepare(
        "INSERT INTO main.brain_page_nodes (id, node_type, label, quality_score, content_hash) VALUES (?, 'decision', ?, 1, ?) ON CONFLICT(id) DO NOTHING",
      ).run(`decision:${id}`, decision.decision, decisionHash);
      for (const link of result.links) {
        if (!isCurrentDecisionCodeEvidence(db, JSON.stringify(link)))
          throw new Error('Source changed before link publication.');
        const old = db
          .prepare(
            "SELECT provenance FROM main.brain_page_edges WHERE from_id = ? AND to_id = ? AND edge_type = 'code_reference'",
          )
          .get(`decision:${id}`, link.targetId);
        const provenance = JSON.stringify(link);
        if (old?.provenance === provenance) continue;
        if (typeof old?.provenance === 'string')
          db.prepare('INSERT OR IGNORE INTO main._nexus_meta (key, value) VALUES (?, ?)').run(
            `decision_link_history:${evidenceHash(`${id}:${link.targetId}:${old.provenance}`)}`,
            JSON.stringify({ decisionId: id, targetId: link.targetId, provenance: old.provenance }),
          );
        db.prepare(
          "INSERT INTO main.brain_page_edges (from_id, to_id, edge_type, weight, provenance) VALUES (?, ?, 'code_reference', 1, ?) ON CONFLICT(from_id,to_id,edge_type) DO UPDATE SET provenance = excluded.provenance",
        ).run(`decision:${id}`, link.targetId, provenance);
        result.applied++;
      }
      db.exec('RELEASE decision_evidence_links');
    } catch (error) {
      db.exec('ROLLBACK TO decision_evidence_links');
      db.exec('RELEASE decision_evidence_links');
      result.applied = 0;
      throw error;
    }
  } catch (error) {
    finding(`Decision evidence failed: ${error instanceof Error ? error.message : String(error)}`);
    const failed = result.findings.at(-1);
    if (failed) failed.state = 'failed';
  }
  return result;
}
