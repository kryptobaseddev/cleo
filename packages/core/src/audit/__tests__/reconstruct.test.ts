/**
 * Unit tests for `reconstructLineage` — audit lineage SDK primitive.
 *
 * Critical case: T991 → T994-T999 reconstruction.
 * The release commit `18128e3ce` (v2026.4.98) is the anchor:
 *   - 6 child task IDs: T994, T995, T996, T997, T998, T999
 *   - Each child has at least one commit in the real git history
 *   - All are contained in tags v2026.4.98 and above
 *
 * Tests run against the real git history of this repo because git IS the
 * ledger — no mock transport is appropriate here (T1322 council mandate).
 *
 * Performance: `reconstructLineage` is called once per describe block via
 * `beforeAll` so git subprocess overhead is shared across assertions.
 *
 * @task T1322
 * @epic T1216
 */

import type { ReconstructResult } from '@cleocode/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { reconstructLineage } from '../reconstruct.js';

/**
 * Absolute path to the repository root — resolved via import.meta.url.
 *
 * Path components from this file to the repo root:
 *   packages/core/src/audit/__tests__/reconstruct.test.ts
 *   ../../../../.. → T1322/ (worktree root, which IS the git repo root for this branch)
 */
const REPO_ROOT = new URL('../../../../..', import.meta.url).pathname.replace(/\/$/, '');

// These describe blocks require a full git clone with complete history (T991/T994-T999
// commits and tag v2026.4.98). CI uses a shallow checkout that lacks this history,
// so they are skipped in CI and run locally only. Do NOT delete — they are valid
// integration tests against the real git ledger.
describe.skipIf(process.env['CI'] === 'true')('reconstructLineage — T991 anchor case', () => {
  let result: ReconstructResult;

  beforeAll(async () => {
    result = await reconstructLineage('T991', REPO_ROOT);
  }, 120_000); // 2-minute timeout for git operations

  it('returns a ReconstructResult with the correct taskId', () => {
    expect(result.taskId).toBe('T991');
  });

  it('finds at least one direct commit mentioning T991', () => {
    expect(result.directCommits.length).toBeGreaterThanOrEqual(1);
    // The release commit is the canonical direct reference
    const releaseCommit = result.directCommits.find((c) => c.subject.includes('v2026.4.98'));
    expect(releaseCommit).toBeDefined();
    expect(releaseCommit?.sha.slice(0, 8)).toBe('18128e3c');
  });

  it('infers children T994 through T999 (the 6-child BRAIN-integrity cluster)', () => {
    expect(result.inferredChildren).toEqual(
      expect.arrayContaining(['T994', 'T995', 'T996', 'T997', 'T998', 'T999']),
    );
  });

  it('childIdRange covers T994 to T999 at minimum', () => {
    expect(result.childIdRange).not.toBeNull();
    if (result.childIdRange === null) return; // narrowing
    const minNum = parseInt(result.childIdRange.min.slice(1), 10);
    const maxNum = parseInt(result.childIdRange.max.slice(1), 10);
    expect(minNum).toBeLessThanOrEqual(994);
    expect(maxNum).toBeGreaterThanOrEqual(999);
  });

  it('finds child commits for each of the 6 child IDs', () => {
    const childIds = ['T994', 'T995', 'T996', 'T997', 'T998', 'T999'];
    for (const id of childIds) {
      expect(
        result.childCommits[id],
        `Expected childCommits to contain entries for ${id}`,
      ).toBeDefined();
      expect(result.childCommits[id]!.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('finds release tag v2026.4.98 in releaseTags', () => {
    const tagNames = result.releaseTags.map((t) => t.tag);
    expect(tagNames).toContain('v2026.4.98');
  });

  it('releaseCommitShas is non-empty', () => {
    expect(result.releaseCommitShas.length).toBeGreaterThanOrEqual(1);
  });

  it('firstSeenAt and lastSeenAt are ISO-8601 strings', () => {
    expect(result.firstSeenAt).not.toBeNull();
    expect(result.lastSeenAt).not.toBeNull();
    // Basic ISO-8601 format check
    expect(result.firstSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(result.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('firstSeenAt is before or equal to lastSeenAt', () => {
    if (result.firstSeenAt && result.lastSeenAt) {
      expect(result.firstSeenAt <= result.lastSeenAt).toBe(true);
    }
  });
});

describe('reconstructLineage — result shape contract', () => {
  let result: ReconstructResult;

  beforeAll(async () => {
    result = await reconstructLineage('T994', REPO_ROOT);
  }, 120_000);

  it('returns all required fields for a known task', () => {
    expect(result).toHaveProperty('taskId', 'T994');
    expect(result).toHaveProperty('directCommits');
    expect(result).toHaveProperty('childIdRange');
    expect(result).toHaveProperty('childCommits');
    expect(result).toHaveProperty('releaseTags');
    expect(result).toHaveProperty('releaseCommitShas');
    expect(result).toHaveProperty('firstSeenAt');
    expect(result).toHaveProperty('lastSeenAt');
    expect(result).toHaveProperty('inferredChildren');
    // Arrays
    expect(Array.isArray(result.directCommits)).toBe(true);
    expect(Array.isArray(result.releaseTags)).toBe(true);
    expect(Array.isArray(result.releaseCommitShas)).toBe(true);
    expect(Array.isArray(result.inferredChildren)).toBe(true);
    // childCommits is a plain object
    expect(typeof result.childCommits).toBe('object');
  });

  it('each CommitEntry has sha, subject, author, authorDate', () => {
    for (const commit of result.directCommits) {
      expect(typeof commit.sha).toBe('string');
      expect(commit.sha.length).toBeGreaterThanOrEqual(7);
      expect(typeof commit.subject).toBe('string');
      expect(typeof commit.author).toBe('string');
      expect(typeof commit.authorDate).toBe('string');
    }
  });

  it('each ReleaseTagEntry has tag, commitSha, subject', () => {
    for (const entry of result.releaseTags) {
      expect(typeof entry.tag).toBe('string');
      expect(entry.tag.length).toBeGreaterThan(0);
      expect(typeof entry.commitSha).toBe('string');
      expect(typeof entry.subject).toBe('string');
    }
  });

  it('gracefully handles a non-existent task ID (returns empty arrays)', async () => {
    const empty = await reconstructLineage('T99999999', REPO_ROOT);
    expect(empty.taskId).toBe('T99999999');
    expect(empty.directCommits).toHaveLength(0);
    expect(empty.releaseTags).toHaveLength(0);
    expect(empty.releaseCommitShas).toHaveLength(0);
    expect(empty.firstSeenAt).toBeNull();
    expect(empty.lastSeenAt).toBeNull();
  }, 120_000);
});

// Skipped in CI (shallow checkout lacks T994 commit history and v2026.4.98 tag).
// Runs locally with a full clone.
describe.skipIf(process.env['CI'] === 'true')(
  'reconstructLineage — child task cross-check (T994 individual)',
  () => {
    let result: ReconstructResult;

    beforeAll(async () => {
      result = await reconstructLineage('T994', REPO_ROOT);
    }, 120_000);

    it('T994 has a direct commit with "T994"', () => {
      const hit = result.directCommits.find((c) => c.subject.includes('T994'));
      expect(hit).toBeDefined();
    });

    it('T994 is contained in v2026.4.98', () => {
      const tagNames = result.releaseTags.map((t) => t.tag);
      expect(tagNames).toContain('v2026.4.98');
    });
  },
);
