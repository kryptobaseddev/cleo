/**
 * Nexus wiki index generator - community-grouped symbol listings.
 *
 * Generates minimal, no-LLM wiki structure:
 * - One markdown file per community listing its symbols
 * - Overview.md linking all communities
 * - Simple tables with symbol metadata (name, kind, file path, call counts)
 *
 * Future: LLM-enhanced summaries can extend this scaffold.
 *
 * @task T1060
 * @epic T1042
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommunityWikiStats, NexusWikiResult, WikiSymbolRow } from '@cleocode/contracts';
import { getNexusDbPath, getNexusNativeDb } from '../store/nexus-sqlite.js';

/**
 * Generate a community-grouped wiki index from nexus.db.
 *
 * Queries all nexus nodes grouped by community_id, then generates:
 * - `<outputDir>/community-<id>.md` per community
 * - `<outputDir>/overview.md` linking all communities
 *
 * No LLM summaries — this is a structural scaffold.
 *
 * @param outputDir - Output directory for wiki files
 * @param projectRoot - Project root for relative path calculation (optional)
 * @returns Generation result with file counts and community stats
 *
 * @example
 * ```ts
 * const result = await generateNexusWikiIndex('.cleo/wiki', '/path/to/project');
 * console.log(`${result.fileCount} files written`);
 * ```
 *
 * @task T1060
 */
export async function generateNexusWikiIndex(
  outputDir: string,
  _projectRoot?: string,
): Promise<NexusWikiResult> {
  try {
    // Check if nexus.db exists
    const dbPath = getNexusDbPath();
    if (!existsSync(dbPath)) {
      // Empty but successful result for missing nexus.db
      await mkdir(outputDir, { recursive: true });
      const overviewMd = buildOverviewMarkdown([]);
      const overviewPath = join(outputDir, 'overview.md');
      await writeFile(overviewPath, overviewMd, 'utf-8');

      return {
        success: true,
        outputDir,
        communityCount: 0,
        fileCount: 1,
        communities: [],
      };
    }

    const db = getNexusNativeDb();
    if (db === null) {
      // Gracefully return empty wiki when nexus.db cannot be opened
      await mkdir(outputDir, { recursive: true });
      const overviewMd = buildOverviewMarkdown([]);
      const overviewPath = join(outputDir, 'overview.md');
      await writeFile(overviewPath, overviewMd, 'utf-8');

      return {
        success: true,
        outputDir,
        communityCount: 0,
        fileCount: 1,
        communities: [],
      };
    }

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    // Query communities and member counts
    const communityRows = db
      .prepare(
        `SELECT DISTINCT
        community_id,
        COUNT(*) as member_count
      FROM nexus_nodes
      WHERE kind = 'community'
      GROUP BY community_id
      ORDER BY member_count DESC`,
      )
      .all() as Array<{
      community_id: string;
      member_count: number;
    }>;

    const communityStats: CommunityWikiStats[] = [];
    let filesWritten = 0;

    // Generate one markdown file per community
    for (const community of communityRows) {
      const communityId = String(community.community_id);
      const memberCount = Number(community.member_count);

      communityStats.push({ communityId, memberCount });

      // Query symbols in this community
      const memberRows = db
        .prepare(
          `SELECT
          n.id,
          n.name,
          n.kind,
          n.file_path,
          COALESCE((SELECT COUNT(*) FROM nexus_relations WHERE target_id = n.id AND relation_type = 'calls'), 0) as caller_count,
          COALESCE((SELECT COUNT(*) FROM nexus_relations WHERE source_id = n.id AND relation_type = 'calls'), 0) as callee_count
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

      // Build community markdown
      const communityMd = buildCommunityMarkdown(communityId, symbols);

      const communityFileName = `community-${communityId}.md`;
      const communityPath = join(outputDir, communityFileName);

      await writeFile(communityPath, communityMd, 'utf-8');
      filesWritten += 1;
    }

    // Build overview markdown
    const overviewMd = buildOverviewMarkdown(communityStats);
    const overviewPath = join(outputDir, 'overview.md');
    await writeFile(overviewPath, overviewMd, 'utf-8');
    filesWritten += 1;

    return {
      success: true,
      outputDir,
      communityCount: communityRows.length,
      fileCount: filesWritten,
      communities: communityStats,
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

/**
 * Build markdown for a single community.
 */
function buildCommunityMarkdown(communityId: string, symbols: WikiSymbolRow[]): string {
  const lines: string[] = [
    `# Community ${communityId}`,
    '',
    `**Symbols**: ${symbols.length}`,
    '',
    '## Members',
    '',
    '| Name | Kind | File Path | Callers | Callees |',
    '|------|------|-----------|---------|---------|',
  ];

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
  lines.push('*Generated by `cleo nexus wiki` — no-LLM structural index.*');
  lines.push('');

  return lines.join('\n');
}
