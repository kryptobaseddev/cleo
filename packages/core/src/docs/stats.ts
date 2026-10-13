/**
 * `docs.stats` — per-project CleoDocs adoption metrics (T13363, spec §7/§9).
 *
 * Emitted so the CleoDocs re-architecture is judged by behaviour, not by
 * file counts in the store:
 *
 *   - **add:update ratio** — `docs.add` vs `docs.update` entries in the docs
 *     audit log (`.cleo/audit/docs-audit.jsonl`, via {@link readAuditLog}).
 *     The pilot's starting point is ~10:1.
 *   - **loose-markdown count** — `*.md` files TRACKED BY GIT outside the
 *     CleoDocs store (`git ls-files '*.md'` minus the store). Using the index
 *     makes the scan gitignore-aware by construction: dependency trees,
 *     VCS internals, `.cleo/council-runs`, and nested git worktrees never
 *     appear because real projects ignore them. The Council baseline counts
 *     (~751 axiom-app + 1,265 admin-operations) were of tracked/counted
 *     loose files, so this is the comparable shape. UNTracked loose `.md`
 *     files are intentionally out of scope — they are invisible to the
 *     adoption signal. Outside a git work tree the metric is 0 (there is no
 *     tracked-files notion to measure).
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
 * @task T13629 — loose-markdown scan is git ls-files-based (gitignore-aware)
 * @epic T13340
 * @saga T13339
 */

import { spawnSync } from 'node:child_process';
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
 * Directory names excluded from the loose-markdown count. The gitignore-aware
 * `git ls-files` scan already keeps these out of the index in real projects;
 * the filter below is defense-in-depth for a project that force-adds one.
 * `.cleo` covers the CleoDocs storage surfaces (attachments, blobs) and
 * `.cleo/council-runs` (the Council workload store).
 */
const EXCLUDED_DIR_NAMES = ['node_modules', '.git', '.cleo'] as const;

/**
 * Count loose `*.md` files — git-tracked markdown outside the CleoDocs
 * store. `git ls-files '*.md'` from the project root returns the tracked
 * markdown paths (gitignore-aware); the store and dependency trees are then
 * filtered defensively. Untracked files are intentionally NOT counted.
 *
 * @param projectRoot - Absolute project root (must be a git work tree).
 * @returns The count plus what was scanned and excluded; `count` is 0 with
 *   empty `scannedDirs` when the root is not a git work tree.
 */
export function countLooseMarkdown(projectRoot: string): LooseMarkdownMetrics {
  const excludedDirs = [...EXCLUDED_DIR_NAMES];
  const result = spawnSync('git', ['ls-files', '--', '*.md'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    // Not a git work tree (or git unavailable): the metric counts tracked
    // loose markdown only, so there is nothing to measure.
    return { count: 0, scannedDirs: [], excludedDirs };
  }
  const tracked = result.stdout.split('\n').filter((line) => line.length > 0);
  const counted = tracked.filter((p) => !p.startsWith('.cleo/') && !p.startsWith('node_modules/'));
  const scanned = new Set<string>();
  for (const path of counted) {
    scanned.add(path.includes('/') ? path.slice(0, path.indexOf('/')) : '(root)');
  }
  return { count: counted.length, scannedDirs: [...scanned].sort(), excludedDirs };
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
