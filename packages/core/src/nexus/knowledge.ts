/**
 * Shared coverage assessment and unambiguous symbol resolution.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified
 * against AGENTS.md. These services do not invoke a language model.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  GraphIndexAssessment,
  KnowledgeCoverage,
  KnowledgeCoverageStatus,
  KnowledgeSymbolCandidate,
} from '@cleocode/contracts';
import { legacyProjectId } from '@cleocode/paths';
import { min } from 'drizzle-orm';
import { z } from 'zod';
import { getProjectInfoSync } from '../project-info.js';
import { getNexusDb, getNexusNativeDb, nexusSchema } from '../store/nexus-sqlite.js';

const execFileAsync = promisify(execFile);

const assessmentSchema = z.object({
  sourceRoot: z.string(),
  assessedRevision: z.string().nullable(),
  assessedAt: z.string(),
  includedRepositories: z.array(z.string()).optional(),
  references: z
    .array(
      z.object({
        kind: z.literal('unmodeled-source'),
        filePath: z.string(),
        sourceId: z.string(),
        targetId: z.string(),
        targetName: z.string(),
        relationship: z.enum(['calls', 'accesses']),
        reason: z.string(),
      }),
    )
    .optional(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['analyzed', 'excluded', 'unsupported', 'oversized', 'failed']),
      reason: z.string().optional(),
      mtimeMs: z.number().optional(),
      size: z.number().optional(),
      contentHash: z.string().optional(),
    }),
  ),
});

/**
 * Read validated generation provenance without treating malformed metadata as healthy.
 * @param projectRoot - Explicit project root, or the ambient canonical project when omitted.
 * @returns The published assessment, or null for a legacy generation.
 * @remarks Reads only through the canonical project store. Malformed metadata throws.
 * @example
 * ```ts
 * const generation = await readKnowledgeIndexAssessment(projectRoot);
 * ```
 */
export async function readKnowledgeIndexAssessment(
  projectRoot?: string,
): Promise<GraphIndexAssessment | null> {
  await getNexusDb(projectRoot);
  const native = getNexusNativeDb(projectRoot);
  if (!native) throw new Error('The graph database is unavailable.');
  const row = native
    .prepare(`SELECT value FROM main._nexus_meta WHERE key = 'graph_assessment'`)
    .get();
  if (!row) return null;
  if (typeof row.value !== 'string') throw new Error('Graph assessment metadata is not text.');
  return assessmentSchema.parse(JSON.parse(row.value));
}

/**
 * An unresolved short name with exact identifiers the caller can choose from.
 * @remarks Consumers preserve the candidate list in their error envelope.
 * @example
 * ```ts
 * if (error instanceof KnowledgeSymbolAmbiguityError) return error.candidates;
 * ```
 */
export class KnowledgeSymbolAmbiguityError extends Error {
  /** Stable machine-readable failure code. */
  readonly code = 'E_AMBIGUOUS_SYMBOL';

  /** Every best-matching candidate; no checkout is silently selected. */
  readonly candidates: KnowledgeSymbolCandidate[];

  /**
   * Create an ambiguity error preserving candidates for structured envelopes.
   * @param query - Unresolved short symbol name.
   * @param candidates - All equally eligible qualified identifiers.
   */
  constructor(query: string, candidates: KnowledgeSymbolCandidate[]) {
    super(`Symbol '${query}' is ambiguous; use an exact candidate identifier.`);
    this.name = 'KnowledgeSymbolAmbiguityError';
    this.candidates = candidates;
  }
}

/**
 * Resolve exact identifiers, then exact names, then partial names without choosing a tie.
 * @param query - Qualified graph identifier or symbol name.
 * @param nodes - Candidate symbols from the scoped graph.
 * @returns The unique candidate, or null if none matches.
 * @remarks Ambiguous short names throw an error carrying every eligible candidate.
 * @example
 * ```ts
 * const target = resolveKnowledgeSymbol('src/api.ts::serve', candidates);
 * ```
 */
export function resolveKnowledgeSymbol(
  query: string,
  nodes: readonly KnowledgeSymbolCandidate[],
): KnowledgeSymbolCandidate | null {
  const idMatch = nodes.find((node) => node.id === query);
  if (idMatch) return idMatch;
  const lowered = query.toLowerCase();
  const symbols = nodes.filter((node) => !['community', 'process', 'folder'].includes(node.kind));
  const exact = symbols.filter((node) => (node.name ?? node.label).toLowerCase() === lowered);
  const matches = exact.length
    ? exact
    : symbols.filter((node) => (node.name ?? node.label).toLowerCase().includes(lowered));
  if (matches.length > 1) throw new KnowledgeSymbolAmbiguityError(query, matches);
  return matches[0] ?? null;
}

/**
 * Add an explicit coverage limitation without hiding a prior diagnostic failure.
 * @param coverage - Assessment to update in place.
 * @param status - Newly observed coverage status.
 * @param reason - Inspectable reason supporting the status.
 * @returns Nothing; the supplied assessment retains the strongest observed defect.
 * @remarks A partial result cannot overwrite a prior missing or failed result.
 * @example
 * ```ts
 * recordKnowledgeGap(coverage, 'missing', 'No indexed symbol matches the evidence.');
 * ```
 */
export function recordKnowledgeGap(
  coverage: KnowledgeCoverage,
  status: KnowledgeCoverageStatus,
  reason: string,
): void {
  const severity: Record<KnowledgeCoverageStatus, number> = {
    current: 0,
    partial: 1,
    stale: 2,
    missing: 3,
    failed: 4,
  };
  if (severity[status] > severity[coverage.status]) coverage.status = status;
  if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason);
}

/**
 * Assess graph coverage within the caller's maintenance budget (two seconds by default).
 *
 * Deferred work is read-only and cannot apply a repair after the response. A
 * synchronous native query cannot be preempted by JavaScript's event loop.
 * @param projectRoot - Canonical project root whose knowledge is assessed.
 * @param projectId - Existing project identity when supplied by the caller.
 * @param budgetMs - Maximum asynchronous foreground assessment time.
 * @returns Coverage with explicit reasons and a next action when deferred.
 * @remarks This service does not invoke models or mutate derived knowledge.
 * @example
 * ```ts
 * const coverage = await assessKnowledgeCoverage(projectRoot, undefined, 2000);
 * ```
 */
export async function assessKnowledgeCoverage(
  projectRoot: string,
  projectId?: string,
  budgetMs = 2000,
): Promise<KnowledgeCoverage> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deferred = new Promise<KnowledgeCoverage>((resolveDeferred) => {
    timer = setTimeout(
      () => {
        const info = getProjectInfoSync(projectRoot);
        resolveDeferred({
          status: 'partial',
          projectId:
            projectId ?? (info?.projectId || info?.projectHash || legacyProjectId(projectRoot)),
          assessedRevision: null,
          indexedRevision: null,
          assessedAt: new Date().toISOString(),
          reasons: ['Coverage assessment exceeded its maintenance budget.'],
          evidence: [],
          limitations: [
            'Static analysis cannot prove that all runtime callers have been discovered.',
          ],
          maintenanceState: 'pending',
          nextAction: 'cleo doctor knowledge',
        });
      },
      Math.max(0, budgetMs),
    );
  });
  try {
    return await Promise.race([assessCoverage(projectRoot, projectId), deferred]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Assess existing graph coverage with bounded filesystem checks and no mutations.
 *
 * Legacy indexes have no revision provenance and remain partial even when their
 * recorded files look fresh. At most 500 files are checked; a larger graph keeps
 * that limit explicit. Missing and failed graphs are never assessed as current.
 */
async function assessCoverage(projectRoot: string, projectId?: string): Promise<KnowledgeCoverage> {
  const info = getProjectInfoSync(projectRoot);
  const coverage: KnowledgeCoverage = {
    status: 'partial',
    projectId: projectId ?? (info?.projectId || info?.projectHash || legacyProjectId(projectRoot)),
    assessedRevision: null,
    indexedRevision: null,
    assessedAt: new Date().toISOString(),
    reasons: [],
    evidence: [],
    limitations: ['Static analysis cannot prove that all runtime callers have been discovered.'],
  };
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      timeout: 500,
    });
    coverage.assessedRevision = stdout.trim() || null;
  } catch {
    coverage.reasons.push('The assessed Git revision could not be established.');
  }
  try {
    const db = await getNexusDb(projectRoot);
    const table = nexusSchema.nexusNodes;
    const files = db
      .select({ filePath: table.filePath, indexedAt: min(table.indexedAt) })
      .from(table)
      .groupBy(table.filePath)
      .all();
    if (files.length === 0) {
      coverage.status = 'missing';
      coverage.reasons.push('No indexed graph is available; run cleo nexus analyze.');
      return coverage;
    }
    const assessment = await readKnowledgeIndexAssessment(projectRoot);
    if (assessment) {
      coverage.indexedRevision = assessment.assessedRevision;
      const sourceRoot = resolve(assessment.sourceRoot);
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
          cwd: sourceRoot,
          timeout: 500,
        });
        coverage.assessedRevision = stdout.trim() || null;
      } catch {
        coverage.assessedRevision = null;
      }
      coverage.status =
        coverage.indexedRevision && coverage.assessedRevision ? 'current' : 'partial';
      if (!coverage.indexedRevision || !coverage.assessedRevision) {
        coverage.reasons.push('The source or index revision could not be established.');
      } else if (coverage.indexedRevision !== coverage.assessedRevision) {
        recordKnowledgeGap(
          coverage,
          'stale',
          'The source revision differs from the indexed revision.',
        );
      }
      if (assessment.references?.length) {
        recordKnowledgeGap(
          coverage,
          'partial',
          `${assessment.references.length} AST references have unmodeled enclosing scopes; known callers are incomplete. Inspect assessment.references in cleo nexus status.`,
        );
        coverage.nextAction = 'cleo nexus status';
      }
      const analyzed = assessment.files.filter((file) => file.status === 'analyzed');
      if (analyzed.length > 500)
        recordKnowledgeGap(
          coverage,
          'partial',
          'Freshness checks are limited to 500 indexed files.',
        );
      for (const file of assessment.files) {
        if (file.status === 'failed')
          recordKnowledgeGap(coverage, 'failed', `Extraction failed: ${file.path}`);
        if (file.status === 'unsupported' || file.status === 'oversized') {
          recordKnowledgeGap(coverage, 'partial', `${file.status}: ${file.path}`);
        }
      }
      for (const file of analyzed.slice(0, 500)) {
        const absolute = resolve(sourceRoot, file.path);
        const relativePath = relative(sourceRoot, absolute);
        if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
          recordKnowledgeGap(
            coverage,
            'partial',
            `Indexed path is outside source ownership: ${file.path}`,
          );
          continue;
        }
        try {
          const stat = statSync(absolute);
          if (!file.contentHash) {
            recordKnowledgeGap(coverage, 'partial', `No source content fingerprint: ${file.path}`);
            coverage.nextAction = 'cleo nexus analyze';
          } else if (
            createHash('sha256').update(readFileSync(absolute)).digest('hex') !== file.contentHash
          ) {
            recordKnowledgeGap(
              coverage,
              'stale',
              `Source content changed after indexing: ${file.path}`,
            );
            coverage.nextAction = 'cleo nexus analyze';
          }
          if (file.mtimeMs === undefined || file.size === undefined) {
            recordKnowledgeGap(coverage, 'partial', `No file freshness evidence: ${file.path}`);
          } else if (stat.mtimeMs !== file.mtimeMs || stat.size !== file.size) {
            recordKnowledgeGap(coverage, 'stale', `Source changed after indexing: ${file.path}`);
          }
        } catch {
          recordKnowledgeGap(
            coverage,
            'stale',
            `Indexed source is missing or unreadable: ${file.path}`,
          );
        }
      }
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
          { cwd: sourceRoot, timeout: 500, maxBuffer: 1024 * 1024 },
        );
        const recorded = new Set(assessment.files.map((file) => file.path));
        const added = stdout.split('\0').filter((path) => path && !recorded.has(path));
        if (added.length)
          recordKnowledgeGap(
            coverage,
            'partial',
            'Unindexed files exist in the configured source root.',
          );
      } catch {
        recordKnowledgeGap(coverage, 'partial', 'Unindexed-file detection was unavailable.');
      }
      coverage.evidence.push({
        id: 'graph_assessment',
        projectId: coverage.projectId,
        source: 'index',
        revision: coverage.indexedRevision,
        precision: 'project',
      });
      return coverage;
    }
    coverage.reasons.push(
      'The index has no verified generation revision or complete extraction report.',
    );
    coverage.evidence.push({
      id: 'nexus_nodes',
      projectId: coverage.projectId,
      source: 'index',
      revision: null,
      precision: 'project',
    });
    if (files.length > 500) {
      coverage.reasons.push('Freshness checks are limited to 500 indexed files.');
    }
    const root = resolve(projectRoot);
    for (const file of files.slice(0, 500)) {
      if (!file.filePath) continue;
      const absolute = resolve(root, file.filePath);
      const relativePath = relative(root, absolute);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        coverage.reasons.push(`Indexed path is outside project ownership: ${file.filePath}`);
        continue;
      }
      try {
        const timestamp = file.indexedAt?.includes('T')
          ? file.indexedAt
          : `${file.indexedAt?.replace(' ', 'T')}Z`;
        const indexedAt = Date.parse(timestamp);
        if (!Number.isFinite(indexedAt)) {
          coverage.reasons.push(`Index timestamp is missing or invalid: ${file.filePath}`);
        } else if (statSync(absolute).mtimeMs > indexedAt) {
          coverage.status = 'stale';
          coverage.reasons.push(`Source changed after indexing: ${file.filePath}`);
        }
      } catch {
        coverage.status = 'stale';
        coverage.reasons.push(`Indexed source is missing or unreadable: ${file.filePath}`);
      }
    }
  } catch (error) {
    coverage.status = 'failed';
    coverage.reasons.push(
      `Graph assessment failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return coverage;
}
