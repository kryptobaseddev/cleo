/**
 * Evidence recording for RCASD lifecycle stages.
 *
 * Records provenance evidence (files, URLs, manifests) linked to
 * lifecycle stages in SQLite.
 *
 * @task T5200
 * @epic T4798
 */

import { eq, like } from 'drizzle-orm';
import { relative, basename } from 'node:path';
import { getDb } from '../../store/sqlite.js';
import * as schema from '../../store/schema.js';
import { getCleoDirAbsolute } from '../paths.js';

// =============================================================================
// TYPES
// =============================================================================

export type EvidenceType = 'file' | 'url' | 'manifest';

export interface EvidenceRecord {
  id: string;
  stageId: string;
  uri: string;
  type: EvidenceType;
  recordedAt: string;
  recordedBy?: string;
  description?: string;
}

// =============================================================================
// RECORD EVIDENCE
// =============================================================================

/**
 * Record an evidence artifact linked to a lifecycle stage.
 *
 * Writes to the SQLite `lifecycle_evidence` table.
 *
 * @param epicId - Epic task ID (e.g. 'T4881')
 * @param stage - Canonical stage name (e.g. 'research')
 * @param uri - URI of the evidence artifact
 * @param type - Evidence type: 'file', 'url', or 'manifest'
 * @param options - Optional agent and description
 * @returns The created evidence record
 */
export async function recordEvidence(
  epicId: string,
  stage: string,
  uri: string,
  type: EvidenceType,
  options?: { agent?: string; description?: string; cwd?: string },
): Promise<EvidenceRecord> {
  const now = new Date().toISOString();
  const stageId = `stage-${epicId}-${stage}`;
  const id = `evidence-${epicId}-${stage}-${Date.now()}`;

  const record: EvidenceRecord = {
    id,
    stageId,
    uri,
    type,
    recordedAt: now,
    recordedBy: options?.agent,
    description: options?.description,
  };

  // SQLite write (best-effort)
  try {
    const db = await getDb(options?.cwd);
    await db
      .insert(schema.lifecycleEvidence)
      .values({
        id,
        stageId,
        uri,
        type,
        recordedAt: now,
        recordedBy: options?.agent ?? null,
        description: options?.description ?? null,
      })
      .run();
  } catch (err) {
    console.warn(`[lifecycle-evidence] Failed to write evidence to SQLite:`, err);
  }

  return record;
}

// =============================================================================
// GET EVIDENCE
// =============================================================================

/**
 * Query evidence records for an epic, optionally filtered by stage.
 *
 * @param epicId - Epic task ID
 * @param stage - Optional stage name filter
 * @param cwd - Optional working directory
 * @returns Array of evidence records
 */
export async function getEvidence(
  epicId: string,
  stage?: string,
  cwd?: string,
): Promise<EvidenceRecord[]> {
  try {
    const db = await getDb(cwd);

    let rows;
    if (stage) {
      const stageId = `stage-${epicId}-${stage}`;
      rows = await db
        .select()
        .from(schema.lifecycleEvidence)
        .where(eq(schema.lifecycleEvidence.stageId, stageId))
        .all();
    } else {
      const stageIdPrefix = `stage-${epicId}-`;
      rows = await db
        .select()
        .from(schema.lifecycleEvidence)
        .where(like(schema.lifecycleEvidence.stageId, `${stageIdPrefix}%`))
        .all();
    }

    return rows.map((row): EvidenceRecord => ({
      id: row.id,
      stageId: row.stageId,
      uri: row.uri,
      type: row.type as EvidenceType,
      recordedAt: row.recordedAt,
      recordedBy: row.recordedBy ?? undefined,
      description: row.description ?? undefined,
    }));
  } catch (err) {
    console.warn(`[lifecycle-evidence] Failed to query evidence:`, err);
    return [];
  }
}

// =============================================================================
// LINK PROVENANCE
// =============================================================================

/**
 * Convenience wrapper to record a file as provenance evidence.
 *
 * Converts the file path to a URI relative to the `.cleo/` directory,
 * sets the type to 'file', and extracts a description from the filename.
 *
 * @param epicId - Epic task ID
 * @param stage - Canonical stage name
 * @param filePath - Absolute or relative path to the file
 * @param cwd - Optional working directory
 * @returns The created evidence record
 */
export async function linkProvenance(
  epicId: string,
  stage: string,
  filePath: string,
  cwd?: string,
): Promise<EvidenceRecord> {
  const cleoDir = getCleoDirAbsolute(cwd);
  const relativeUri = relative(cleoDir, filePath);
  const description = basename(filePath);

  return recordEvidence(epicId, stage, relativeUri, 'file', {
    description,
    cwd,
  });
}

// =============================================================================
// EVIDENCE SUMMARY
// =============================================================================

/**
 * Aggregate evidence counts per stage for an epic.
 *
 * @param epicId - Epic task ID
 * @param cwd - Optional working directory
 * @returns Array of per-stage summaries with type breakdowns
 */
export async function getEvidenceSummary(
  epicId: string,
  cwd?: string,
): Promise<{ stage: string; count: number; types: Record<EvidenceType, number> }[]> {
  try {
    const db = await getDb(cwd);
    const stageIdPrefix = `stage-${epicId}-`;

    const rows = await db
      .select()
      .from(schema.lifecycleEvidence)
      .where(like(schema.lifecycleEvidence.stageId, `${stageIdPrefix}%`))
      .all();

    // Group by stage
    const stageMap = new Map<string, { count: number; types: Record<EvidenceType, number> }>();

    for (const row of rows) {
      const stage = row.stageId.replace(stageIdPrefix, '');
      if (!stageMap.has(stage)) {
        stageMap.set(stage, { count: 0, types: { file: 0, url: 0, manifest: 0 } });
      }
      const entry = stageMap.get(stage)!;
      entry.count++;
      entry.types[row.type as EvidenceType]++;
    }

    return Array.from(stageMap.entries()).map(([stage, data]) => ({
      stage,
      count: data.count,
      types: data.types,
    }));
  } catch (err) {
    console.warn(`[lifecycle-evidence] Failed to get evidence summary:`, err);
    return [];
  }
}
