/**
 * T12311 — a squash merge must not make shipped work look absent.
 *
 * Reproduced 2026-09-22 shipping v2026.9.12: T12310 was verified on its branch
 * as `8a866465`, squash-merged as `645da636`, tagged, and then
 * `cleo release reconcile` rejected the release because the recorded SHA was
 * not an ancestor of the tag. Its suggested repair — re-verify the task — is
 * refused by ADR-051 §11.1 for a completed task, so the error named a remedy
 * the system forbids and only an owner override could finish the release.
 *
 * These tests build a real repository and perform a real squash merge, because
 * the whole defect lives in what git does to a commit identity at merge time;
 * a stubbed git would encode the assumption under test.
 *
 * @task T12311
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveCommitPresenceInTag } from '../commit-presence.js';

const repo = join(tmpdir(), `cleo-t12311-${Date.now()}-${process.pid}`);

/** Run git in the fixture repository, returning trimmed stdout. */
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

/** Commit one file's contents on the current branch and return its SHA. */
function commit(file: string, body: string, message: string): string {
  writeFileSync(join(repo, file), body);
  git('add', file);
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

let branchSha = '';
let squashSha = '';
let mainOnlySha = '';

beforeAll(() => {
  mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't12311@example.test');
  git('config', 'user.name', 'T12311 Fixture');
  commit('seed.txt', 'seed\n', 'seed');

  // The work is authored on a branch, which is where evidence records its SHA.
  git('checkout', '-q', '-b', 'feat/work');
  branchSha = commit('feature.txt', 'the shipped change\n', 'feat: the work');

  // It lands by SQUASH, which discards branchSha and keeps its patch.
  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', 'feat/work');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'feat: the work (#1)');
  squashSha = git('rev-parse', 'HEAD');

  mainOnlySha = commit('after.txt', 'later\n', 'chore: after the merge');
  git('tag', '-a', 'v1.0.0', '-m', 'Release v1.0.0');

  // Deleting the branch is what a merge normally does, and is what makes the
  // recorded SHA unreachable rather than merely non-ancestral.
  git('branch', '-q', '-D', 'feat/work');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('T12311 AC1 — the squashed branch SHA still resolves as present', () => {
  it('establishes presence by patch identity and names the carrier', () => {
    // The precondition the old check asked about, and got right — the SHA
    // genuinely is not an ancestor. That answer was just not the question.
    expect(() =>
      execFileSync('git', ['merge-base', '--is-ancestor', branchSha, 'v1.0.0'], { cwd: repo }),
    ).toThrow();

    const presence = resolveCommitPresenceInTag(repo, branchSha, 'v1.0.0');
    expect(presence.present).toBe(true);
    if (!presence.present) return;
    expect(presence.via).toBe('patch-equivalent');
    if (presence.via !== 'patch-equivalent') return;
    // Equivalence is reported, never silently substituted.
    expect(presence.carriedBy).toBe(squashSha);
    expect(presence.patchId).toMatch(/^[0-9a-f]{40}$/);
  });

  it('prefers plain reachability when the SHA is still an ancestor', () => {
    const presence = resolveCommitPresenceInTag(repo, mainOnlySha, 'v1.0.0');
    expect(presence).toMatchObject({ present: true, via: 'ancestor', sha: mainOnlySha });
  });
});

describe('T12311 AC2/AC3 — absence is explained, and its remedy is executable', () => {
  it('does not claim presence for work that never shipped', () => {
    git('checkout', '-q', '-b', 'feat/unshipped');
    const unshipped = commit('unshipped.txt', 'never merged\n', 'feat: unshipped');
    git('checkout', '-q', 'main');

    const presence = resolveCommitPresenceInTag(repo, unshipped, 'v1.0.0');
    expect(presence.present).toBe(false);
    if (presence.present) return;
    expect(presence.reason).toContain('carries its patch');
    // ADR-051 §11.1 freezes verification on a completed task, so the remedy
    // must act on the RELEASE, not tell the caller to re-verify.
    expect(presence.fix).not.toMatch(/re-verify the affected task/i);
    expect(presence.fix).toMatch(/re-plan|tag a commit/i);
  });

  it('separates an unknown commit from an absent change', () => {
    const presence = resolveCommitPresenceInTag(repo, '0'.repeat(40), 'v1.0.0');
    expect(presence.present).toBe(false);
    if (presence.present) return;
    expect(presence.reason).toContain('unknown to this repository');
    expect(presence.fix).toContain('fetch');
  });

  it('separates an unusable tag from an absent change', () => {
    const presence = resolveCommitPresenceInTag(repo, mainOnlySha, 'v9.9.9-absent');
    expect(presence.present).toBe(false);
    if (presence.present) return;
    expect(presence.reason).toContain('does not resolve to a commit');
    expect(presence.fix).toContain('git fetch origin tag');
  });

  it('reports a merge commit honestly rather than guessing at its patch', () => {
    git('checkout', '-q', '-b', 'feat/merged');
    commit('merged.txt', 'merged work\n', 'feat: merged work');
    git('checkout', '-q', 'main');
    git('-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', 'feat/merged', '-m', 'merge');
    const mergeSha = git('rev-parse', 'HEAD');

    // Reachable from main but NOT from the earlier tag, and a merge carries no
    // single patch — so the answer must be an honest refusal, not a match.
    const presence = resolveCommitPresenceInTag(repo, mergeSha, 'v1.0.0');
    expect(presence.present).toBe(false);
    if (presence.present) return;
    expect(presence.reason).toMatch(/merge or empty commit|carries its patch/);
  });
});
