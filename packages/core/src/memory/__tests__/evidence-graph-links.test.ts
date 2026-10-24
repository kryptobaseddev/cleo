/**
 * Accepted verification evidence becomes brain graph links (T13950):
 * commits (and a PR's merge commit), files and decisions, written whatever
 * `brain.autoCapture` says, and idempotent on re-verify. File nodes are keyed
 * by repo-relative POSIX path; commit failures propagate. In a store that
 * parents several repositories, file and commit ids carry a repository key and
 * a forward migration moves existing links (T14012).
 *
 * @task T13950
 * @task T14012
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Counts checkout probes so the per-directory cache is observable (T14012).
const probes = vi.hoisted(() => ({ toplevel: 0 }));
vi.mock('../../git/work-tree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git/work-tree.js')>();
  return {
    ...actual,
    gitToplevel: (dir: string): string | null => {
      probes.toplevel++;
      return actual.gitToplevel(dir);
    },
  };
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cleo-evidence-links-'));
  await mkdir(join(root, '.cleo'), { recursive: true });
  process.env['CLEO_DIR'] = join(root, '.cleo');
  // The evidence repository is the temp root, whatever the test's cwd is.
  process.env['CLEO_EVIDENCE_GIT_ROOT'] = root;
  // Automatic capture off: evidence links are written anyway.
  await writeFile(
    join(root, '.cleo', 'config.json'),
    JSON.stringify({ brain: { autoCapture: false } }),
  );
});

afterEach(async () => {
  const { closeBrainDb } = await import('../../store/memory-sqlite.js');
  closeBrainDb();
  delete process.env['CLEO_DIR'];
  delete process.env['CLEO_EVIDENCE_GIT_ROOT'];
  await rm(root, { recursive: true, force: true });
});

const sha = 'a'.repeat(40);
const merge = 'b'.repeat(40);
const atoms: EvidenceAtom[] = [
  { kind: 'commit', sha, shortSha: sha.slice(0, 7) },
  { kind: 'files', files: [{ path: 'packages/core/src/x.ts', sha256: 'c'.repeat(64) }] },
  { kind: 'decision', decisionId: 'D42' },
  { kind: 'note', note: 'no edge for notes' },
];

/** Edges written by the evidence hook, sorted. */
async function evidenceEdges(): Promise<Array<{ from: string; to: string; type: string }>> {
  const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  await getBrainDb(root);
  return getBrainNativeDb(root)!
    .prepare(
      "SELECT from_id, to_id, edge_type FROM brain_page_edges WHERE provenance = 'evidence:verify' ORDER BY from_id, to_id",
    )
    .all()
    .map((row) => ({
      from: String(row.from_id),
      to: String(row.to_id),
      type: String(row.edge_type),
    }));
}

describe('linkVerifiedEvidence (T13950)', () => {
  it('links commits, files and decisions even with autoCapture off, idempotently', async () => {
    const { linkVerifiedEvidence } = await import('../evidence-graph-links.js');
    expect(await linkVerifiedEvidence(root, 'T1', atoms)).toEqual({
      commits: 1,
      files: 1,
      decisions: 1,
      skipped: [],
    });
    const expected = [
      { from: 'decision:D42', to: 'task:T1', type: 'applies_to' },
      { from: 'task:T1', to: `commit:${sha}`, type: 'touches_code' },
      { from: 'task:T1', to: 'file:packages/core/src/x.ts', type: 'touches_code' },
    ];
    expect(await evidenceEdges()).toEqual(expected);
    await linkVerifiedEvidence(root, 'T1', atoms);
    expect(await evidenceEdges()).toEqual(expected);
  });

  it("links a PR atom's merge commit", async () => {
    const { linkVerifiedEvidence } = await import('../evidence-graph-links.js');
    const pr: EvidenceAtom = {
      kind: 'pr',
      prNumber: 7,
      mergeCommitSha: merge,
      mergedAt: '2026-10-24T00:00:00Z',
      successCount: 3,
      totalChecks: 3,
    };
    await linkVerifiedEvidence(root, 'T2', [pr]);
    expect(await evidenceEdges()).toEqual([
      { from: 'task:T2', to: `commit:${merge}`, type: 'touches_code' },
    ]);
  });

  it('keys file nodes by repo-relative POSIX path and skips paths outside the repo', async () => {
    const { linkVerifiedEvidence } = await import('../evidence-graph-links.js');
    const c = 'c'.repeat(64);
    const result = await linkVerifiedEvidence(root, 'T3', [
      {
        kind: 'files',
        files: [
          { path: './packages/core/src/x.ts', sha256: c },
          { path: join(root, 'packages', 'core', 'src', 'x.ts'), sha256: c },
          { path: 'packages//core/src/../src/x.ts', sha256: c },
          { path: '/elsewhere/y.ts', sha256: c },
          { path: '../outside.ts', sha256: c },
        ],
      },
    ]);
    expect(result.skipped).toEqual(['/elsewhere/y.ts', '../outside.ts']);
    expect(await evidenceEdges()).toEqual([
      { from: 'task:T3', to: 'file:packages/core/src/x.ts', type: 'touches_code' },
    ]);
  });

  it('keeps an existing commit node when another task re-links it', async () => {
    const { linkVerifiedEvidence } = await import('../evidence-graph-links.js');
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    await linkVerifiedEvidence(root, 'T4', [atoms[0]!]);
    const node = () =>
      getBrainNativeDb(root)!
        .prepare('SELECT label, metadata_json FROM brain_page_nodes WHERE id = ?')
        .get(`commit:${sha}`);
    const before = node();
    await linkVerifiedEvidence(root, 'T5', [atoms[0]!]);
    expect(node()).toEqual(before);
    expect(String(before?.label)).toContain('(T4)');
  });

  it('propagates a failed commit link so the caller can warn', async () => {
    const { linkVerifiedEvidence } = await import('../evidence-graph-links.js');
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(root);
    getBrainNativeDb(root)!.exec(
      "CREATE TRIGGER t_fail BEFORE INSERT ON brain_page_nodes WHEN NEW.id LIKE 'commit:%' BEGIN SELECT RAISE(ABORT, 'commit node refused'); END",
    );
    // Drizzle wraps the trigger's message as "Failed query: insert into ...".
    await expect(linkVerifiedEvidence(root, 'T6', [atoms[0]!])).rejects.toThrow(
      /insert into "brain_page_nodes"/,
    );
  });

  it('says which links were written when a commit link fails (T14005)', async () => {
    const { linkVerifiedEvidence } = await import('../evidence-graph-links.js');
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(root);
    getBrainNativeDb(root)!.exec(
      "CREATE TRIGGER t_fail BEFORE INSERT ON brain_page_nodes WHEN NEW.id LIKE 'commit:%' BEGIN SELECT RAISE(ABORT, 'commit node refused'); END",
    );
    await expect(linkVerifiedEvidence(root, 'T7', atoms)).rejects.toThrow(
      `commit links failed for ${sha.slice(0, 12)}; written: task, 1 file, 1 decision and 0 commit link(s): `,
    );
    expect(await evidenceEdges()).toEqual([
      { from: 'decision:D42', to: 'task:T7', type: 'applies_to' },
      { from: 'task:T7', to: 'file:packages/core/src/x.ts', type: 'touches_code' },
    ]);
  });
});

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** A git repo at `dir` with `src/x.ts` (and any `extra` files) committed; returns HEAD. */
async function repo(dir: string, extra: string[] = []): Promise<string> {
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'x.ts'), `${dir}\n`);
  for (const file of extra) {
    await mkdir(join(dir, file, '..'), { recursive: true });
    await writeFile(join(dir, file), `${file}\n`);
  }
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return git(dir, ['rev-parse', 'HEAD']);
}

describe('repoRelativeEvidencePath (T14005)', () => {
  it('keys a file in the main checkout, verified from a worktree, by its repo path', async () => {
    const { repoRelativeEvidencePath } = await import('../evidence-graph-links.js');
    const main = join(root, 'main');
    await repo(main);
    const wt = join(root, 'wt');
    git(main, ['worktree', 'add', '-q', wt]);
    // Present only in the main checkout (uncommitted), as validateFiles found it.
    await writeFile(join(main, 'src', 'only-main.ts'), 'm\n');
    expect(repoRelativeEvidencePath('src/only-main.ts', wt, main)).toBe('src/only-main.ts');
    expect(repoRelativeEvidencePath(join(wt, 'src', 'x.ts'), wt, main)).toBe('src/x.ts');
    expect(repoRelativeEvidencePath('./src/x.ts', wt, main)).toBe('src/x.ts');
  });

  it('keys a child repo file the same with or without a commit anchor', async () => {
    const { repoRelativeEvidencePath } = await import('../evidence-graph-links.js');
    const child = join(root, 'store', 'child');
    await repo(child);
    const store = join(root, 'store');
    // Files-only evidence: the store root parents the repositories.
    expect(repoRelativeEvidencePath('child/src/x.ts', store, store)).toBe('src/x.ts');
    // Commit-anchored evidence: the execution root is the child checkout.
    expect(repoRelativeEvidencePath('src/x.ts', child, store)).toBe('src/x.ts');
    expect(repoRelativeEvidencePath('/elsewhere/x.ts', child, store)).toBeNull();
  });
});

describe('repo-qualified evidence ids (T14012)', () => {
  const c = 'c'.repeat(64);

  it('gives same-named files and commits in two child repos separate nodes', async () => {
    // Discover the execution root per commit instead of the declared store root.
    delete process.env['CLEO_EVIDENCE_GIT_ROOT'];
    const { linkVerifiedEvidence } = await import('../evidence-graph-links.js');
    const shaA = await repo(join(root, 'a'));
    await repo(join(root, 'b'));
    git(join(root, 'b'), ['remote', 'add', 'origin', 'git@github.com:Org/B-Repo.git']);
    await linkVerifiedEvidence(root, 'T1', [
      { kind: 'commit', sha: shaA, shortSha: shaA.slice(0, 7) },
      { kind: 'files', files: [{ path: 'src/x.ts', sha256: c }] },
    ]);
    await linkVerifiedEvidence(root, 'T2', [
      { kind: 'files', files: [{ path: 'b/src/x.ts', sha256: c }] },
    ]);
    expect(await evidenceEdges()).toEqual([
      { from: 'task:T1', to: `commit:a::${shaA}`, type: 'touches_code' },
      { from: 'task:T1', to: 'file:a::src/x.ts', type: 'touches_code' },
      { from: 'task:T2', to: 'file:github.com/org/b-repo::src/x.ts', type: 'touches_code' },
    ]);
  });

  it('keeps unqualified ids in a single-repo store', async () => {
    delete process.env['CLEO_EVIDENCE_GIT_ROOT'];
    const { linkVerifiedEvidence } = await import('../evidence-graph-links.js');
    const head = await repo(root);
    await linkVerifiedEvidence(root, 'T1', [
      { kind: 'commit', sha: head, shortSha: head.slice(0, 7) },
      { kind: 'files', files: [{ path: 'src/x.ts', sha256: c }] },
    ]);
    expect(await evidenceEdges()).toEqual([
      { from: 'task:T1', to: `commit:${head}`, type: 'touches_code' },
      { from: 'task:T1', to: 'file:src/x.ts', type: 'touches_code' },
    ]);
  });

  it('ignores an outer repo that tracks nothing under the store, but honours one that does', async () => {
    const { createEvidenceRepoResolver } = await import('../evidence-graph-links.js');
    const home = join(root, 'home');
    await repo(home);
    const store = join(home, 'projects', 'store');
    await mkdir(join(store, 'notes'), { recursive: true });
    await writeFile(join(store, 'notes', 'a.md'), 'a\n');
    expect(createEvidenceRepoResolver(store).file('notes/a.md', store)).toEqual({
      repo: null,
      path: 'notes/a.md',
    });
    // A store inside a monorepo that tracks it keys files by the monorepo path.
    const mono = join(root, 'mono');
    await repo(mono, ['pkg/src/y.ts']);
    expect(
      createEvidenceRepoResolver(join(mono, 'pkg')).file('src/y.ts', join(mono, 'pkg')),
    ).toEqual({ repo: null, path: 'pkg/src/y.ts' });
  });

  it('keys a submodule file by the submodule, apart from the superproject file', async () => {
    const { createEvidenceRepoResolver } = await import('../evidence-graph-links.js');
    const lib = join(root, 'lib-src');
    await repo(lib);
    const store = join(root, 'store');
    await repo(store);
    git(store, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib']);
    const repos = createEvidenceRepoResolver(store);
    expect(repos.file('src/x.ts', store)).toEqual({ repo: null, path: 'src/x.ts' });
    const sub = repos.file('lib/src/x.ts', store);
    expect(sub?.path).toBe('src/x.ts');
    expect(sub?.repo).toBeTruthy();
    expect(repos.repoOf(join(store, 'lib'))).toBe(sub?.repo);
  });

  it('keys a non-GitHub origin by host and path, and a GitHub one by owner/repo', async () => {
    const { createEvidenceRepoResolver } = await import('../evidence-graph-links.js');
    await repo(join(root, 'gl'));
    git(join(root, 'gl'), [
      'remote',
      'add',
      'origin',
      'https://GitLab.Example.com/Grp/Sub/Repo.git',
    ]);
    await repo(join(root, 'gh'));
    git(join(root, 'gh'), ['remote', 'add', 'origin', 'https://github.com/Org/Tool']);
    const repos = createEvidenceRepoResolver(root);
    expect(repos.repoOf(join(root, 'gl'))).toBe('gitlab.example.com/grp/sub/repo');
    expect(repos.repoOf(join(root, 'gh'))).toBe('github.com/org/tool');
  });

  it('keeps unqualified ids for the declared git root of a single-child store', async () => {
    const { linkVerifiedEvidence } = await import('../evidence-graph-links.js');
    const head = await repo(join(root, 'app'));
    process.env['CLEO_EVIDENCE_GIT_ROOT'] = join(root, 'app');
    await linkVerifiedEvidence(root, 'T1', [
      { kind: 'commit', sha: head, shortSha: head.slice(0, 7) },
      { kind: 'files', files: [{ path: 'src/x.ts', sha256: c }] },
    ]);
    expect(await evidenceEdges()).toEqual([
      { from: 'task:T1', to: `commit:${head}`, type: 'touches_code' },
      { from: 'task:T1', to: 'file:src/x.ts', type: 'touches_code' },
    ]);
  });

  it('refuses a path containing the id separator', async () => {
    const { linkVerifiedEvidence } = await import('../evidence-graph-links.js');
    const result = await linkVerifiedEvidence(root, 'T1', [
      { kind: 'files', files: [{ path: 'src/a::b.ts', sha256: c }] },
    ]);
    expect(result.skipped).toEqual(['src/a::b.ts']);
  });

  it('derives one origin key per repository whatever the URL form', async () => {
    const { originRepoKey } = await import('../evidence-graph-links.js');
    for (const url of [
      'git@github.com:Org/Tool.git',
      'https://github.com/org/tool',
      'https://token@github.com/Org/Tool.git/',
      'ssh://git@github.com:22/org/tool',
      'ssh://git@github.com/Org/Tool.git',
    ]) {
      expect(originRepoKey(url)).toBe('github.com/org/tool');
    }
    expect(originRepoKey('ssh://git@GitLab.example.com:2222/Grp/Sub/Repo.git')).toBe(
      'gitlab.example.com/grp/sub/repo',
    );
    expect(originRepoKey('https://gitlab.example.com/grp/repo')).toBe(
      'gitlab.example.com/grp/repo',
    );
    // scp form has no port: numeric owners and groups stay in the path.
    expect(originRepoKey('git@github.com:1234/repo.git')).toBe('github.com/1234/repo');
    expect(originRepoKey('https://github.com/1234/repo')).toBe('github.com/1234/repo');
    expect(originRepoKey('git@gitlab.example.com:2024/grp/repo')).toBe(
      'gitlab.example.com/2024/grp/repo',
    );
    expect(originRepoKey('/srv/git/repo.git')).toBeNull();
    expect(originRepoKey('../repo')).toBeNull();
  });

  it('caches checkout probes by directory within one resolver', async () => {
    const { createEvidenceRepoResolver } = await import('../evidence-graph-links.js');
    await repo(join(root, 'a'), ['src/y.ts']);
    await repo(join(root, 'b'));
    const repos = createEvidenceRepoResolver(root);
    expect(repos.file('a/src/x.ts', root)?.repo).toBe('a');
    const after = probes.toplevel;
    expect(repos.file('a/src/y.ts', root)?.repo).toBe('a');
    expect(repos.repoOf(join(root, 'a', 'src'))).toBe('a');
    expect(probes.toplevel).toBe(after);
  });
});

describe('migrateEvidenceRepoIds (T14012)', () => {
  /** Ids of file and commit nodes, sorted. */
  async function nodeIds(): Promise<string[]> {
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    return getBrainNativeDb(root)!
      .prepare(
        "SELECT id FROM brain_page_nodes WHERE id LIKE 'file:%' OR id LIKE 'commit:%' ORDER BY id",
      )
      .all()
      .map((row) => String(row.id));
  }

  it('previews by default, then moves evidence links on apply without losing any', async () => {
    const { migrateEvidenceRepoIds, EVIDENCE_EDGE_PROVENANCE } = await import(
      '../evidence-graph-links.js'
    );
    const { writeGraphBatch } = await import('../graph-auto-populate.js');
    const shaA = await repo(join(root, 'a'), ['src/only-a.ts']);
    const shaB = await repo(join(root, 'b'));
    const node = (id: string, nodeType: 'task' | 'file' | 'commit' | 'decision') => ({
      id,
      nodeType,
      label: id,
      qualityScore: 0.8,
    });
    const edge = (fromId: string, toId: string, provenance = EVIDENCE_EDGE_PROVENANCE) => ({
      fromId,
      toId,
      edgeType: 'touches_code' as const,
      provenance,
    });
    await writeGraphBatch(
      root,
      [
        node('task:T1', 'task'),
        node('task:T2', 'task'),
        node('task:T3', 'task'),
        node('decision:D1', 'decision'),
        node('file:src/only-a.ts', 'file'),
        node('file:src/x.ts', 'file'),
        node(`commit:${shaA}`, 'commit'),
        node(`commit:${shaB}`, 'commit'),
      ],
      [
        edge('task:T1', 'file:src/only-a.ts'),
        edge('task:T1', `commit:${shaA}`),
        edge('task:T2', `commit:${shaB}`),
        edge('task:T2', 'file:src/x.ts'),
        // Two checkouts have src/x.ts and T3 has no commit to decide.
        edge('task:T3', 'file:src/x.ts'),
        // Another writer's edge stays on the old node.
        edge('decision:D1', 'file:src/x.ts', 'auto:decision-cross-link'),
      ],
    );
    const edgesBefore = await evidenceEdges();
    const nodesBefore = await nodeIds();

    // The default is a dry run: nothing written, no receipt.
    const plan = await migrateEvidenceRepoIds(root);
    expect(plan.dryRun).toBe(true);
    expect(plan.receiptPath).toBeNull();
    expect(await evidenceEdges()).toEqual(edgesBefore);
    expect(await nodeIds()).toEqual(nodesBefore);
    expect(existsSync(join(root, '.cleo', 'backups', 'migrations'))).toBe(false);
    expect(plan.moved).toHaveLength(4);
    expect(plan.unresolved).toEqual([
      {
        from: 'task:T3',
        target: 'file:src/x.ts',
        reason: "more than one checkout has this path and the task's commits do not decide",
      },
    ]);

    const applied = await migrateEvidenceRepoIds(root, {
      apply: true,
      now: new Date('2026-10-24T00:00:00.000Z'),
    });
    expect(applied.moved).toEqual(plan.moved);
    expect(applied.nodes).toEqual(plan.nodes);
    expect(applied.receiptPath).toBe(
      join(
        root,
        '.cleo',
        'backups',
        'migrations',
        'evidence-repo-ids-2026-10-24T00-00-00-000Z.json',
      ),
    );
    expect(await evidenceEdges()).toEqual([
      { from: 'task:T1', to: `commit:a::${shaA}`, type: 'touches_code' },
      { from: 'task:T1', to: 'file:a::src/only-a.ts', type: 'touches_code' },
      { from: 'task:T2', to: `commit:b::${shaB}`, type: 'touches_code' },
      { from: 'task:T2', to: 'file:b::src/x.ts', type: 'touches_code' },
      { from: 'task:T3', to: 'file:src/x.ts', type: 'touches_code' },
    ]);
    // Old nodes are kept for a later prune; the new ones are added.
    expect(await nodeIds()).toEqual(
      [
        ...nodesBefore,
        `commit:a::${shaA}`,
        `commit:b::${shaB}`,
        'file:a::src/only-a.ts',
        'file:b::src/x.ts',
      ].sort(),
    );
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const meta = getBrainNativeDb(root)!
      .prepare('SELECT metadata_json FROM brain_page_nodes WHERE id = ?')
      .get(`commit:a::${shaA}`);
    expect(JSON.parse(String(meta?.metadata_json))).toEqual({ repo: 'a' });

    // The receipt maps every old id to its new id.
    const receipt = JSON.parse(await readFile(applied.receiptPath!, 'utf-8'));
    expect(receipt.status).toBe('complete');
    expect(receipt.moved).toEqual(applied.moved);
    expect(receipt.nodes).toEqual(
      expect.arrayContaining([
        { oldId: 'file:src/x.ts', newId: 'file:b::src/x.ts' },
        { oldId: `commit:${shaA}`, newId: `commit:a::${shaA}` },
      ]),
    );
    expect(receipt.unresolved).toEqual(applied.unresolved);

    const again = await migrateEvidenceRepoIds(root, { apply: true });
    expect(again.moved).toEqual([]);
  });

  it('moves nothing in a single-repo store', async () => {
    const { migrateEvidenceRepoIds, EVIDENCE_EDGE_PROVENANCE } = await import(
      '../evidence-graph-links.js'
    );
    const { writeGraphBatch } = await import('../graph-auto-populate.js');
    await repo(root);
    await writeGraphBatch(
      root,
      [{ id: 'file:src/x.ts', nodeType: 'file', label: 'src/x.ts', qualityScore: 0.8 }],
      [
        {
          fromId: 'task:T1',
          toId: 'file:src/x.ts',
          edgeType: 'touches_code',
          provenance: EVIDENCE_EDGE_PROVENANCE,
        },
      ],
    );
    expect(await migrateEvidenceRepoIds(root)).toEqual({
      dryRun: true,
      receiptPath: null,
      moved: [],
      nodes: [],
      unresolved: [],
    });
  });
});
