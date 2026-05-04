import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WikiDbHandle } from '@cleocode/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateNexusWikiIndex } from '../wiki-index.js';

// ---------------------------------------------------------------------------
// In-memory DB fixture helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal WikiDbHandle fixture that mimics the nexus_nodes table
 * structure required by the community query.
 *
 * The fixture contains:
 * - 3 community-kind nodes (community_id = NULL — they ARE the community)
 * - 6 symbol nodes spread across those 3 communities (community_id is set)
 *
 * Before the T1833 fix the community query used WHERE kind = 'community',
 * which grouped on rows with community_id = NULL and returned 0 communities.
 * After the fix it uses WHERE kind != 'community' AND community_id IS NOT NULL,
 * which correctly returns 3 communities with 2 members each.
 *
 * @returns A WikiDbHandle backed by an in-memory node list.
 */
function buildCommunityFixtureDb(): WikiDbHandle {
  type Row = Record<string, string | number | null>;

  const nodes: Row[] = [
    // community-kind nodes — their own community_id is NULL
    { id: 'c1', name: 'Community 1', kind: 'community', community_id: null, file_path: null },
    { id: 'c2', name: 'Community 2', kind: 'community', community_id: null, file_path: null },
    { id: 'c3', name: 'Community 3', kind: 'community', community_id: null, file_path: null },
    // symbol nodes — community_id references the community they belong to
    { id: 's1', name: 'funcA', kind: 'function', community_id: 'c1', file_path: 'src/a.ts' },
    { id: 's2', name: 'funcB', kind: 'function', community_id: 'c1', file_path: 'src/b.ts' },
    { id: 's3', name: 'classC', kind: 'class', community_id: 'c2', file_path: 'src/c.ts' },
    { id: 's4', name: 'classD', kind: 'class', community_id: 'c2', file_path: 'src/d.ts' },
    { id: 's5', name: 'typeE', kind: 'type_alias', community_id: 'c3', file_path: 'src/e.ts' },
    { id: 's6', name: 'typeF', kind: 'type_alias', community_id: 'c3', file_path: 'src/f.ts' },
  ];

  const relations: Row[] = [];

  return {
    prepare(sql: string) {
      return {
        all(...params: (string | number | null | bigint | Uint8Array)[]): Row[] {
          const p0 = params[0];

          // ── Community listing queries (T1833 fix target) ───────────────────
          if (
            sql.includes('community_id') &&
            sql.includes('COUNT(*)') &&
            sql.includes("kind != 'community'")
          ) {
            // Filter by community_id if a specific community was requested
            const filtered =
              p0 !== undefined
                ? nodes.filter((n) => n.kind !== 'community' && n.community_id === p0)
                : nodes.filter((n) => n.kind !== 'community' && n.community_id !== null);

            // GROUP BY community_id
            const grouped = new Map<string, number>();
            for (const row of filtered) {
              const cid = String(row.community_id);
              grouped.set(cid, (grouped.get(cid) ?? 0) + 1);
            }
            return Array.from(grouped.entries())
              .map(([community_id, member_count]) => ({ community_id, member_count }))
              .sort((a, b) => (b.member_count as number) - (a.member_count as number));
          }

          // ── Symbol members of a community ──────────────────────────────────
          if (sql.includes('community_id = ?') && sql.includes("kind != 'community'")) {
            return nodes
              .filter((n) => n.kind !== 'community' && n.community_id === p0)
              .map((n) => ({
                id: n.id,
                name: n.name,
                kind: n.kind,
                file_path: n.file_path,
                caller_count: 0,
                callee_count: 0,
              }));
          }

          // ── Changed-community discovery (incremental mode) ─────────────────
          if (sql.includes('DISTINCT community_id') && sql.includes('community_id IS NOT NULL')) {
            return nodes
              .filter((n) => n.community_id !== null && n.file_path !== null)
              .map((n) => ({ community_id: n.community_id }));
          }

          // ── File paths for a community (incremental mode) ─────────────────
          if (sql.includes('file_path') && sql.includes('community_id = ?')) {
            return nodes
              .filter((n) => n.community_id === p0 && n.file_path !== null)
              .map((n) => ({ file_path: n.file_path }));
          }

          // ── Relation queries ───────────────────────────────────────────────
          if (sql.includes('nexus_relations')) {
            return relations;
          }

          return [];
        },

        get(...params: (string | number | null | bigint | Uint8Array)[]): Row | undefined {
          const p0 = params[0];

          // COUNT(*) fallback for single-community mode
          if (sql.includes('COUNT(*) as cnt')) {
            const cnt = nodes.filter((n) => n.community_id === p0 && n.kind !== 'community').length;
            return { cnt };
          }

          return undefined;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('nexus wiki-index', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-test-'));
  });

  afterAll(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in tests
    }
  });

  it('should return proper result structure', async () => {
    const outputDir = join(tempDir, 'structure-test');
    const result = await generateNexusWikiIndex(outputDir);

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('outputDir');
    expect(result).toHaveProperty('communityCount');
    expect(result).toHaveProperty('fileCount');
    expect(result).toHaveProperty('communities');
    expect(Array.isArray(result.communities)).toBe(true);
  });

  it('should return outputDir in result', async () => {
    const outputDir = join(tempDir, 'output-test');
    const result = await generateNexusWikiIndex(outputDir);

    expect(result.outputDir).toBe(outputDir);
  });

  it('should include fileCount in result', async () => {
    const outputDir = join(tempDir, 'filecount-test');
    const result = await generateNexusWikiIndex(outputDir);

    if (result.error) {
      console.error('Result error:', result.error);
    }
    expect(typeof result.fileCount).toBe('number');
    // When DB doesn't exist, we still write overview.md
    expect(result.fileCount).toBeGreaterThanOrEqual(0);
  });

  // ── T1833 regression: community query must use symbol nodes, not community nodes ──

  it('T1833: community query on symbol nodes surfaces all communities (not 0)', async () => {
    // Before the fix: WHERE kind = 'community' GROUP BY community_id returned 0 rows
    // because community-kind nodes have community_id = NULL.
    // After the fix: WHERE kind != 'community' AND community_id IS NOT NULL returns the
    // correct community groups.
    const outputDir = join(tempDir, 'T1833-community-count');
    const db = buildCommunityFixtureDb();

    const result = await generateNexusWikiIndex(outputDir, process.cwd(), {
      _dbForTesting: db,
    });

    expect(result.success).toBe(true);
    // Fixture has 3 communities — they MUST appear in the result
    expect(result.communityCount).toBe(3);
    expect(result.communities).toHaveLength(3);
  });

  it('T1833: each community lists correct member count from symbol nodes', async () => {
    const outputDir = join(tempDir, 'T1833-member-count');
    const db = buildCommunityFixtureDb();

    const result = await generateNexusWikiIndex(outputDir, process.cwd(), {
      _dbForTesting: db,
    });

    expect(result.success).toBe(true);
    // Each community has exactly 2 symbol members
    for (const community of result.communities) {
      expect(community.memberCount).toBe(2);
    }
  });

  it('T1833: single-community filter returns correct count from symbol nodes', async () => {
    const outputDir = join(tempDir, 'T1833-single-community');
    const db = buildCommunityFixtureDb();

    const result = await generateNexusWikiIndex(outputDir, process.cwd(), {
      _dbForTesting: db,
      communityFilter: 'c1',
    });

    expect(result.success).toBe(true);
    expect(result.communityCount).toBe(1);
    expect(result.communities[0]?.communityId).toBe('c1');
    expect(result.communities[0]?.memberCount).toBe(2);
  });
});
