/**
 * Ingestion functions for RCASD phase markdown and loose agent-output markdown
 * into the canonical docs_pipeline_manifest table.
 *
 * @task T1099
 * @epic T1093 — MANIFEST/RCASD Architecture Unification
 * @spec T1096
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { docsPipelineManifest } from '../store/schema/cleo-project/docs.js';
import { insertManifestRows } from './pipeline-manifest-sqlite.js';

/**
 * Mapping from RCASD phase directory name to pipeline_manifest.type value.
 * Per T1096 §3.4.
 */
const PHASE_TO_TYPE: Record<string, string> = {
  research: 'research',
  specification: 'specification',
  architecture: 'architecture',
  consensus: 'consensus',
  decomposition: 'decomposition',
  implementation: 'implementation',
  validation: 'validation',
  testing: 'validation', // testing phase maps to validation type
  release: 'release',
};

/**
 * Loose filename patterns to inferred type mapping.
 * Per T1096 §4.3 (in priority order).
 */
const FILENAME_TYPE_PATTERNS = [
  [/.*-research.*/, 'research'],
  [/.*-specification.*|.*-spec.*/, 'specification'],
  [/.*-architecture.*|.*-arch.*/, 'architecture'],
  [/.*-consensus.*/, 'consensus'],
  [/.*-decomposition.*|.*-decomp.*/, 'decomposition'],
  [/.*-implementation.*|.*-impl.*/, 'implementation'],
  [/.*-validation.*|.*-validate.*/, 'validation'],
  [/.*-audit.*/, 'research'],
  [/.*-report.*/, 'research'],
  [/.*-fix.*|.*-hotfix.*/, 'implementation'],
  [/.*-release.*/, 'release'],
  [/MASTER-.*|NEXT-.*|prime-.*/, 'documentation'],
  [/R-.*/, 'research'],
] as const;

/**
 * Unclassified file overrides.
 * Per T1096 §4.4.
 */
const UNCLASSIFIED_OVERRIDES: Record<string, string> = {
  'CANT-V2-PERSONA-SCHEMA-PLAN.md': 'specification',
  'CLI-SYSTEM-AUDIT-2026-04-10.md': 'research',
  'DOC-SYNC-AUDIT-2026-04-20.md': 'research',
  'STAB-3-clean-install-results.md': 'validation',
  'SYSTEM-VALIDATION-REPORT.md': 'validation',
  'T-ladybugdb-research-report.md': 'research',
  'T-verify-specs-report.md': 'validation',
  'ci-workflow-complete.md': 'implementation',
  'cicd-validation-report.md': 'validation',
  'conduit-orchestration-wiring.md': 'implementation',
  'deploy-templates-complete.md': 'implementation',
  'fix-cant-core-size.md': 'implementation',
  'fix-cant-lsp-match.md': 'implementation',
  'github-templates-complete.md': 'implementation',
  'graph-memory-bridge-implementation.md': 'implementation',
  'llmtxt-my-sitrep-2026-04-11.md': 'research',
  'research-node-sqlite.md': 'research',
};

/**
 * Compute SHA-256 hash of content as hex string.
 */
function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Sanitize a string to a slug (lowercase, hyphens for non-alphanumeric).
 */
function stringToSlug(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extract task ID from filename using regex.
 * Returns first T\d+ match, or null if not found.
 */
function extractTaskId(filename: string): string | null {
  const match = filename.match(/^(T\d+)/);
  return match ? match[1] : null;
}

/**
 * Infer type from loose filename using pattern matching and overrides.
 */
function inferLooseFileType(filename: string): string {
  // Check unclassified overrides first
  if (UNCLASSIFIED_OVERRIDES[filename]) {
    return UNCLASSIFIED_OVERRIDES[filename];
  }

  // Apply pattern matching rules in order
  for (const [pattern, type] of FILENAME_TYPE_PATTERNS) {
    if (pattern.test(filename)) {
      return type;
    }
  }

  // Fallback
  return 'implementation';
}

/**
 * Result of an ingestion operation.
 */
export interface IngestionResult {
  /** Number of entries successfully ingested. */
  ingested: number;
  /** Number of identical persisted entries skipped. */
  skipped: number;
}

/**
 * Type for Drizzle ORM SQLite database instance.
 */
type NodeSQLiteDatabase = Awaited<ReturnType<typeof import('../store/sqlite.js')['getDb']>>;

function readInputRoot(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Ingest RCASD phase markdown into the selected project's canonical manifest.
 *
 * @remarks
 * Reads `.cleo/rcasd/<TaskID>/<phase>/*.md` without rewriting source content.
 * The entire prepared batch commits atomically. Only identical persisted payloads
 * are skipped; changed identities and legacy evidence require explicit repair.
 * @param projectRoot - Explicit project directory owning the input and database.
 * @param db - Caller-owned canonical task-domain database for that project.
 * @returns Counts of inserted and identical existing entries.
 * @throws If source reads, database ownership, history checks, or writes fail.
 * @example
 * ```ts
 * const result = await ingestRcasdDirectories(projectRoot, db);
 * ```
 */
export async function ingestRcasdDirectories(
  projectRoot: string,
  db: NodeSQLiteDatabase,
): Promise<IngestionResult> {
  const rcasdRoot = join(projectRoot, '.cleo', 'rcasd');
  const rows: Array<typeof docsPipelineManifest.$inferSelect> = [];
  const taskDirs = readInputRoot(rcasdRoot).filter((name) =>
    statSync(join(rcasdRoot, name)).isDirectory(),
  );
  for (const taskId of taskDirs) {
    const taskPath = join(rcasdRoot, taskId);
    const phaseDirs = readdirSync(taskPath).filter((name) =>
      statSync(join(taskPath, name)).isDirectory(),
    );
    for (const phaseDir of phaseDirs) {
      const phasePath = join(taskPath, phaseDir);
      for (const mdFile of readdirSync(phasePath).filter((name) => name.endsWith('.md'))) {
        const filePath = join(phasePath, mdFile);
        const content = readFileSync(filePath, 'utf-8');
        const metadata = {
          phase: phaseDir,
          rcasd_origin: true,
          ...((phaseDir === 'consensus' && mdFile === 'auto-complete-policy.md') ||
          (phaseDir === 'decomposition' && mdFile === 'worker-specs.md')
            ? { filename_note: 'non-T-prefixed or generic filename' }
            : {}),
          ...(phaseDir === 'decomposition' &&
          mdFile === 'T1008-worker-spec.md' &&
          taskId === 'T1007'
            ? { cross_task_ref: 'T1008' }
            : {}),
        };
        rows.push({
          id: `${taskId}-rcasd-${phaseDir}-${stringToSlug(mdFile.replace(/\.md$/, ''))}`,
          sessionId: null,
          taskId,
          epicId: null,
          type: PHASE_TO_TYPE[phaseDir] || 'implementation',
          content,
          contentHash: computeContentHash(content),
          status: 'active',
          distilled: false,
          brainObsId: null,
          sourceFile: join('.cleo', 'rcasd', taskId, phaseDir, mdFile),
          metadataJson: JSON.stringify(metadata),
          createdAt: statSync(filePath).mtime.toISOString(),
          archivedAt: null,
        });
      }
    }
  }
  const ingested = await insertManifestRows(rows, projectRoot, db);
  return { ingested, skipped: rows.length - ingested };
}

/**
 * Ingest top-level agent-output markdown into the canonical manifest atomically.
 *
 * @remarks
 * Reads `.cleo/agent-outputs/*.md` without descending into subdirectories.
 * Preserves original content, source path, timestamp, and filename-derived metadata.
 * Missing input directories are empty inputs; read and write failures propagate.
 * @param projectRoot - Explicit project directory owning the input and database.
 * @param db - Caller-owned canonical task-domain database for that project.
 * @returns Counts of inserted and identical existing entries.
 * @throws If source reads, database ownership, history checks, or writes fail.
 * @example
 * ```ts
 * const result = await ingestLooseAgentOutputs(projectRoot, db);
 * ```
 */
export async function ingestLooseAgentOutputs(
  projectRoot: string,
  db: NodeSQLiteDatabase,
): Promise<IngestionResult> {
  const inputRoot = join(projectRoot, '.cleo', 'agent-outputs');
  const rows: Array<typeof docsPipelineManifest.$inferSelect> = [];
  for (const mdFile of readInputRoot(inputRoot)) {
    const filePath = join(inputRoot, mdFile);
    const stat = statSync(filePath);
    if (!stat.isFile() || !mdFile.endsWith('.md')) continue;
    const content = readFileSync(filePath, 'utf-8');
    const taskId = extractTaskId(mdFile);
    const slug = stringToSlug(mdFile.replace(/\.md$/, ''));
    const isRcasdPhase =
      taskId &&
      /^T\d+-(R\d+|CA\d+|[a-z-]+)-(.*)\.(md)$/i.test(mdFile) &&
      FILENAME_TYPE_PATTERNS.some(([pattern]) => pattern.test(mdFile));
    rows.push({
      id: taskId ? `${taskId}-loose-${slug}` : `loose-${slug}`,
      sessionId: null,
      taskId,
      epicId: null,
      type: inferLooseFileType(mdFile),
      content,
      contentHash: computeContentHash(content),
      status: 'active',
      distilled: false,
      brainObsId: null,
      sourceFile: join('.cleo', 'agent-outputs', mdFile),
      metadataJson: JSON.stringify({
        loose_origin: true,
        original_filename: mdFile,
        ...(isRcasdPhase ? { flat_rcasd: true } : {}),
      }),
      createdAt: stat.mtime.toISOString(),
      archivedAt: null,
    });
  }
  const ingested = await insertManifestRows(rows, projectRoot, db);
  return { ingested, skipped: rows.length - ingested };
}
