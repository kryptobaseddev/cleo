/**
 * ADR DB Sync (ADR-017)
 *
 * Syncs ADR markdown frontmatter into the architecture_decisions DB table.
 *
 * Single command: ct adr sync (or admin.adr.sync)
 * - Updates architecture_decisions + adr_task_links in SQLite (runtime search)
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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adrTaskLinks, architectureDecisions, tasks } from '../store/tasks-schema.js';
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
    .map((t) => t.trim())
    .filter((t) => /^T\d{1,5}$/.test(t));
}

/** Collect all ADR .md files recursively (top-level + archive/) */
function collectAdrFiles(dir: string): Array<{ file: string; relPath: string }> {
  const results: Array<{ file: string; relPath: string }> = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sub = join(dir, entry.name);
      let subFiles: string[];
      try {
        subFiles = readdirSync(sub);
      } catch {
        continue;
      }
      for (const f of subFiles) {
        if (f.endsWith('.md') && /^ADR-\d+/.test(f)) {
          results.push({ file: f, relPath: `${entry.name}/${f}` });
        }
      }
    } else if (entry.name.endsWith('.md') && /^ADR-\d+/.test(entry.name)) {
      results.push({ file: entry.name, relPath: entry.name });
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
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
  const adrsDir = join(projectRoot, '.cleo', 'adrs');
  const result: AdrSyncResult = { inserted: 0, updated: 0, skipped: 0, errors: [], warnings: [] };

  if (!existsSync(adrsDir)) {
    return result;
  }

  const { getDb } = await import('../store/sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getDb(projectRoot);
  const now = new Date().toISOString();

  // Only sync top-level files to DB (archive/ ADRs are superseded).
  // T10165 — the previous code also collected archive/ files to feed the
  // JSONL export; the export is now retired so we scan top-level only.
  const activeFiles = collectAdrFiles(adrsDir).filter((f) => !f.relPath.includes('/'));

  // T10165 — JSONL export retired. The legacy `manifestEntries` collector
  // and the `writeFileSync(adr-index.jsonl)` call that lived here are gone;
  // canonical store for the same metadata is the `attachments` table
  // populated by `packages/core/src/migration/manual/T10165-backfill-adr-index.ts`.

  // --- DB sync (active ADRs only) ---
  for (const { file, relPath } of activeFiles) {
    try {
      const filePath = join(adrsDir, relPath);
      const record = parseAdrFile(filePath, projectRoot);
      const fm = record.frontmatter;
      const dbRelPath = `.cleo/adrs/${relPath}`;
      const content = readFileSync(filePath, 'utf-8');

      let supersedesId = fm.Supersedes ? extractAdrIdFromRef(fm.Supersedes) : null;
      let supersededById = fm['Superseded By'] ? extractAdrIdFromRef(fm['Superseded By']) : null;
      let amendsId = fm.Amends ? extractAdrIdFromRef(fm.Amends) : null;

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
