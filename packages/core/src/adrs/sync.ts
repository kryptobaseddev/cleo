/**
 * ADR DB Sync (ADR-017)
 *
 * Syncs ADR markdown frontmatter into the architecture_decisions DB table.
 *
 * Single command: ct adr sync (or admin.adr.sync)
 * - Updates architecture_decisions + adr_task_links in SQLite (runtime search)
 *
 * ADR files are read from the canon ADR home (`docs/adr/`, see `home.ts`;
 * T14108 retired the `.cleo/adrs/` markdown mirror).
 *
 * NOTE: `.cleo/adrs/adr-index.jsonl` is FROZEN as of T10165 (Saga T9855). The
 * canonical store for the same metadata is the `attachments` table provenance
 * columns shipped by T10158, reachable via `cleo docs fetch <adr-slug>` and
 * the docs SSoT graph (T10162/T10164). This sync no longer writes the JSONL;
 * the file is preserved on disk for one deprecation cycle so external scripts
 * that still read it continue to work — append a NEW line to it and the
 * `cleo check canon docs` gate fails with `E_ADR_INDEX_JSONL_FROZEN`.
 *
 * This file is DISTINCT from the agent pipeline_manifest (ADR-027). The
 * pipeline_manifest for agent outputs lives in tasks.db and is accessed via
 * `cleo manifest` CLI.
 *
 * @task T4792
 * @task T4942 — ADR index generation folded in so one command keeps both in sync
 * @task T10165 — adr-index.jsonl write path retired; backfilled into attachments
 */

import { readFileSync } from 'node:fs';
import { adrTaskLinks, architectureDecisions, tasks } from '../store/tasks-schema.js';
import { loadAdrs, resolveAdrRef } from './home.js';
import type { AdrSyncResult } from './types.js';

/** Parse comma-separated task IDs from a Related Tasks value */
function parseTaskIds(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => /^T\d{1,5}$/.test(t));
}

/**
 * Sync all ADR markdown files into the architecture_decisions table.
 *
 * As of T10165 (Saga T9855) the `.cleo/adrs/adr-index.jsonl` portability
 * export is frozen — the canonical store for the same metadata is now the
 * `attachments` table (T10158 provenance columns).
 */
// SSoT-EXEMPT: zero-params op — no Params contract needed; ADR-057 D1 applies to parameterized ops only
export async function syncAdrsToDb(projectRoot: string): Promise<AdrSyncResult> {
  const result: AdrSyncResult = { inserted: 0, updated: 0, skipped: 0, errors: [], warnings: [] };
  const adrs = loadAdrs(projectRoot);
  if (adrs.length === 0) {
    return result;
  }

  const { getDb } = await import('../store/sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getDb(projectRoot);
  const now = new Date().toISOString();

  // T10165 — JSONL export retired. The legacy `manifestEntries` collector
  // and the `writeFileSync(adr-index.jsonl)` call that lived here are gone;
  // canonical store for the same metadata is the `attachments` table
  // populated by `packages/core/src/migration/manual/T10165-backfill-adr-index.ts`.

  // --- DB sync (active ADRs only) ---
  // Ids are unique across the ADR home (loadAdrs), so ADRs sharing a number
  // never overwrite each other's row or links (T14108).
  for (const { file: adrFile, record } of adrs) {
    const { name: file, absPath: filePath, relPath: dbRelPath } = adrFile;
    try {
      const fm = record.frontmatter;
      const content = readFileSync(filePath, 'utf-8');

      let supersedesId = fm.Supersedes ? resolveAdrRef(fm.Supersedes, adrs) : null;
      let supersededById = fm['Superseded By'] ? resolveAdrRef(fm['Superseded By'], adrs) : null;
      let amendsId = fm.Amends ? resolveAdrRef(fm.Amends, adrs) : null;

      // Validate FK references exist before insert/update to avoid constraint violations
      if (supersedesId) {
        const exists = await db
          .select({ id: architectureDecisions.id })
          .from(architectureDecisions)
          .where(eq(architectureDecisions.id, supersedesId))
          .all();
        if (exists.length === 0) {
          result.warnings.push(
            `${record.id}: supersedes target ${supersedesId} not found in DB, setting to null`,
          );
          supersedesId = null;
        }
      }
      if (supersededById) {
        const exists = await db
          .select({ id: architectureDecisions.id })
          .from(architectureDecisions)
          .where(eq(architectureDecisions.id, supersededById))
          .all();
        if (exists.length === 0) {
          result.warnings.push(
            `${record.id}: supersededBy target ${supersededById} not found in DB, setting to null`,
          );
          supersededById = null;
        }
      }
      if (amendsId) {
        const exists = await db
          .select({ id: architectureDecisions.id })
          .from(architectureDecisions)
          .where(eq(architectureDecisions.id, amendsId))
          .all();
        if (exists.length === 0) {
          result.warnings.push(
            `${record.id}: amends target ${amendsId} not found in DB, setting to null`,
          );
          amendsId = null;
        }
      }

      const rowBase = {
        id: record.id,
        title: record.title,
        status: fm.Status ?? 'proposed',
        content,
        filePath: dbRelPath,
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
        await db.insert(architectureDecisions).values({ ...rowBase, createdAt: now });
        result.inserted++;
      }

      await db.delete(adrTaskLinks).where(eq(adrTaskLinks.adrId, record.id));
      if (fm['Related Tasks']) {
        for (const taskId of parseTaskIds(fm['Related Tasks'])) {
          // Validate task exists before inserting link to avoid FK constraint violation
          const taskExists = await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .all();
          if (taskExists.length === 0) {
            result.warnings.push(
              `${record.id}: related task ${taskId} not found in DB, skipping link`,
            );
            continue;
          }
          await db.insert(adrTaskLinks).values({ adrId: record.id, taskId, linkType: 'related' });
        }
      }
    } catch (err) {
      result.errors.push({ file, error: String(err) });
    }
  }

  // ADR portability index (`.cleo/adrs/adr-index.jsonl`) is frozen as of
  // T10165. The previous regeneration loop + `writeFileSync` call was
  // removed in the same commit that added the `attachments` table backfill
  // at `packages/core/src/migration/manual/T10165-backfill-adr-index.ts`.

  return result;
}
