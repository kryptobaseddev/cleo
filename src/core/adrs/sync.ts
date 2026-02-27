/**
 * ADR DB Sync (ADR-017)
 *
 * Syncs ADR markdown frontmatter into the architecture_decisions DB table
 * AND regenerates .cleo/adrs/MANIFEST.jsonl in one pass.
 *
 * Single command: ct adr sync (or admin.adr.sync)
 * - Updates architecture_decisions + adr_task_links in SQLite (runtime search)
 * - Rewrites MANIFEST.jsonl (portable export, includes archive/ ADRs)
 *
 * @task T4792
 * @task T4942 — MANIFEST generation folded in so one command keeps both in sync
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
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

/** Collect all ADR .md files recursively (top-level + archive/) */
function collectAdrFiles(dir: string): Array<{ file: string; relPath: string }> {
  const results: Array<{ file: string; relPath: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = join(dir, entry.name);
      for (const f of readdirSync(sub)) {
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
 * Sync all ADR markdown files into the architecture_decisions table
 * AND regenerate MANIFEST.jsonl in one pass.
 */
export async function syncAdrsToDb(projectRoot: string): Promise<AdrSyncResult> {
  const adrsDir = join(projectRoot, '.cleo', 'adrs');
  const result: AdrSyncResult = { inserted: 0, updated: 0, skipped: 0, errors: [] };

  if (!existsSync(adrsDir)) {
    return result;
  }

  const db = await getDb(projectRoot);
  const now = new Date().toISOString();

  const allFiles = collectAdrFiles(adrsDir);
  // Only sync top-level files to DB (archive/ ADRs are superseded)
  const activeFiles = allFiles.filter(f => !f.relPath.includes('/'));
  const manifestEntries: Record<string, unknown>[] = [];

  // --- DB sync (active ADRs only) ---
  for (const { file, relPath } of activeFiles) {
    try {
      const filePath = join(adrsDir, relPath);
      const record = parseAdrFile(filePath, projectRoot);
      const fm = record.frontmatter;
      const dbRelPath = `.cleo/adrs/${relPath}`;
      const content = readFileSync(filePath, 'utf-8');

      const supersedesId = fm.Supersedes ? extractAdrIdFromRef(fm.Supersedes) : null;
      const supersededById = fm['Superseded By'] ? extractAdrIdFromRef(fm['Superseded By']) : null;
      const amendsId = fm.Amends ? extractAdrIdFromRef(fm.Amends) : null;

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
        await db.update(architectureDecisions).set(rowBase).where(eq(architectureDecisions.id, record.id));
        result.updated++;
      } else {
        await db.insert(architectureDecisions).values({ ...rowBase, createdAt: now });
        result.inserted++;
      }

      await db.delete(adrTaskLinks).where(eq(adrTaskLinks.adrId, record.id));
      if (fm['Related Tasks']) {
        for (const taskId of parseTaskIds(fm['Related Tasks'])) {
          await db.insert(adrTaskLinks).values({ adrId: record.id, taskId, linkType: 'related' });
        }
      }
    } catch (err) {
      result.errors.push({ file, error: String(err) });
    }
  }

  // --- MANIFEST.jsonl (all ADRs including archive/) ---
  for (const { relPath } of allFiles) {
    try {
      const filePath = join(adrsDir, relPath);
      const record = parseAdrFile(filePath, projectRoot);
      const fm = record.frontmatter;

      const entry: Record<string, unknown> = {
        id: record.id,
        file: `.cleo/adrs/${relPath}`,
        title: record.title,
        status: fm.Status ?? 'unknown',
        date: fm.Date ?? '',
      };
      if (fm.Accepted) entry['accepted'] = fm.Accepted;
      if (fm.Supersedes) entry['supersedes'] = fm.Supersedes;
      if (fm['Superseded By']) entry['supersededBy'] = fm['Superseded By'];
      if (fm.Amends) entry['amends'] = fm.Amends;
      if (fm['Amended By']) entry['amendedBy'] = fm['Amended By'];
      if (fm['Related Tasks']) {
        entry['relatedTasks'] = fm['Related Tasks'].split(',').map(s => s.trim()).filter(Boolean);
      }
      if (fm.Gate) entry['gate'] = fm.Gate;
      if (fm['Gate Status']) entry['gateStatus'] = fm['Gate Status'];
      if (fm.Summary) entry['summary'] = fm.Summary;
      if (fm.Keywords) entry['keywords'] = fm.Keywords.split(',').map(s => s.trim()).filter(Boolean);
      if (fm.Topics) entry['topics'] = fm.Topics.split(',').map(s => s.trim()).filter(Boolean);

      manifestEntries.push(entry);
    } catch {
      // Non-fatal: a parse failure in one ADR doesn't block the manifest
    }
  }

  writeFileSync(
    join(adrsDir, 'MANIFEST.jsonl'),
    manifestEntries.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf-8',
  );

  return result;
}
