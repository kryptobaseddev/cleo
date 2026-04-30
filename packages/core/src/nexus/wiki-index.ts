/**
 * Nexus wiki index generator - community-grouped symbol listings.
 *
 * Generates wiki structure:
 * - One markdown file per community listing its symbols
 * - Overview.md linking all communities
 * - Simple tables with symbol metadata (name, kind, file path, call counts)
 * - Optional LOOM LLM narrative summaries per community
 *
 * Supports:
 * - `--community <id>` filtering: generate a single community's doc only
 * - `--incremental` mode: skip communities unchanged since last run via
 *   git diff + `.cleo/wiki-state.json` state tracking
 * - LOOM provider injection: graceful fallback to scaffold mode when absent
 *
 * @task T1060
 * @task T1109
 * @epic T1042
 */

import { execFile as execFileNode } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  CommunityWikiStats,
  GenerateNexusWikiOptions,
  NexusWikiResult,
  WikiDbHandle,
  WikiStateFile,
  WikiSymbolRow,
} from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getNexusDbPath, getNexusNativeDb } from '../store/nexus-sqlite.js';

const execFileAsync = promisify(execFileNode);

// ─── Constants ────────────────────────────────────────────────────────────────

/** State file path relative to project root. */
const WIKI_STATE_FILENAME = '.cleo/wiki-state.json';

// ─── Git helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the current HEAD commit SHA.
 * Returns `null` if git is unavailable or not in a git repo.
 */
async function resolveHeadSha(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      timeout: 5_000,
      cwd: projectRoot,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get files changed between two git refs.
 * Returns an empty array if git fails or refs are unavailable.
 */
async function getChangedFiles(
  projectRoot: string,
  fromSha: string,
  toSha: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', fromSha, toSha], {
      timeout: 10_000,
      cwd: projectRoot,
    });
    return stdout
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

// ─── Wiki state helpers ───────────────────────────────────────────────────────

/**
 * Read `.cleo/wiki-state.json` from the project root.
 * Returns `null` if the file does not exist.
 */
async function readWikiState(projectRoot: string): Promise<WikiStateFile | null> {
  const statePath = join(projectRoot, WIKI_STATE_FILENAME);
  if (!existsSync(statePath)) return null;
  try {
    const raw = await readFile(statePath, 'utf-8');
    return JSON.parse(raw) as WikiStateFile;
  } catch {
    return null;
  }
}

/**
 * Write `.cleo/wiki-state.json` to the project root.
 * Creates `.cleo/` directory if needed.
 */
async function writeWikiState(projectRoot: string, state: WikiStateFile): Promise<void> {
  const cleoDirPath = join(projectRoot, '.cleo');
  await mkdir(cleoDirPath, { recursive: true });
  const statePath = join(projectRoot, WIKI_STATE_FILENAME);
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ─── LOOM prompt builder ─────────────────────────────────────────────────────

/**
 * Build the prompt sent to the LOOM provider for a community narrative summary.
 */
function buildLoomPrompt(communityId: string, symbols: WikiSymbolRow[]): string {
  const symbolList = symbols
    .slice(0, 50) // cap at 50 to keep prompt concise
    .map(
      (s) =>
        `- ${s.name} (${s.kind})${s.filePath ? ` in ${s.filePath}` : ''}` +
        ` [${s.callerCount} callers, ${s.calleeCount} callees]`,
    )
    .join('\n');

  return (
    `You are a code documentation assistant. Given the following list of symbols from ` +
    `community "${communityId}" in a TypeScript codebase, write a concise 2-4 sentence ` +
    `module narrative summary that describes what this community does, its main responsibilities, ` +
    `and how it fits into the system. Be specific about the domain.\n\n` +
    `Symbols:\n${symbolList}\n\n` +
    `Summary (2-4 sentences, plain prose, no bullet points):`
  );
}

// ─── Markdown builders ────────────────────────────────────────────────────────

/**
 * Build markdown for a single community.
 *
 * @param communityId - Community identifier
 * @param symbols - Members of this community
 * @param loomNarrative - Optional LLM-generated narrative from LOOM
 */
function buildCommunityMarkdown(
  communityId: string,
  symbols: WikiSymbolRow[],
  loomNarrative: string | null,
): string {
  const lines: string[] = [`# Community ${communityId}`, '', `**Symbols**: ${symbols.length}`, ''];

  if (loomNarrative) {
    lines.push('## Summary');
    lines.push('');
    lines.push(loomNarrative.trim());
    lines.push('');
  }

  lines.push('## Members');
  lines.push('');
  lines.push('| Name | Kind | File Path | Callers | Callees |');
  lines.push('|------|------|-----------|---------|---------|');

  for (const sym of symbols) {
    const filePath = sym.filePath ?? '(no file)';
    const line = `| \`${sym.name}\` | \`${sym.kind}\` | ${filePath} | ${sym.callerCount} | ${sym.calleeCount} |`;
    lines.push(line);
  }

  lines.push('');
  lines.push('[← Back to overview](./overview.md)');
  lines.push('');

  return lines.join('\n');
}

/**
 * Build overview markdown linking all communities.
 */
function buildOverviewMarkdown(communities: CommunityWikiStats[]): string {
  const totalSymbols = communities.reduce((sum, c) => sum + c.memberCount, 0);

  const lines: string[] = [
    '# NEXUS Wiki Index',
    '',
    `**Communities**: ${communities.length}`,
    `**Total Symbols**: ${totalSymbols}`,
    '',
    '## Community Index',
    '',
    '| Community ID | Members |',
    '|---|---|',
  ];

  for (const community of communities) {
    const link = `[${community.communityId}](./community-${community.communityId}.md)`;
    lines.push(`| ${link} | ${community.memberCount} |`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*Generated by `cleo nexus wiki`.*');
  lines.push('');

  return lines.join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a community-grouped wiki index from nexus.db.
 *
 * Queries all nexus nodes grouped by community_id, then generates:
 * - `<outputDir>/community-<id>.md` per community (or a single community
 *   when `options.communityFilter` is set)
 * - `<outputDir>/overview.md` linking all communities (skipped in single-community mode)
 *
 * LOOM integration: when `options.loomProvider` is supplied, each community
 * doc includes a narrative summary generated via the provider. Graceful
 * fallback to scaffold mode when LOOM is unavailable (no error thrown).
 *
 * Incremental mode: when `options.incremental` is `true`, reads
 * `.cleo/wiki-state.json` for the last-run SHA, runs `git diff` to find
 * changed files, maps changed files to their communities, and skips
 * communities with no changes.
 *
 * @param outputDir - Output directory for wiki files
 * @param projectRoot - Project root for relative path calculation
 * @param options - Optional generation options
 * @returns Generation result with file counts and community stats
 *
 * @example
 * ```ts
 * // Full generation with LOOM provider
 * const result = await generateNexusWikiIndex('.cleo/wiki', '/path/to/project', {
 *   loomProvider: async (prompt) => myLlm.complete(prompt),
 * });
 *
 * // Single-community generation
 * const result = await generateNexusWikiIndex('.cleo/wiki', '/path/to/project', {
 *   communityFilter: 'community:3',
 * });
 *
 * // Incremental mode
 * const result = await generateNexusWikiIndex('.cleo/wiki', '/path/to/project', {
 *   incremental: true,
 * });
 * ```
 *
 * @task T1060
 * @task T1109
 */
export async function generateNexusWikiIndex(
  outputDir: string,
  projectRoot?: string,
  options?: GenerateNexusWikiOptions,
): Promise<NexusWikiResult> {
  const resolvedProjectRoot = projectRoot ?? process.cwd();
  const communityFilter = options?.communityFilter ?? null;
  const isIncremental = options?.incremental ?? false;
  const loomProvider = options?.loomProvider ?? null;
  const injectedDb = options?._dbForTesting ?? null;

  try {
    // Resolve the database handle.
    // When a test injects `_dbForTesting`, skip nexus.db existence checks and
    // use the injected handle directly. Otherwise use the real nexus.db singleton.
    let db: WikiDbHandle | null;

    if (injectedDb !== null) {
      db = injectedDb;
    } else {
      // Check if nexus.db exists
      const dbPath = getNexusDbPath();
      if (!existsSync(dbPath)) {
        // Empty but successful result for missing nexus.db
        await mkdir(outputDir, { recursive: true });
        if (!communityFilter) {
          const overviewMd = buildOverviewMarkdown([]);
          const overviewPath = join(outputDir, 'overview.md');
          await writeFile(overviewPath, overviewMd, 'utf-8');
        }

        return {
          success: true,
          outputDir,
          communityCount: 0,
          fileCount: communityFilter ? 0 : 1,
          communities: [],
          loomEnabled: loomProvider !== null,
        };
      }

      db = getNexusNativeDb();
      if (db === null) {
        // Gracefully return empty wiki when nexus.db cannot be opened
        await mkdir(outputDir, { recursive: true });
        if (!communityFilter) {
          const overviewMd = buildOverviewMarkdown([]);
          const overviewPath = join(outputDir, 'overview.md');
          await writeFile(overviewPath, overviewMd, 'utf-8');
        }

        return {
          success: true,
          outputDir,
          communityCount: 0,
          fileCount: communityFilter ? 0 : 1,
          communities: [],
          loomEnabled: loomProvider !== null,
        };
      }
    }

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    // ── Incremental: determine which communities to skip ──────────────────────
    let changedCommunityIds: Set<string> | null = null; // null = regenerate all
    let wikiStateForUpdate: WikiStateFile | null = null;
    const skippedCommunities: string[] = [];

    if (isIncremental) {
      const headSha = await resolveHeadSha(resolvedProjectRoot);
      const existingState = await readWikiState(resolvedProjectRoot);

      if (existingState && headSha) {
        // Determine changed files since the last run
        const changedFiles = await getChangedFiles(
          resolvedProjectRoot,
          existingState.lastRunCommit,
          headSha,
        );

        if (changedFiles.length > 0) {
          // Map changed files to community IDs
          // A community is "changed" if any of its member symbols have a file_path
          // that matches one of the changed files
          const changedFilesSet = new Set(changedFiles);
          const touchedRows = db
            .prepare(
              `SELECT DISTINCT community_id
               FROM nexus_nodes
               WHERE file_path IS NOT NULL
                 AND community_id IS NOT NULL
               ORDER BY community_id`,
            )
            .all() as Array<{ community_id: string }>;

          // Build a map from community_id → member file paths
          changedCommunityIds = new Set<string>();
          for (const row of touchedRows) {
            const cid = String(row.community_id);
            const memberFiles = db
              .prepare(
                `SELECT DISTINCT file_path
                 FROM nexus_nodes
                 WHERE community_id = ? AND file_path IS NOT NULL`,
              )
              .all(cid) as Array<{ file_path: string }>;

            for (const mf of memberFiles) {
              if (changedFilesSet.has(mf.file_path)) {
                changedCommunityIds.add(cid);
                break;
              }
            }
          }
        } else {
          // No files changed — skip all (changedCommunityIds = empty set)
          changedCommunityIds = new Set<string>();
        }

        wikiStateForUpdate = { lastRunCommit: headSha, generatedCommunities: [] };
      } else {
        // No state file or no HEAD sha — do a full run and write state
        if (headSha) {
          wikiStateForUpdate = { lastRunCommit: headSha, generatedCommunities: [] };
        }
        changedCommunityIds = null; // full generation
      }
    }

    // ── Query communities ─────────────────────────────────────────────────────
    let communityRows: Array<{ community_id: string; member_count: number }>;

    if (communityFilter) {
      // Single-community mode: fetch only the requested community
      communityRows = db
        .prepare(
          `SELECT
            community_id,
            COUNT(*) as member_count
          FROM nexus_nodes
          WHERE kind = 'community' AND community_id = ?
          GROUP BY community_id`,
        )
        .all(communityFilter) as Array<{ community_id: string; member_count: number }>;

      // If no community node found, fall back to member nodes with that community_id
      if (communityRows.length === 0) {
        const memberCount = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM nexus_nodes WHERE community_id = ? AND kind != 'community'`,
          )
          .get(communityFilter) as { cnt: number } | undefined;

        if (memberCount && memberCount.cnt > 0) {
          communityRows = [{ community_id: communityFilter, member_count: memberCount.cnt }];
        }
      }
    } else {
      // All communities
      communityRows = db
        .prepare(
          `SELECT DISTINCT
            community_id,
            COUNT(*) as member_count
          FROM nexus_nodes
          WHERE kind = 'community'
          GROUP BY community_id
          ORDER BY member_count DESC`,
        )
        .all() as Array<{ community_id: string; member_count: number }>;
    }

    const communityStats: CommunityWikiStats[] = [];
    let filesWritten = 0;

    // LOOM availability notification
    if (loomProvider === null) {
      process.stderr.write('[nexus wiki] LOOM unavailable — scaffold mode\n');
    }

    // ── Generate one markdown file per community ──────────────────────────────
    for (const community of communityRows) {
      const communityId = String(community.community_id);
      const memberCount = Number(community.member_count);

      communityStats.push({ communityId, memberCount });

      // Incremental skip check
      if (changedCommunityIds !== null && !changedCommunityIds.has(communityId)) {
        skippedCommunities.push(communityId);
        // Track in state even if skipped (it still exists)
        if (wikiStateForUpdate) {
          wikiStateForUpdate.generatedCommunities.push(communityId);
        }
        continue;
      }

      // Query symbols in this community
      const memberRows = db
        .prepare(
          `SELECT
            n.id,
            n.name,
            n.kind,
            n.file_path,
            COALESCE((SELECT COUNT(*) FROM nexus_relations WHERE target_id = n.id AND type = 'calls'), 0) as caller_count,
            COALESCE((SELECT COUNT(*) FROM nexus_relations WHERE source_id = n.id AND type = 'calls'), 0) as callee_count
          FROM nexus_nodes n
          WHERE n.community_id = ? AND n.kind != 'community'
          ORDER BY n.name ASC`,
        )
        .all(communityId) as Array<{
        id: string;
        name: string;
        kind: string;
        file_path: string | null;
        caller_count: number;
        callee_count: number;
      }>;

      const symbols: WikiSymbolRow[] = memberRows.map((row) => ({
        name: String(row.name),
        kind: String(row.kind),
        filePath: row.file_path ? String(row.file_path) : null,
        callerCount: Number(row.caller_count),
        calleeCount: Number(row.callee_count),
      }));

      // ── LOOM narrative generation ───────────────────────────────────────────
      let loomNarrative: string | null = null;
      if (loomProvider !== null && symbols.length > 0) {
        try {
          const prompt = buildLoomPrompt(communityId, symbols);
          loomNarrative = await loomProvider(prompt);
        } catch (loomErr) {
          const msg = loomErr instanceof Error ? loomErr.message : String(loomErr);
          process.stderr.write(
            `[nexus wiki] LOOM narrative failed for community ${communityId}: ${msg} — scaffold mode\n`,
          );
          loomNarrative = null;
        }
      }

      // Build and write community markdown
      const communityMd = buildCommunityMarkdown(communityId, symbols, loomNarrative);
      const communityFileName = `community-${communityId}.md`;
      const communityPath = join(outputDir, communityFileName);
      await writeFile(communityPath, communityMd, 'utf-8');
      filesWritten += 1;

      // Track generated community in state
      if (wikiStateForUpdate) {
        wikiStateForUpdate.generatedCommunities.push(communityId);
      }
    }

    // ── Build overview markdown (skipped in single-community mode) ─────────────
    if (!communityFilter) {
      const overviewMd = buildOverviewMarkdown(communityStats);
      const overviewPath = join(outputDir, 'overview.md');
      await writeFile(overviewPath, overviewMd, 'utf-8');
      filesWritten += 1;
    }

    // ── Persist incremental state ─────────────────────────────────────────────
    if (wikiStateForUpdate) {
      await writeWikiState(resolvedProjectRoot, wikiStateForUpdate);
    }

    return {
      success: true,
      outputDir,
      communityCount: communityRows.length,
      fileCount: filesWritten,
      communities: communityStats,
      skippedCommunities: skippedCommunities.length > 0 ? skippedCommunities : undefined,
      loomEnabled: loomProvider !== null,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      outputDir,
      communityCount: 0,
      fileCount: 0,
      communities: [],
      error: `Exception during wiki generation: ${errorMsg}`,
    };
  }
}

// ---------------------------------------------------------------------------
// EngineResult-returning wrapper (T1569 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusWiki(
  outputDir: string,
  projectRoot: string,
  options?: {
    communityFilter?: string;
    incremental?: boolean;
  },
): Promise<EngineResult<NexusWikiResult>> {
  try {
    const result = await generateNexusWikiIndex(outputDir, projectRoot, {
      communityFilter: options?.communityFilter,
      incremental: options?.incremental ?? false,
      loomProvider: null,
      projectRoot,
    });
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
