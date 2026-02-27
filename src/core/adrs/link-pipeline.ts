/**
 * RCASD Pipeline ADR Auto-linking (T4942, T4947)
 *
 * When an architecture_decision stage completes for a pipeline task, this
 * module automatically:
 *   1. Finds ADRs in .cleo/adrs/ that reference the task in Related Tasks
 *   2. Upserts those ADRs into architecture_decisions DB
 *   3. Creates adr_task_links with link_type='implements'
 *   4. Links related ADRs via adr_relations if cross-references exist
 *
 * Called from lifecycle/pipeline.ts when advancing FROM architecture_decision.
 *
 * @task T4947
 * @see ADR-017 §5.3 for adr_task_links and adr_relations schemas
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../store/sqlite.js';
import { architectureDecisions, adrTaskLinks, adrRelations } from '../../store/schema.js';
import { parseAdrFile } from './parse.js';

export interface PipelineAdrLinkResult {
  linked: Array<{ adrId: string; taskId: string }>;
  synced: number;
  skipped: number;
  errors: Array<{ file: string; error: string }>;
}

/**
 * Parse comma-separated task IDs from a Related Tasks value
 */
function parseTaskIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(t => t.trim())
    .filter(t => /^T\d{1,5}$/.test(t));
}

/**
 * Scan .cleo/adrs/ for ADRs that reference the given taskId in Related Tasks.
 * Returns file paths of matching ADRs.
 */
function findAdrsForTask(adrsDir: string, taskId: string): string[] {
  if (!existsSync(adrsDir)) return [];

  return readdirSync(adrsDir)
    .filter(f => f.endsWith('.md') && /^ADR-\d+/.test(f))
    .filter(file => {
      try {
        const content = readFileSync(join(adrsDir, file), 'utf-8');
        // Quick check before parsing — look for task ID in Related Tasks line
        const relatedTasksMatch = content.match(/^\*\*Related Tasks\*\*:\s*(.+)$/m);
        if (!relatedTasksMatch) return false;
        const taskIds = parseTaskIds(relatedTasksMatch[1]);
        return taskIds.includes(taskId);
      } catch {
        return false;
      }
    })
    .map(f => join(adrsDir, f));
}

/**
 * Link ADRs to a pipeline task when the architecture_decision stage completes.
 *
 * @param projectRoot - Absolute path to project root
 * @param taskId      - Task ID that owns the pipeline (e.g., 'T4942')
 */
export async function linkPipelineAdr(
  projectRoot: string,
  taskId: string,
): Promise<PipelineAdrLinkResult> {
  const result: PipelineAdrLinkResult = {
    linked: [],
    synced: 0,
    skipped: 0,
    errors: [],
  };

  const adrsDir = join(projectRoot, '.cleo', 'adrs');
  const matchingFiles = findAdrsForTask(adrsDir, taskId);

  if (matchingFiles.length === 0) {
    return result;
  }

  const db = await getDb(projectRoot);
  const now = new Date().toISOString();

  for (const filePath of matchingFiles) {
    const filename = filePath.split('/').pop()!;
    try {
      const record = parseAdrFile(filePath, projectRoot);
      const fm = record.frontmatter;
      const content = readFileSync(filePath, 'utf-8');
      const relativePath = `.cleo/adrs/${filename}`;

      // Upsert ADR row
      const existing = await db
        .select({ id: architectureDecisions.id })
        .from(architectureDecisions)
        .where(eq(architectureDecisions.id, record.id))
        .all();

      const rowBase = {
        id: record.id,
        title: record.title,
        status: (fm.Status ?? 'proposed') as 'proposed' | 'accepted' | 'superseded' | 'deprecated',
        content,
        filePath: relativePath,
        date: fm.Date ?? '',
        acceptedAt: fm.Accepted ?? null,
        gate: (fm.Gate ?? null) as 'HITL' | 'automated' | null,
        gateStatus: (fm['Gate Status'] ?? null) as 'pending' | 'passed' | 'waived' | null,
        amendsId: null as string | null,
        supersedesId: null as string | null,
        supersededById: null as string | null,
        summary: fm.Summary ?? null,
        keywords: fm.Keywords ?? null,
        topics: fm.Topics ?? null,
        updatedAt: now,
      };

      if (existing.length > 0) {
        await db
          .update(architectureDecisions)
          .set(rowBase)
          .where(eq(architectureDecisions.id, record.id));
      } else {
        await db
          .insert(architectureDecisions)
          .values({ ...rowBase, createdAt: now });
      }
      result.synced++;

      // Create implements link (upsert: delete existing, insert new)
      // First remove any existing link between this ADR and task
      await db
        .delete(adrTaskLinks)
        .where(
          and(
            eq(adrTaskLinks.adrId, record.id),
            eq(adrTaskLinks.taskId, taskId),
          ),
        );

      await db
        .insert(adrTaskLinks)
        .values({ adrId: record.id, taskId, linkType: 'implements' });

      result.linked.push({ adrId: record.id, taskId });

      // Cross-reference: if ADR references other ADRs via Related ADRs, create adr_relations
      if (fm['Related ADRs']) {
        const relatedIds = fm['Related ADRs']
          .split(',')
          .map(r => r.trim())
          .filter(r => /^ADR-\d+$/.test(r));

        for (const toId of relatedIds) {
          try {
            // Only create relation if target ADR exists in DB
            const targetExists = await db
              .select({ id: architectureDecisions.id })
              .from(architectureDecisions)
              .where(eq(architectureDecisions.id, toId))
              .all();

            if (targetExists.length > 0) {
              await db
                .insert(adrRelations)
                .values({ fromAdrId: record.id, toAdrId: toId, relationType: 'related' })
                .onConflictDoNothing();
            }
          } catch {
            // Ignore relation errors — non-fatal
          }
        }
      }
    } catch (err) {
      result.errors.push({ file: filename, error: String(err) });
      result.skipped++;
    }
  }

  return result;
}
