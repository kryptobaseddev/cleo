/**
 * `docs.stats` metric computation (T13363) — seeded fixture store.
 *
 * Covers all four metrics: add:update ratio from the docs audit log,
 * loose-markdown count (git-tracked `*.md` outside the store, via
 * `git ls-files` — untracked files are intentionally out of scope, T13629),
 * `docs_wikilinks` edge count, and live `decision_adr_links` count (revoked
 * tombstones excluded).
 *
 * @task T13363
 */

import { execFileSync } from 'node:child_process';
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

/** Run a git command in `root`, discarding output. */
function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

/** Turn the fixture into a real git work tree and stage everything. */
function initFixtureRepo(root: string): void {
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
}

beforeEach(async () => {
  env = await createTestDb();
});

afterEach(async () => {
  await env.cleanup();
});

describe('computeDocsStats (T13363)', () => {
  it('emits add:update ratio, loose-markdown count, wikilinks edges, and decisions linked', async () => {
    // --- loose markdown: tracked files only, exclusions via .gitignore ---
    writeFileSync(
      join(env.tempDir, '.gitignore'),
      ['node_modules/', '.cleo/', 'wt-nested/', ''].join('\n'),
    );
    writeFileSync(join(env.tempDir, 'README.md'), '# root doc');
    mkdirSync(join(env.tempDir, 'notes'), { recursive: true });
    writeFileSync(join(env.tempDir, 'notes', 'a.md'), 'a');
    mkdirSync(join(env.tempDir, 'notes', 'sub'), { recursive: true });
    writeFileSync(join(env.tempDir, 'notes', 'sub', 'b.md'), 'b');
    // Ignored shapes: dependency tree, the store (incl. council-runs),
    // a nested worktree checkout.
    mkdirSync(join(env.tempDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(env.tempDir, 'node_modules', 'pkg', 'x.md'), 'x');
    mkdirSync(join(env.tempDir, '.cleo', 'council-runs'), { recursive: true });
    writeFileSync(join(env.tempDir, '.cleo', 'council-runs', 'run.md'), 'r');
    writeFileSync(join(env.tempDir, '.git', 'g.md'), 'g');
    const nested = join(env.tempDir, 'wt-nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, '.git'), 'gitdir: /elsewhere');
    writeFileSync(join(nested, 'inside.md'), 'i');
    initFixtureRepo(env.tempDir);
    // Written AFTER the add: untracked, so intentionally NOT counted.
    writeFileSync(join(env.tempDir, 'notes', 'untracked.md'), 'u');

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

    const stats = await computeDocsStats({ projectRoot: env.tempDir });

    // add:update ratio (3 adds, 1 update).
    expect(stats.addUpdate).toEqual({ adds: 3, updates: 1, ratio: 3 });
    // loose markdown: README.md + notes/a.md + notes/sub/b.md (tracked);
    // untracked/ignored files are out of scope.
    expect(stats.looseMarkdown.count).toBe(3);
    expect(stats.looseMarkdown.scannedDirs).toEqual(['(root)', 'notes']);
    expect(stats.looseMarkdown.excludedDirs).toEqual(['node_modules', '.git', '.cleo']);
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
    initFixtureRepo(env.tempDir);
    const stats = await computeDocsStats({ projectRoot: env.tempDir });
    expect(stats.addUpdate).toEqual({ adds: 0, updates: 0, ratio: null });
    expect(stats.wikilinksEdges).toBe(0);
    expect(stats.decisionsLinked).toBe(0);
    expect(stats.looseMarkdown.count).toBe(0);
  });
});

describe('countLooseMarkdown (T13363, T13629)', () => {
  it('counts only tracked markdown and lists contributing top-level dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-lm-'));
    try {
      writeFileSync(join(root, 'one.md'), '1');
      writeFileSync(join(root, 'two.txt'), '2'); // not markdown
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'docs', 'three.md'), '3');
      git(root, ['init', '-q']);
      git(root, ['add', '-A']);
      // Untracked loose markdown is intentionally out of scope.
      writeFileSync(join(root, 'untracked.md'), 'u');
      const result = countLooseMarkdown(root);
      expect(result.count).toBe(2);
      expect(result.scannedDirs).toEqual(['(root)', 'docs']);
      expect(result.excludedDirs).toEqual(['node_modules', '.git', '.cleo']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns zero outside a git work tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-lm-'));
    try {
      writeFileSync(join(root, 'one.md'), '1');
      const result = countLooseMarkdown(root);
      expect(result.count).toBe(0);
      expect(result.scannedDirs).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
