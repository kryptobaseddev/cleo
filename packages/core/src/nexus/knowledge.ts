/**
 * Shared coverage assessment and unambiguous symbol resolution.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified
 * against AGENTS.md. These services do not invoke a language model.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  GraphIndexAssessment,
  GraphIndexFileReport,
  GraphIndexReferenceReport,
  KnowledgeCoverage,
  KnowledgeCoverageStatus,
  KnowledgeSymbolCandidate,
} from '@cleocode/contracts';
import { legacyProjectId } from '@cleocode/paths';
import { min } from 'drizzle-orm';
import { z } from 'zod';
import { worktreeScope } from '../paths.js';
import { getProjectInfoSync } from '../project-info.js';
import { getNexusDb, getNexusNativeDb, nexusSchema } from '../store/nexus-sqlite.js';
import {
  ASSESSMENT_KEY,
  ASSESSMENT_REFERENCES_KEY,
  decodeStoredReferences,
} from './assessment-store.js';
import { generateProjectHash } from './hash.js';
import { resolveSourceRoots } from './source-roots.js';

const execFileAsync = promisify(execFile);

const sourceRootSchema = z
  .object({
    requestedPath: z.string().refine(isAbsolute, 'Root path must be absolute'),
    canonicalPath: z.string().refine(isAbsolute, 'Canonical path must be absolute').nullable(),
    graphPrefix: z.string(),
    explicitlyIncluded: z.boolean(),
    revision: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .nullable(),
    status: z.enum(['available', 'unversioned', 'missing', 'failed', 'pending']),
    diagnostics: z.array(z.string()),
  })
  .superRefine((root, context) => {
    if (
      root.explicitlyIncluded !== (root.graphPrefix !== '') ||
      isAbsolute(root.graphPrefix) ||
      root.graphPrefix.split('/').includes('..') ||
      root.graphPrefix.includes('\\') ||
      (root.explicitlyIncluded &&
        root.canonicalPath !== null &&
        root.canonicalPath !== root.requestedPath)
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid root graph prefix or inclusion ownership',
      });
    if (
      root.status === 'available'
        ? !root.revision || !root.canonicalPath
        : root.revision !== null || !root.diagnostics.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Root status requires a revision or explicit diagnostic',
      });
    if (root.status === 'unversioned' && root.explicitlyIncluded)
      context.addIssue({
        code: 'custom',
        message: 'An explicitly included repository cannot be unversioned',
      });
  });

const sourceRootsSchema = z
  .object({
    projectId: z.string().min(1),
    projectRoot: z.string().refine(isAbsolute),
    sourceRoot: z.string().refine(isAbsolute),
    assessedAt: z.iso.datetime(),
    roots: z.array(sourceRootSchema).min(1),
  })
  .superRefine((assessment, context) => {
    const prefixes = new Set<string>();
    const canonical = new Set<string>();
    for (const root of assessment.roots) {
      if (
        prefixes.has(root.graphPrefix) ||
        (root.canonicalPath !== null && canonical.has(root.canonicalPath)) ||
        resolve(assessment.sourceRoot, root.graphPrefix) !== root.requestedPath
      )
        context.addIssue({ code: 'custom', message: 'Duplicate or mismatched root ownership' });
      prefixes.add(root.graphPrefix);
      if (root.canonicalPath) canonical.add(root.canonicalPath);
    }
    if (assessment.roots[0]?.graphPrefix !== '')
      context.addIssue({ code: 'custom', message: 'Source root must be the first observation' });
  });

const analysisCapabilitySchema = z.enum([
  'file-evidence',
  'documentary-evidence',
  'configuration-evidence',
  'schema-evidence',
  'data-evidence',
  'resource-evidence',
  'declarations',
  'imports',
  'call-references',
  'access-references',
  'type-heritage',
  'sql-schema-objects',
  'sql-migrations',
  'sql-triggers',
  'sql-constraints',
  'sql-literal-references',
  'sql-dynamic-references',
]);
const fileCapabilitiesSchema = z
  .object({
    role: z.enum([
      'executable',
      'sql',
      'documentation',
      'configuration',
      'schema',
      'generated-data',
      'data',
      'asset',
      'unknown',
    ]),
    classification: z.object({
      basis: z.enum(['path', 'content', 'path-and-content', 'unknown']),
      reason: z
        .string()
        .refine((reason) => reason.trim().length > 0, 'Classification reason must be nonempty'),
    }),
    requested: z
      .array(analysisCapabilitySchema)
      .refine(
        (values) => new Set(values).size === values.length,
        'Requested capabilities must be unique',
      ),
    completed: z
      .array(analysisCapabilitySchema)
      .refine(
        (values) => new Set(values).size === values.length,
        'Completed capabilities must be unique',
      ),
    limitations: z.array(z.string()),
  })
  .superRefine((value, context) => {
    if (value.completed.some((capability) => !value.requested.includes(capability)))
      context.addIssue({ code: 'custom', message: 'Completed capabilities must be requested' });
    if (value.role !== 'unknown' && value.classification.basis === 'unknown')
      context.addIssue({
        code: 'custom',
        message: 'A known role requires positive classification evidence',
      });
  });

/** One retained unresolved or unmodeled static reference (T12348: stored separately). */
const referenceSchema = z.object({
  kind: z.enum(['unmodeled-source', 'ambiguous', 'external', 'dynamic', 'shadowed', 'unresolved']),
  filePath: z.string(),
  sourceId: z.string(),
  targetId: z.string().optional(),
  targetName: z.string(),
  relationship: z.enum(['calls', 'accesses']),
  reason: z.string(),
  candidateIds: z.array(z.string()).optional(),
  generation: z.string().optional(),
  publicationGeneration: z.uuid().optional(),
  span: z
    .object({
      startIndex: z.number().int().nonnegative(),
      endIndex: z.number().int().nonnegative(),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      startColumn: z.number().int().nonnegative(),
      endColumn: z.number().int().nonnegative(),
      offsetEncoding: z.literal('utf16'),
    })
    .refine(
      (span) => span.endIndex >= span.startIndex && span.endLine >= span.startLine,
      'Reference span must be an ordered original source range',
    )
    .optional(),
});

const assessmentSchema = z.object({
  generation: z.uuid().optional(),
  sourceRoots: sourceRootsSchema.optional(),
  sourceRoot: z.string(),
  assessedRevision: z.string().nullable(),
  assessedAt: z.string(),
  includedRepositories: z.array(z.string()).optional(),
  references: z.array(referenceSchema).optional(),
  referenceCount: z.number().int().nonnegative().optional(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['analyzed', 'excluded', 'unsupported', 'oversized', 'failed']),
      capabilities: fileCapabilitiesSchema.optional(),
      reason: z.string().optional(),
      mtimeMs: z.number().optional(),
      size: z.number().optional(),
      contentHash: z.string().optional(),
    }),
  ),
});

/**
 * Read validated generation provenance without treating malformed metadata as healthy.
 *
 * T12348: this is the SUMMARY — the retained reference list is stored
 * separately and reported as `referenceCount`; read it with
 * {@link readKnowledgeIndexReferences}. A historical value with inline
 * `references` is returned as stored.
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
    .prepare('SELECT value FROM main._nexus_meta WHERE key = ?')
    .get(ASSESSMENT_KEY);
  if (!row) return null;
  if (typeof row.value !== 'string') throw new Error('Graph assessment metadata is not text.');
  const assessment = assessmentSchema.parse(JSON.parse(row.value));
  if (assessment.sourceRoots) {
    const prefixes = assessment.sourceRoots.roots
      .filter((root) => root.explicitlyIncluded)
      .map((root) => root.graphPrefix);
    if (
      assessment.sourceRoots.sourceRoot !== assessment.sourceRoot ||
      assessment.sourceRoots.roots[0]?.revision !== assessment.assessedRevision ||
      JSON.stringify(prefixes) !== JSON.stringify(assessment.includedRepositories ?? [])
    )
      throw new Error('Root observations disagree with graph source scope or revision.');
  }
  return assessment;
}

/**
 * Read the published generation's retained reference list — the detail behind
 * `referenceCount` (T12348).
 *
 * This is the expensive read (hundreds of MB on a large repository), so only
 * explicit detail requests make it. A historical assessment with inline
 * `references` is honoured; a published graph with neither yields an empty list.
 * @param projectRoot - Explicit project root, or the ambient canonical project when omitted.
 * @returns Every retained reference, validated; `null` when no graph is published.
 * @example
 * ```ts
 * const references = await readKnowledgeIndexReferences(projectRoot);
 * ```
 */
export async function readKnowledgeIndexReferences(
  projectRoot?: string,
): Promise<GraphIndexReferenceReport[] | null> {
  const assessment = await readKnowledgeIndexAssessment(projectRoot);
  if (!assessment) return null;
  if (assessment.references) return assessment.references;
  const native = getNexusNativeDb(projectRoot);
  if (!native) throw new Error('The graph database is unavailable.');
  const row = native
    .prepare('SELECT value FROM main._nexus_meta WHERE key = ?')
    .get(ASSESSMENT_REFERENCES_KEY);
  if (!row) {
    if ((assessment.referenceCount ?? 0) > 0)
      throw new Error('Graph assessment reports references, but none are stored.');
    return [];
  }
  const references = z.array(referenceSchema).parse(JSON.parse(decodeStoredReferences(row.value)));
  if (assessment.referenceCount !== undefined && references.length !== assessment.referenceCount)
    throw new Error('Stored graph references disagree with the assessment reference count.');
  return references;
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
  const capturedRoot = resolve(projectRoot);
  const inherited = worktreeScope.getStore();
  if (inherited?.execution && resolve(inherited.execution.identity.projectRoot) !== capturedRoot)
    throw new Error('Coverage project differs from captured execution scope.');
  return worktreeScope.run(
    { ...inherited, worktreeRoot: capturedRoot, projectHash: generateProjectHash(capturedRoot) },
    () => assessScopedCoverage(capturedRoot, projectId, budgetMs),
  );
}

/** Disclose remaining work without erasing stronger observed defects. */
function markCoveragePending(coverage: KnowledgeCoverage): void {
  recordKnowledgeGap(
    coverage,
    'partial',
    'Coverage assessment exceeded its shared maintenance deadline.',
  );
  coverage.maintenanceState = 'pending';
  coverage.nextAction = 'cleo doctor knowledge';
}

/** Retain captured path ownership and observed progress through a deferred response. */
async function assessScopedCoverage(
  projectRoot: string,
  projectId: string | undefined,
  budgetMs: number,
): Promise<KnowledgeCoverage> {
  const deadline = Date.now() + Math.max(0, budgetMs);
  const info = getProjectInfoSync(projectRoot);
  const inventory: NonNullable<KnowledgeCoverage['inventory']> = {
    requested: null,
    completed: 0,
    unassessed: null,
    changed: 0,
    missing: 0,
    failed: 0,
  };
  const capabilities: NonNullable<KnowledgeCoverage['capabilities']> = {
    requestedFiles: null,
    assessedFiles: 0,
    unassessedFiles: null,
    excludedFiles: null,
    legacyFiles: 0,
    incompleteFiles: 0,
    extractionFailedFiles: 0,
    byRole: {},
    byCapability: {},
  };
  const coverage: KnowledgeCoverage = {
    capabilities,
    status: 'partial',
    projectId: projectId ?? (info?.projectId || info?.projectHash || legacyProjectId(projectRoot)),
    assessedRevision: null,
    indexedRevision: null,
    assessedAt: new Date().toISOString(),
    reasons: [],
    evidence: [],
    limitations: ['Static analysis cannot prove that all runtime callers have been discovered.'],
    inventory,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deferred = new Promise<KnowledgeCoverage>((resolveDeferred) => {
    timer = setTimeout(
      () => {
        markCoveragePending(coverage);
        // A returned snapshot cannot be rewritten by a late read. The timer does
        // not preempt synchronous native database or filesystem work.
        resolveDeferred({
          ...coverage,
          inventory: { ...inventory },
          capabilities: structuredClone(capabilities),
          reasons: [...coverage.reasons],
          evidence: [...coverage.evidence],
          limitations: [...coverage.limitations],
        });
      },
      Math.max(0, deadline - Date.now()),
    );
  });
  try {
    return await Promise.race([
      assessCoverage(projectRoot, projectId, deadline, coverage, inventory),
      deferred,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Account for one persisted role without equating resource evidence with executable coverage. */
function assessFileCapabilities(file: GraphIndexFileReport, coverage: KnowledgeCoverage): void {
  const summary = coverage.capabilities;
  if (!summary) return;
  if (file.status === 'excluded') {
    coverage.limitations.push(
      `Excluded source: ${file.path}: ${file.reason ?? 'No exclusion reason recorded'}`,
    );
    return;
  }
  summary.assessedFiles++;
  if (summary.unassessedFiles !== null) summary.unassessedFiles--;
  let incomplete = false;
  const report = file.capabilities;
  if (!report) {
    summary.legacyFiles++;
    incomplete = true;
    recordKnowledgeGap(
      coverage,
      'partial',
      `Legacy report lacks role and capability provenance: ${file.path}`,
    );
  } else {
    summary.byRole[report.role] = (summary.byRole[report.role] ?? 0) + 1;
    for (const capability of report.requested) {
      const count = summary.byCapability[capability] ?? {
        requestedFiles: 0,
        completedFiles: 0,
        incompleteFiles: 0,
      };
      count.requestedFiles++;
      if (report.completed.includes(capability)) count.completedFiles++;
      else count.incompleteFiles++;
      summary.byCapability[capability] = count;
    }
    const missing = report.requested.filter((capability) => !report.completed.includes(capability));
    const required =
      report.role === 'executable' || report.role === 'unknown'
        ? ([
            'file-evidence',
            'declarations',
            'imports',
            'call-references',
            'access-references',
            'type-heritage',
          ] as const)
        : report.role === 'sql'
          ? ([
              'file-evidence',
              'sql-schema-objects',
              'sql-migrations',
              'sql-triggers',
              'sql-constraints',
              'sql-literal-references',
              'sql-dynamic-references',
            ] as const)
          : (['file-evidence'] as const);
    const unrequested = required.filter((capability) => !report.requested.includes(capability));
    if (missing.length || unrequested.length || report.role === 'unknown') {
      incomplete = true;
      recordKnowledgeGap(
        coverage,
        'partial',
        `Incomplete ${report.role} capabilities: ${file.path}; uncompleted=${missing.join(',') || 'none'}; unrequested=${unrequested.join(',') || 'none'}`,
      );
    }
    for (const limitation of report.limitations)
      if (!coverage.limitations.includes(limitation)) coverage.limitations.push(limitation);
  }
  if (file.status === 'failed') {
    summary.extractionFailedFiles++;
    incomplete = true;
    recordKnowledgeGap(
      coverage,
      'failed',
      `Extraction failed: ${file.path}${file.reason ? `: ${file.reason}` : ''}`,
    );
  }
  if (file.status === 'unsupported' || file.status === 'oversized') {
    if (
      !report ||
      report.role === 'executable' ||
      report.role === 'sql' ||
      report.role === 'unknown' ||
      incomplete
    ) {
      incomplete = true;
      recordKnowledgeGap(coverage, 'partial', `${file.status}: ${file.path}`);
    } else
      coverage.limitations.push(
        `${file.status}: ${file.path}${file.reason ? `: ${file.reason}` : ''}`,
      );
  }
  if (incomplete) summary.incompleteFiles++;
}

/**
 * Assess the complete persisted inventory using cooperative async file checks.
 * Legacy indexes remain partial without revision/content provenance. Population
 * size never supplies an artificial freshness ceiling; the original deadline
 * bounds further work and preserves an explicit unassessed remainder.
 */
async function assessCoverage(
  projectRoot: string,
  projectId: string | undefined,
  deadline: number,
  coverage: KnowledgeCoverage,
  inventory: NonNullable<KnowledgeCoverage['inventory']>,
): Promise<KnowledgeCoverage> {
  const info = getProjectInfoSync(projectRoot);
  if (Date.now() >= deadline) {
    markCoveragePending(coverage);
    return coverage;
  }
  try {
    const db = await getNexusDb(projectRoot);
    if (Date.now() >= deadline) {
      markCoveragePending(coverage);
      return coverage;
    }
    const table = nexusSchema.nexusNodes;
    const files = db
      .select({ filePath: table.filePath, indexedAt: min(table.indexedAt) })
      .from(table)
      .groupBy(table.filePath)
      .all();
    const assessment = await readKnowledgeIndexAssessment(projectRoot);
    if (files.length === 0 && !assessment) {
      inventory.requested = 0;
      inventory.unassessed = 0;
      coverage.capabilities = {
        requestedFiles: 0,
        assessedFiles: 0,
        unassessedFiles: 0,
        excludedFiles: 0,
        legacyFiles: 0,
        incompleteFiles: 0,
        extractionFailedFiles: 0,
        byRole: {},
        byCapability: {},
      };
      coverage.status = 'missing';
      coverage.reasons.push('No indexed graph is available; run cleo nexus analyze.');
      return coverage;
    }
    if (assessment) {
      const sourceFiles = assessment.files.filter((file) => file.status !== 'excluded');
      inventory.requested = sourceFiles.length;
      inventory.unassessed = sourceFiles.length;
      if (coverage.capabilities) {
        coverage.capabilities.requestedFiles = sourceFiles.length;
        coverage.capabilities.unassessedFiles = sourceFiles.length;
        coverage.capabilities.excludedFiles = assessment.files.length - sourceFiles.length;
      }
      if (Date.now() >= deadline) {
        markCoveragePending(coverage);
        return coverage;
      }
      coverage.indexedRevision = assessment.assessedRevision;
      const sourceRoot = resolve(assessment.sourceRoot);
      if (!assessment.sourceRoots) {
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
      } else {
        const verifiedIdentity = projectId ?? (info?.projectId || info?.projectHash);
        if (
          assessment.sourceRoots.projectRoot !== realpathSync(projectRoot) ||
          (verifiedIdentity !== undefined && verifiedIdentity !== assessment.sourceRoots.projectId)
        )
          throw new Error('Recorded source ownership differs from the requested project binding.');
        coverage.projectId = assessment.sourceRoots.projectId;
        coverage.status = 'current';
      }
      if (!assessment.sourceRoots) {
        recordKnowledgeGap(
          coverage,
          'partial',
          'Legacy generation has no verified per-root ownership or revision observations.',
        );
      } else {
        const observed = await resolveSourceRoots({
          projectId: assessment.sourceRoots.projectId,
          projectRoot: assessment.sourceRoots.projectRoot,
          sourceRoot,
          deadline,
          includedRepositories:
            assessment.includedRepositories ??
            assessment.sourceRoots.roots
              .filter((root) => root.explicitlyIncluded)
              .map((root) => root.graphPrefix),
        });
        coverage.assessedRevision = observed.roots[0]?.revision ?? null;
        if (observed.roots.length !== assessment.sourceRoots.roots.length)
          recordKnowledgeGap(coverage, 'stale', 'Configured source-root population changed.');
        for (const root of observed.roots) {
          const indexed = assessment.sourceRoots.roots.find(
            (candidate) => candidate.graphPrefix === root.graphPrefix,
          );
          if (
            !indexed ||
            indexed.canonicalPath !== root.canonicalPath ||
            indexed.revision !== root.revision
          )
            recordKnowledgeGap(
              coverage,
              'stale',
              `Source ownership or revision changed: ${root.requestedPath}`,
            );
          if (root.status !== 'available')
            recordKnowledgeGap(
              coverage,
              root.status === 'failed' || root.status === 'missing' ? 'failed' : 'partial',
              `${root.requestedPath}: ${root.diagnostics.join('; ')}`,
            );
          coverage.evidence.push({
            id: `source_root:${root.graphPrefix || '.'}`,
            projectId: coverage.projectId,
            source: 'index',
            revision: indexed?.revision ?? null,
            precision: 'project',
          });
        }
      }
      if (files.length === 0)
        recordKnowledgeGap(coverage, 'missing', 'The published graph has no indexed nodes.');
      const referenceCount = assessment.referenceCount ?? assessment.references?.length ?? 0;
      if (referenceCount > 0) {
        recordKnowledgeGap(
          coverage,
          'partial',
          `${referenceCount} unresolved or unmodeled static references remain; known callers are incomplete. Inspect them with cleo nexus status --references.`,
        );
        coverage.nextAction = 'cleo nexus status';
      }
      for (const file of assessment.files) {
        if (Date.now() >= deadline) {
          markCoveragePending(coverage);
          return coverage;
        }
        assessFileCapabilities(file, coverage);
      }
      for (const file of sourceFiles) {
        if (Date.now() >= deadline) {
          markCoveragePending(coverage);
          return coverage;
        }
        const absolute = resolve(sourceRoot, file.path);
        const relativePath = relative(sourceRoot, absolute);
        if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
          inventory.failed++;
          inventory.completed++;
          inventory.unassessed--;
          recordKnowledgeGap(
            coverage,
            'failed',
            `Indexed path is outside source ownership: ${file.path}`,
          );
          continue;
        }
        try {
          const stat = await fs.stat(absolute);
          if (Date.now() >= deadline) {
            markCoveragePending(coverage);
            return coverage;
          }
          if (!stat.isFile()) throw new Error('Indexed source is not a regular file');
          let changed = false;
          if (!file.contentHash) {
            recordKnowledgeGap(coverage, 'partial', `No source content fingerprint: ${file.path}`);
            coverage.nextAction = 'cleo nexus analyze';
          } else {
            const content = await fs.readFile(absolute, {
              signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
            });
            if (Date.now() >= deadline) {
              markCoveragePending(coverage);
              return coverage;
            }
            if (createHash('sha256').update(content).digest('hex') !== file.contentHash) {
              changed = true;
              recordKnowledgeGap(
                coverage,
                'stale',
                `Source content changed after indexing: ${file.path}`,
              );
              coverage.nextAction = 'cleo nexus analyze';
            }
          }
          if (file.mtimeMs === undefined || file.size === undefined) {
            recordKnowledgeGap(coverage, 'partial', `No file freshness evidence: ${file.path}`);
          } else if (stat.mtimeMs !== file.mtimeMs || stat.size !== file.size) {
            changed = true;
            recordKnowledgeGap(coverage, 'stale', `Source changed after indexing: ${file.path}`);
          }
          if (changed) inventory.changed++;
        } catch (error) {
          if (Date.now() >= deadline) {
            markCoveragePending(coverage);
            return coverage;
          }
          if (
            error instanceof Error &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          ) {
            inventory.missing++;
            recordKnowledgeGap(coverage, 'stale', `Indexed source is missing: ${file.path}`);
          } else {
            inventory.failed++;
            recordKnowledgeGap(
              coverage,
              'failed',
              `Source freshness read failed: ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        inventory.completed++;
        inventory.unassessed--;
      }
      if (Date.now() >= deadline) {
        markCoveragePending(coverage);
        return coverage;
      }
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
          {
            cwd: sourceRoot,
            timeout: Math.max(1, Math.min(500, deadline - Date.now())),
            maxBuffer: 1024 * 1024,
          },
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
        if (Date.now() >= deadline) markCoveragePending(coverage);
        else recordKnowledgeGap(coverage, 'partial', 'Unindexed-file detection was unavailable.');
      }
      if (Date.now() >= deadline) markCoveragePending(coverage);
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
    const legacyFiles = files.filter((file) => file.filePath !== null);
    inventory.requested = legacyFiles.length;
    inventory.unassessed = legacyFiles.length;
    const root = resolve(projectRoot);
    for (const file of legacyFiles) {
      if (Date.now() >= deadline) {
        markCoveragePending(coverage);
        return coverage;
      }
      if (!file.filePath) {
        inventory.failed++;
        inventory.completed++;
        inventory.unassessed--;
        recordKnowledgeGap(coverage, 'failed', 'Indexed source path is empty.');
        continue;
      }
      const absolute = resolve(root, file.filePath);
      const relativePath = relative(root, absolute);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        inventory.failed++;
        inventory.completed++;
        inventory.unassessed--;
        recordKnowledgeGap(
          coverage,
          'failed',
          `Indexed path is outside project ownership: ${file.filePath}`,
        );
        continue;
      }
      try {
        const timestamp = file.indexedAt?.includes('T')
          ? file.indexedAt
          : `${file.indexedAt?.replace(' ', 'T')}Z`;
        const indexedAt = Date.parse(timestamp);
        if (!Number.isFinite(indexedAt)) {
          coverage.reasons.push(`Index timestamp is missing or invalid: ${file.filePath}`);
        } else {
          const stat = await fs.stat(absolute);
          if (Date.now() >= deadline) {
            markCoveragePending(coverage);
            return coverage;
          }
          if (!stat.isFile()) throw new Error('Indexed source is not a regular file');
          if (stat.mtimeMs > indexedAt) {
            inventory.changed++;
            recordKnowledgeGap(
              coverage,
              'stale',
              `Source changed after indexing: ${file.filePath}`,
            );
          }
        }
      } catch (error) {
        if (Date.now() >= deadline) {
          markCoveragePending(coverage);
          return coverage;
        }
        if (
          error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        ) {
          inventory.missing++;
          recordKnowledgeGap(coverage, 'stale', `Indexed source is missing: ${file.filePath}`);
        } else {
          inventory.failed++;
          recordKnowledgeGap(
            coverage,
            'failed',
            `Source freshness read failed: ${file.filePath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      inventory.completed++;
      inventory.unassessed--;
    }
  } catch (error) {
    coverage.status = 'failed';
    coverage.reasons.push(
      `Graph assessment failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return coverage;
}
