/**
 * `docs.stats` — per-project CleoDocs adoption metrics (T13363, spec §7/§9).
 *
 * Emitted so the CleoDocs re-architecture is judged by behaviour, not by
 * file counts in the store:
 *
 *   - **add:update ratio** — `docs.add` vs `docs.update` entries in the docs
 *     audit log (`.cleo/audit/docs-audit.jsonl`, via {@link readAuditLog}).
 *     The pilot's starting point is ~10:1.
 *   - **loose-markdown count** — `*.md` files under the project root that
 *     live OUTSIDE the CleoDocs store: dependency trees (`node_modules`),
 *     VCS internals (`.git`), the store itself (`.cleo` — including
 *     `.cleo/council-runs`, which is the Council workload store now), and
 *     any nested git worktree (a gitlink `.git` file). The corrected
 *     Council baseline is ~751 (axiom-app) + 1,265 (admin-operations); the
 *     shape here (count + scanned/excluded dirs) is comparable across
 *     projects.
 *   - **wikilinks edges** — row count of the `docs_wikilinks` graph table
 *     (T11826), through the chokepoint drizzle handle.
 *   - **decisions linked** — live `decision_adr_links` rows (status
 *     `linked`, T13359). The legacy ledger `adrPath` field has no read
 *     accessor, so only the link table contributes.
 *
 * Read-only: never writes to the store, the filesystem, or the audit log.
 *
 * @module
 * @task T13363
 * @epic T13340
 * @saga T13339
 */

import { readdirSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  DocsAddUpdateMetrics,
  DocsStatsResult,
  LooseMarkdownMetrics,
} from '@cleocode/contracts/operations/docs.js';
import { count } from 'drizzle-orm';
import { countLinkedDecisionAdrs } from '../store/decision-adr-links.js';
import { docsWikilinks } from '../store/schema/attachments.js';
import { getDb } from '../store/sqlite.js';
import { readAuditLog } from './docs-audit.js';

/**
 * Directory names never scanned for loose markdown, anywhere in the tree.
 * `.cleo` covers the CleoDocs storage surfaces (attachments, blobs) and
 * `.cleo/council-runs` (the Council workload store).
 */
const EXCLUDED_DIR_NAMES = ['node_modules', '.git', '.cleo'] as const;

/** Whether `dir` carries a `.git` entry — a repo root, or a worktree gitlink. */
function dirHasGitMarker(dir: string): boolean {
  try {
    return readdirSync(dir).includes('.git');
  } catch {
    return false;
  }
}

/**
 * Recursively count `*.md` files under `dir`. Any nested directory that is
 * itself a repo root or git worktree (a `.git` entry) is skipped whole and
 * recorded; symlinks are not followed.
 */
function countMarkdownFiles(
  dir: string,
  isScanRoot: boolean,
  excludedDetected: Set<string>,
): number {
  if (!isScanRoot && dirHasGitMarker(dir)) {
    excludedDetected.add(basename(dir));
    return 0;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // unreadable dir: skip silently
  }
  let mdCount = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if ((EXCLUDED_DIR_NAMES as readonly string[]).includes(entry.name)) continue;
      mdCount += countMarkdownFiles(join(dir, entry.name), false, excludedDetected);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      mdCount += 1;
    }
  }
  return mdCount;
}

/**
 * Count loose `*.md` files under the project root, excluding dependency
 * trees, VCS internals, the CleoDocs store, and nested git worktrees.
 *
 * @param projectRoot - Absolute project root.
 * @returns The count plus what was scanned and excluded.
 */
export function countLooseMarkdown(projectRoot: string): LooseMarkdownMetrics {
  const excludedDetected = new Set<string>();
  const scannedDirs: string[] = [];
  let mdCount = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return { count: 0, scannedDirs, excludedDirs: [...EXCLUDED_DIR_NAMES] };
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if ((EXCLUDED_DIR_NAMES as readonly string[]).includes(entry.name)) continue;
      scannedDirs.push(entry.name);
      mdCount += countMarkdownFiles(join(projectRoot, entry.name), false, excludedDetected);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Root-level loose *.md files count too.
      mdCount += 1;
    }
  }
  return {
    count: mdCount,
    scannedDirs: scannedDirs.sort(),
    excludedDirs: [...EXCLUDED_DIR_NAMES, ...[...excludedDetected].sort()],
  };
}

/**
 * Compute the per-project adoption metrics for `docs.stats` (T13363).
 *
 * @param opts.projectRoot - Absolute path to the CLEO project root.
 * @returns The metrics envelope (read-only; nothing is written).
 * @task T13363
 */
export async function computeDocsStats(opts: { projectRoot: string }): Promise<DocsStatsResult> {
  const { projectRoot } = opts;

  // Add vs update activity — the audit log is the canonical mutation record.
  const audit = readAuditLog(projectRoot);
  let adds = 0;
  let updates = 0;
  for (const entry of audit.entries) {
    if (entry.op === 'docs.add') adds += 1;
    else if (entry.op === 'docs.update') updates += 1;
  }
  const addUpdate: DocsAddUpdateMetrics = {
    adds,
    updates,
    ratio: updates > 0 ? adds / updates : null,
  };

  const looseMarkdown = countLooseMarkdown(projectRoot);

  // Graph edge count, through the chokepoint drizzle handle (reads only).
  const db = await getDb(projectRoot);
  const edgeRows = await db.select({ n: count() }).from(docsWikilinks).all();
  const wikilinksEdges = edgeRows[0]?.n ?? 0;

  const decisionsLinked = await countLinkedDecisionAdrs(projectRoot);

  const ratioText = addUpdate.ratio === null ? 'n/a' : addUpdate.ratio.toFixed(2);
  return {
    addUpdate,
    looseMarkdown,
    wikilinksEdges,
    decisionsLinked,
    generatedAt: new Date().toISOString(),
    summary:
      `adds ${adds} / updates ${updates} (ratio ${ratioText}); ` +
      `${looseMarkdown.count} loose markdown files; ` +
      `${wikilinksEdges} wikilinks edges; ${decisionsLinked} decisions linked`,
  };
}
