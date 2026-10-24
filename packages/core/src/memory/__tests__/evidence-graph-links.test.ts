/**
 * Accepted verification evidence becomes brain graph links (T13950):
 * commits (and a PR's merge commit), files and decisions, written whatever
 * `brain.autoCapture` says, and idempotent on re-verify. File nodes are keyed
 * by repo-relative POSIX path; commit failures propagate.
 *
 * @task T13950
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
