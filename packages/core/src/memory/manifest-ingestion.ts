/**
 * Ingestion functions for RCASD phase markdown and loose agent-output markdown
 * into pipeline_manifest table.
 *
 * @task T1099
 * @epic T1093 — MANIFEST/RCASD Architecture Unification
 * @spec T1096
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipelineManifest } from '../store/tasks-schema.js';

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
  /** Number of entries skipped (due to duplication or errors). */
  skipped: number;
}

/**
 * Type for Drizzle ORM SQLite database instance.
 */
type NodeSQLiteDatabase = Awaited<ReturnType<typeof import('../store/sqlite.js')['getDb']>>;

/**
 * Ingest RCASD phase directories into pipeline_manifest.
 *
 * Reads `.cleo/rcasd/<TaskID>/<phase>/*.md` files and inserts each as a
 * pipeline_manifest row with:
 * - task_id: extracted from parent directory name
 * - type: mapped from phase directory name per §3.4
 * - content: full file contents
 * - source_file: relative path from project root
 * - metadata_json: {phase, rcasd_origin: true, ...}
 *
 * Uses INSERT OR IGNORE on content_hash for idempotency.
 *
 * @param projectRoot - absolute path to project root
 * @param db - Drizzle ORM database instance
 * @returns {ingested, skipped}
 */
export async function ingestRcasdDirectories(
  projectRoot: string,
  db: NodeSQLiteDatabase,
): Promise<IngestionResult> {
  const rcasdRoot = join(projectRoot, '.cleo', 'rcasd');
  let ingested = 0;
  let skipped = 0;

  // Check if rcasd directory exists
  if (!existsSync(rcasdRoot)) {
    return { ingested: 0, skipped: 0 };
  }

  // Read task directories
  let taskDirs: string[];
  try {
    const fs = await import('node:fs');
    taskDirs = fs.readdirSync(rcasdRoot).filter((f) => {
      const fullPath = join(rcasdRoot, f);
      return fs.statSync(fullPath).isDirectory();
    });
  } catch {
    return { ingested: 0, skipped: 0 };
  }

  for (const taskDir of taskDirs) {
    const taskId = taskDir; // e.g., T091
    const taskPath = join(rcasdRoot, taskDir);

    // Read phase subdirectories
    let phaseDirs: string[];
    try {
      const fs = await import('node:fs');
      phaseDirs = fs.readdirSync(taskPath).filter((f) => {
        const fullPath = join(taskPath, f);
        return fs.statSync(fullPath).isDirectory();
      });
    } catch {
      continue;
    }

    for (const phaseDir of phaseDirs) {
      const phasePath = join(taskPath, phaseDir);

      // Read markdown files in phase directory
      let mdFiles: string[];
      try {
        const fs = await import('node:fs');
        mdFiles = fs.readdirSync(phasePath).filter((f) => f.endsWith('.md'));
      } catch {
        continue;
      }

      for (const mdFile of mdFiles) {
        const filePath = join(phasePath, mdFile);
        let content: string;
        let mtime: Date;

        try {
          content = readFileSync(filePath, 'utf-8');
          const stat = statSync(filePath);
          mtime = new Date(stat.mtime);
        } catch {
          skipped++;
          continue;
        }

        // Generate manifest entry
        const slug = stringToSlug(mdFile.replace(/\.md$/, ''));
        const id = `${taskId}-rcasd-${phaseDir}-${slug}`;
        const contentHash = computeContentHash(content);
        const sourceFile = join('.cleo', 'rcasd', taskId, phaseDir, mdFile);
        const createdAt = mtime.toISOString();

        // Determine type from phase directory
        const type = PHASE_TO_TYPE[phaseDir] || 'implementation';

        // Prepare metadata
        const metadataJson = {
          phase: phaseDir,
          rcasd_origin: true,
        };

        // Handle atypical files per §3.5
        if (
          (phaseDir === 'consensus' && mdFile === 'auto-complete-policy.md') ||
          (phaseDir === 'decomposition' && mdFile === 'worker-specs.md')
        ) {
          (metadataJson as Record<string, unknown>).filename_note =
            'non-T-prefixed or generic filename';
        }

        if (
          phaseDir === 'decomposition' &&
          mdFile === 'T1008-worker-spec.md' &&
          taskId === 'T1007'
        ) {
          (metadataJson as Record<string, unknown>).cross_task_ref = 'T1008';
        }

        // Insert into pipeline_manifest using INSERT OR IGNORE
        try {
          await db
            .insert(pipelineManifest)
            .values({
              id,
              taskId,
              epicId: null,
              sessionId: null,
              type,
              content,
              contentHash,
              status: 'active',
              distilled: false,
              brainObsId: null,
              sourceFile,
              metadataJson: JSON.stringify(metadataJson),
              createdAt,
              archivedAt: null,
            })
            .onConflictDoNothing();
          ingested++;
        } catch (err) {
          // Log but continue
          console.error(`Failed to ingest ${id}:`, err);
          skipped++;
        }
      }
    }
  }

  return { ingested, skipped };
}

/**
 * Ingest loose agent-output markdown files into pipeline_manifest.
 *
 * Reads `.cleo/agent-outputs/*.md` (maxdepth=1, no subdirectory recursion) and
 * inserts each as a pipeline_manifest row with:
 * - task_id: extracted from filename using T\d+ pattern, or null
 * - type: inferred from filename per §4.3 and overrides
 * - content: full file contents
 * - source_file: relative path: `.cleo/agent-outputs/<filename>`
 * - metadata_json: {loose_origin: true, original_filename, ...}
 *
 * Uses INSERT OR IGNORE on content_hash for idempotency.
 *
 * @param projectRoot - absolute path to project root
 * @param db - Drizzle ORM database instance
 * @returns {ingested, skipped}
 */
export async function ingestLooseAgentOutputs(
  projectRoot: string,
  db: NodeSQLiteDatabase,
): Promise<IngestionResult> {
  const agentOutputDir = join(projectRoot, '.cleo', 'agent-outputs');
  let ingested = 0;
  let skipped = 0;

  // Check if agent-outputs directory exists
  if (!existsSync(agentOutputDir)) {
    return { ingested: 0, skipped: 0 };
  }

  // Read markdown files at maxdepth 1
  let mdFiles: string[];
  try {
    const fs = await import('node:fs');
    mdFiles = fs.readdirSync(agentOutputDir).filter((f) => {
      const fullPath = join(agentOutputDir, f);
      const stat = fs.statSync(fullPath);
      return stat.isFile() && f.endsWith('.md');
    });
  } catch {
    return { ingested: 0, skipped: 0 };
  }

  for (const mdFile of mdFiles) {
    const filePath = join(agentOutputDir, mdFile);
    let content: string;
    let mtime: Date;

    try {
      content = readFileSync(filePath, 'utf-8');
      const stat = statSync(filePath);
      mtime = new Date(stat.mtime);
    } catch {
      skipped++;
      continue;
    }

    // Extract task ID (may be null)
    const taskId = extractTaskId(mdFile);

    // Infer type from filename
    const type = inferLooseFileType(mdFile);

    // Generate ID
    const slug = stringToSlug(mdFile.replace(/\.md$/, ''));
    const id = taskId ? `${taskId}-loose-${slug}` : `loose-${slug}`;

    const contentHash = computeContentHash(content);
    const sourceFile = join('.cleo', 'agent-outputs', mdFile);
    const createdAt = mtime.toISOString();

    // Prepare metadata
    const metadataJson: Record<string, unknown> = {
      loose_origin: true,
      original_filename: mdFile,
    };

    // Tag flat RCASD phase files per §4.6
    const isRcasdPhase =
      taskId &&
      /^T\d+-(R\d+|CA\d+|[a-z-]+)-(.*)\.(md)$/i.test(mdFile) &&
      FILENAME_TYPE_PATTERNS.some(([pat]) => pat.test(mdFile));
    if (isRcasdPhase) {
      metadataJson.flat_rcasd = true;
    }

    // Insert into pipeline_manifest using INSERT OR IGNORE
    try {
      await db
        .insert(pipelineManifest)
        .values({
          id,
          taskId: taskId ?? null,
          epicId: null,
          sessionId: null,
          type,
          content,
          contentHash,
          status: 'active',
          distilled: false,
          brainObsId: null,
          sourceFile,
          metadataJson: JSON.stringify(metadataJson),
          createdAt,
          archivedAt: null,
        })
        .onConflictDoNothing();
      ingested++;
    } catch (err) {
      // Log but continue
      console.error(`Failed to ingest ${id}:`, err);
      skipped++;
    }
  }

  return { ingested, skipped };
}
