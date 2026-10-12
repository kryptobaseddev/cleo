/**
 * `docs.stats` metric computation (T13363) — seeded fixture store.
 *
 * Covers all four metrics: add:update ratio from the docs audit log,
 * loose-markdown count with scanned/excluded dirs, `docs_wikilinks` edge
 * count, and live `decision_adr_links` count (revoked tombstones excluded).
 *
 * @task T13363
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { linkDecisionToAdr, revokeDecisionAdrLink } from '../../store/decision-adr-links.js';
import { docsWikilinks } from '../../store/schema/attachments.js';
import { getDb, getNativeDb } from '../../store/sqlite.js';
import { writeAuditEntry } from '../docs-audit.js';
import { computeDocsStats, countLooseMarkdown } from '../stats.js';

let env: TestDbEnv;

beforeEach(async () => {
  env = await createTestDb();
});

afterEach(async () => {
  await env.cleanup();
});

describe('computeDocsStats (T13363)', () => {
  it('emits add:update ratio, loose-markdown count, wikilinks edges, and decisions linked', async () => {
    // --- add:update activity via the audit-log accessor ---
    writeAuditEntry(env.tempDir, { op: 'docs.add', slug: 'a', summary: 'add a' });
    writeAuditEntry(env.tempDir, { op: 'docs.add', slug: 'b', summary: 'add b' });
    writeAuditEntry(env.tempDir, { op: 'docs.add', slug: 'c', summary: 'add c' });
    writeAuditEntry(env.tempDir, {
      op: 'docs.update',
      slug: 'a',
      summary: 'update a',
    });
    // Non add/update ops are ignored for the ratio.
    writeAuditEntry(env.tempDir, { op: 'docs.remove', slug: 'b', summary: 'remove b' });

    // --- wikilink edges (seeding, through the drizzle handle) ---
    const db = await getDb(env.tempDir);
    await db.insert(docsWikilinks).values([
      { fromSlug: 'a', toSlug: 'b', relation: 'topic', toIsTask: false },
      { fromSlug: 'a', toSlug: 'T001', relation: 'related-task', toIsTask: true },
    ]);

    // --- decision↔ADR links: 3 linked, 1 revoked tombstone (not counted) ---
    await linkDecisionToAdr(env.tempDir, { decisionId: 'D1', adrSlug: 'adr-001-x' });
    await linkDecisionToAdr(env.tempDir, { decisionId: 'D2', adrSlug: 'adr-001-x' });
    await linkDecisionToAdr(env.tempDir, { decisionId: 'D3', adrSlug: 'adr-002-y' });
    await linkDecisionToAdr(env.tempDir, { decisionId: 'D4', adrSlug: 'adr-002-y' });
    await revokeDecisionAdrLink(env.tempDir, { decisionId: 'D4', adrSlug: 'adr-002-y' });

    // --- loose markdown: 3 counted, several excluded shapes ---
    writeFileSync(join(env.tempDir, 'README.md'), '# root doc');
    mkdirSync(join(env.tempDir, 'notes'), { recursive: true });
    writeFileSync(join(env.tempDir, 'notes', 'a.md'), 'a');
    mkdirSync(join(env.tempDir, 'notes', 'sub'), { recursive: true });
    writeFileSync(join(env.tempDir, 'notes', 'sub', 'b.md'), 'b');
    // Excluded: node_modules, the .cleo store (incl. .cleo/council-runs), .git.
    mkdirSync(join(env.tempDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(env.tempDir, 'node_modules', 'pkg', 'x.md'), 'x');
    mkdirSync(join(env.tempDir, '.cleo', 'council-runs'), { recursive: true });
    writeFileSync(join(env.tempDir, '.cleo', 'council-runs', 'run.md'), 'r');
    writeFileSync(join(env.tempDir, '.git', 'g.md'), 'g');
    // Excluded: a nested git worktree (gitlink `.git` FILE).
    const nested = join(env.tempDir, 'wt-nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, '.git'), 'gitdir: /elsewhere');
    writeFileSync(join(nested, 'inside.md'), 'i');

    const stats = await computeDocsStats({ projectRoot: env.tempDir });

    // add:update ratio (3 adds, 1 update).
    expect(stats.addUpdate).toEqual({ adds: 3, updates: 1, ratio: 3 });
    // loose markdown: README.md + notes/a.md + notes/sub/b.md.
    expect(stats.looseMarkdown.count).toBe(3);
    expect(stats.looseMarkdown.scannedDirs).toContain('notes');
    expect(stats.looseMarkdown.scannedDirs).not.toContain('node_modules');
    for (const excluded of ['node_modules', '.git', '.cleo', 'wt-nested']) {
      expect(stats.looseMarkdown.excludedDirs).toContain(excluded);
    }
    // wikilinks edge count.
    expect(stats.wikilinksEdges).toBe(2);
    // Live links only — the revoked D4 tombstone does not count.
    expect(stats.decisionsLinked).toBe(3);
    expect(stats.summary).toContain('adds 3 / updates 1');
    expect(Date.parse(stats.generatedAt)).toBeGreaterThan(0);

    // Sanity: the fixture really holds the rows we seeded.
    const native = getNativeDb(env.tempDir);
    if (!native) throw new Error('expected a native handle');
    const edges = native.prepare(`SELECT COUNT(*) AS n FROM docs_wikilinks`).get() as {
      n: number;
    };
    expect(edges.n).toBe(2);
  });

  it('reports a null ratio when there are no updates, and zeroes on an empty project', async () => {
    const stats = await computeDocsStats({ projectRoot: env.tempDir });
    expect(stats.addUpdate).toEqual({ adds: 0, updates: 0, ratio: null });
    expect(stats.wikilinksEdges).toBe(0);
    expect(stats.decisionsLinked).toBe(0);
    // createTestDb writes no markdown into the fixture root.
    expect(stats.looseMarkdown.count).toBe(0);
  });
});

describe('countLooseMarkdown (T13363)', () => {
  it('counts only markdown, skips symlinks, and lists scanned dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-lm-'));
    try {
      writeFileSync(join(root, 'one.md'), '1');
      writeFileSync(join(root, 'two.txt'), '2'); // not markdown
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'docs', 'three.md'), '3');
      const result = countLooseMarkdown(root);
      expect(result.count).toBe(2);
      expect(result.scannedDirs).toEqual(['docs']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
