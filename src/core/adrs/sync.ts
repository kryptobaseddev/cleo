/**
 * ADR DB Sync (ADR-017)
 *
 * Syncs ADR markdown frontmatter into the architecture_decisions DB table.
 * Upserts each ADR row and rebuilds adr_task_links from Related Tasks field.
 *
 * @task T4792
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '../../store/sqlite.js';
import { architectureDecisions, adrTaskLinks } from '../../store/schema.js';
import { parseAdrFile } from './parse.js';
import type { AdrSyncResult } from './types.js';

/** Extract a bare ADR-NNN id from a frontmatter value like "ADR-006 (§3 ...)" */
function extractAdrIdFromRef(ref: string): string | null {
  const m = ref.match(/^(ADR-\d+)/);
  return m ? m[1]! : null;
}

/** Parse comma-separated task IDs from a Related Tasks value */
function parseTaskIds(raw: string): string[] {
  return raw
    .split(',')
    .map(t => t.trim())
    .filter(t => /^T\d{1,5}$/.test(t));
}

/** Sync all ADR markdown files into the architecture_decisions table */
export async function syncAdrsToDb(projectRoot: string): Promise<AdrSyncResult> {
  const adrsDir = join(projectRoot, '.cleo', 'adrs');
  const result: AdrSyncResult = { inserted: 0, updated: 0, skipped: 0, errors: [] };

  if (!existsSync(adrsDir)) {
    return result;
  }

  const db = await getDb(projectRoot);
  const now = new Date().toISOString();

  const files = readdirSync(adrsDir)
    .filter(f => f.endsWith('.md') && /^ADR-\d+/.test(f));

  for (const file of files) {
    try {
      const filePath = join(adrsDir, file);
      const record = parseAdrFile(filePath, projectRoot);
      const fm = record.frontmatter;
      const relativePath = `.cleo/adrs/${file}`;
      const content = readFileSync(filePath, 'utf-8');

      const supersedesId = fm.Supersedes ? extractAdrIdFromRef(fm.Supersedes) : null;
      const supersededById = fm['Superseded By'] ? extractAdrIdFromRef(fm['Superseded By']) : null;
      const amendsId = fm.Amends ? extractAdrIdFromRef(fm.Amends) : null;

      const rowBase = {
        id: record.id,
        title: record.title,
        status: fm.Status ?? 'proposed',
        content,
        filePath: relativePath,
        date: fm.Date ?? '',
        acceptedAt: fm.Accepted ?? null,
        gate: (fm.Gate ?? null) as 'HITL' | 'automated' | null,
        gateStatus: (fm['Gate Status'] ?? null) as 'pending' | 'passed' | 'waived' | null,
        amendsId,
        supersedesId,
        supersededById,
        summary: fm.Summary ?? null,
        keywords: fm.Keywords ?? null,
        topics: fm.Topics ?? null,
        updatedAt: now,
      } as const;

      // Check if row already exists
      const existing = await db
        .select({ id: architectureDecisions.id })
        .from(architectureDecisions)
        .where(eq(architectureDecisions.id, record.id))
        .all();

      if (existing.length > 0) {
        await db
          .update(architectureDecisions)
          .set(rowBase)
          .where(eq(architectureDecisions.id, record.id));
        result.updated++;
      } else {
        await db
          .insert(architectureDecisions)
          .values({ ...rowBase, createdAt: now });
        result.inserted++;
      }

      // Rebuild task links: delete then re-insert
      await db
        .delete(adrTaskLinks)
        .where(eq(adrTaskLinks.adrId, record.id));

      if (fm['Related Tasks']) {
        const taskIds = parseTaskIds(fm['Related Tasks']);
        for (const taskId of taskIds) {
          await db
            .insert(adrTaskLinks)
            .values({ adrId: record.id, taskId, linkType: 'related' });
        }
      }
    } catch (err) {
      result.errors.push({ file, error: String(err) });
    }
  }

  return result;
}
