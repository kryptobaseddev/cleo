/** Deterministic real-Git lineage oracles; historical repository anchors are explicit opt-in. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReconstructResult } from '@cleocode/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { worktreeScope } from '../../project-scope.js';
import * as processCapture from '../../resources/spawn-wrapper.js';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import { reconstructLineage } from '../reconstruct.js';

/**
 * Absolute path to the repository root — resolved via import.meta.url.
 *
 * Path components from this file to the repo root:
 *   packages/core/src/audit/__tests__/reconstruct.test.ts
 *   ../../../../.. → T1322/ (worktree root, which IS the git repo root for this branch)
 */
const REPO_ROOT = new URL('../../../../..', import.meta.url).pathname.replace(/\/$/, '');

let fixture: string;
let scratch: string;
const direct: string[] = [];
let childSha: string;
let releaseSha: string;
let unrelatedSha: string;
const git = (args: string[], cwd = fixture): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture author',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture author',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_AUTHOR_DATE: '2026-01-01T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T12:00:00Z',
    },
  }).trim();
const commit = (message: string): string => {
  git(['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', message]);
  return git(['rev-parse', 'HEAD']);
};
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'audit-lineage-'));
  fixture = join(scratch, 'repo');
  git(['init', '--initial-branch=main', fixture], scratch);
  unrelatedSha = commit('T9940 false positive; XT994 and T994suffix are not exact tokens');
  git(['tag', 'before-work']);
  direct.push(commit('fix(T994): exact punctuation'));
  direct.push(commit('A subject without task ID\n\nTask: T994\nUnicode evidence: café'));
  direct.push(commit('T994/T9941 and [T994] are distinct task tokens'));
  childSha = commit('T995: neighboring candidate, no claimed containment authority');
  releaseSha = commit('release fixture');
  git(['tag', 'v-lightweight']);
  git(['tag', '-a', 'v-annotated', '-m', 'fixture release']);
  git(['checkout', '-b', 'unrelated', unrelatedSha]);
  commit('separate branch without task tokens');
  git(['tag', 'unrelated-branch']);
  git(['checkout', 'main']);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('bounded lineage with independent real Git evidence', () => {
  it('matches full-message exact tokens and computes containing tags in constant command count', async () => {
    const result = await reconstructLineage('T994', fixture, {
      execution: { deadlineAt: Date.now() + 10000 },
    });
    expect(result.directCommits.map((entry) => entry.sha).toSorted()).toEqual(direct.toSorted());
    expect(result.directCommits.some((entry) => entry.sha === unrelatedSha)).toBe(false);
    expect(result.childCommits.T995?.map((entry) => entry.sha)).toEqual([childSha]);
    expect(result.inferredChildren).toEqual(['T995']);
    expect(result.childIdRange).toEqual({ min: 'T995', max: 'T995' });
    expect(result.releaseTags.map((entry) => entry.tag)).toEqual(['v-annotated', 'v-lightweight']);
    expect(result.releaseCommitShas).toEqual([releaseSha]);
    expect(result.assessment).toMatchObject({
      coverage: 'current',
      historyComplete: true,
      tagsComplete: true,
      shallow: false,
    });
    expect(result.assessment?.commands).toHaveLength(3);
    expect(
      result.assessment?.commands.every(
        (command) => command.started && command.exitCode === 0 && command.transportClosed,
      ),
    ).toBe(true);
    expect(result.assessment?.limitations.join(' ')).toContain('not authoritative child tasks');
  });

  it('honors explicit repository ownership despite inherited Git directory aliases', async () => {
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(scratch, 'absent-git-dir');
    try {
      const result = await reconstructLineage('T994', fixture);
      expect(result.directCommits.map((entry) => entry.sha).toSorted()).toEqual(direct.toSorted());
      expect(result.assessment?.repositoryRoot).toBe(fixture);
      expect(result.assessment?.coverage).toBe('current');
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it('retains inherited item admission limits instead of building an unbounded history model', async () => {
    const execution = createOperationExecutionContext(
      {
        projectId: 'fixture',
        projectRoot: fixture,
        actor: 'test',
        operation: 'audit.reconstruct',
        idempotencyKey: 'item-limit',
      },
      { budgetMs: 10000, resources: { maxItems: 1 } },
    );
    try {
      const result = await worktreeScope.run(
        { worktreeRoot: fixture, projectHash: 'fixture', execution },
        () => reconstructLineage('T994', fixture),
      );
      expect(result.assessment?.coverage).toBe('failed');
      expect(result.assessment?.historyComplete).toBe(false);
      expect(result.assessment?.diagnostics.at(-1)?.code).toBe('E_OPERATION_RESOURCE_LIMIT');
    } finally {
      execution.close();
    }
  });

  it('reports missing Git evidence as a failed diagnostic, never healthy empty history', async () => {
    const result = await reconstructLineage('T994', scratch);
    expect(result.assessment?.coverage).toBe('failed');
    expect(result.assessment?.historyComplete).toBe(false);
    expect(result.assessment?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'E_GIT_READ_FAILED', stage: 'repository' }),
      ]),
    );
    expect(result.assessment?.commands[0]?.exitCode).not.toBe(0);
  });

  it('rejects expired inherited execution before launching instead of renewing a budget', async () => {
    const execution = createOperationExecutionContext(
      {
        projectId: 'fixture',
        projectRoot: fixture,
        actor: 'test',
        operation: 'audit.reconstruct',
        idempotencyKey: 'expired',
      },
      { budgetMs: 0 },
    );
    try {
      const result = await worktreeScope.run(
        { worktreeRoot: fixture, projectHash: 'fixture', execution },
        () =>
          reconstructLineage('T994', fixture, { execution: { deadlineAt: Date.now() + 60000 } }),
      );
      expect(result.assessment?.deadlineAt).toBe(execution.deadlineAt);
      expect(result.assessment?.commands).toEqual([]);
      expect(result.assessment?.coverage).toBe('failed');
      expect(result.assessment?.diagnostics[0]?.code).toMatch(/E_OPERATION_(DEADLINE|CANCELLED)/);
    } finally {
      execution.close();
    }
  });

  it('keeps caller cancellation and captured ownership before any Git invocation', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await reconstructLineage('T994', fixture, {
      execution: { deadlineAt: Date.now() + 10000, signal: controller.signal },
    });
    expect(result.assessment?.diagnostics[0]?.code).toBe('E_OPERATION_CANCELLED');
    expect(result.assessment?.commands).toEqual([]);
  });

  it('discloses actual aggregate output truncation and retains target cleanup evidence', async () => {
    const result = await reconstructLineage('T994', fixture, {
      maxOutputBytes: 128,
      execution: { deadlineAt: Date.now() + 10000 },
    });
    expect(result.assessment?.coverage).toBe('failed');
    expect(result.assessment?.historyComplete).toBe(false);
    expect(result.assessment?.commands.at(-1)).toMatchObject({
      outputTruncated: true,
      stopped: 'output-limit',
      transportClosed: true,
    });
    expect(result.assessment?.diagnostics.at(-1)?.stage).toBe('history');
  });

  it('stops an actual running target at the inherited deadline without launching later stages', async () => {
    const realCapture = processCapture.captureWrapped;
    const spy = vi
      .spyOn(processCapture, 'captureWrapped')
      .mockImplementation((_command, _args, options) =>
        realCapture(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options),
      );
    const deadlineAt = Date.now() + 150;
    try {
      const result = await reconstructLineage('T994', fixture, { execution: { deadlineAt } });
      expect(result.assessment?.deadlineAt).toBe(deadlineAt);
      expect(result.assessment?.commands).toHaveLength(1);
      expect(result.assessment?.commands[0]).toMatchObject({
        stopped: 'deadline',
        transportClosed: true,
      });
      expect(result.assessment?.coverage).toBe('failed');
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects malformed captured history rather than silently dropping invalid records', async () => {
    const realCapture = processCapture.captureWrapped;
    const spy = vi
      .spyOn(processCapture, 'captureWrapped')
      .mockImplementation((command, args, options) =>
        args[0] === 'log'
          ? realCapture(
              process.execPath,
              ['-e', 'process.stdout.write("invalid history")'],
              options,
            )
          : realCapture(command, args, options),
      );
    try {
      const result = await reconstructLineage('T994', fixture);
      expect(result.assessment?.coverage).toBe('failed');
      expect(result.assessment?.historyComplete).toBe(false);
      expect(result.assessment?.diagnostics.at(-1)?.code).toBe('E_GIT_PROTOCOL');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports shallow scope explicitly despite a successful Git read', async () => {
    const shallow = join(scratch, 'shallow');
    git(['clone', '--depth=1', '--branch=main', `file://${fixture}`, shallow], scratch);
    const result = await reconstructLineage('T994', shallow, {
      execution: { deadlineAt: Date.now() + 10000 },
    });
    expect(result.assessment?.shallow).toBe(true);
    expect(result.assessment?.coverage).toBe('partial');
    expect(result.assessment?.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_SHALLOW_HISTORY' }),
    );
  });

  it('retains assessed commits if the later tag read fails, without claiming complete lineage', async () => {
    const realCapture = processCapture.captureWrapped;
    const spy = vi
      .spyOn(processCapture, 'captureWrapped')
      .mockImplementation((command, args, options) =>
        realCapture(
          command,
          args[0] === 'for-each-ref' ? ['not-a-real-git-command'] : args,
          options,
        ),
      );
    try {
      const result = await reconstructLineage('T994', fixture, {
        execution: { deadlineAt: Date.now() + 10000 },
      });
      expect(result.directCommits.map((entry) => entry.sha).toSorted()).toEqual(direct.toSorted());
      expect(result.assessment).toMatchObject({
        coverage: 'partial',
        historyComplete: true,
        tagsComplete: false,
      });
      expect(result.assessment?.diagnostics.at(-1)).toMatchObject({
        code: 'E_GIT_READ_FAILED',
        stage: 'tags',
      });
    } finally {
      spy.mockRestore();
    }
  });
});

// These describe blocks require a full git clone with complete history (T991/T994-T999
// commits and tag v2026.4.98). CI uses a shallow checkout that lacks this history,
// so they are skipped in CI and run locally only. Do NOT delete — they are valid
// integration tests against the real git ledger.
describe.runIf(process.env['CLEO_AUDIT_HISTORICAL_ANCHORS'] === '1')(
  'reconstructLineage — T991 anchor case',
  () => {
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
      // History was rewritten: the release commit changed SHA but retained this exact tree.
      // Assert the immutable release artifact rather than an unreachable pre-rewrite commit.
      const releaseCommit = result.directCommits.find((c) => c.subject.includes('v2026.4.98'));
      expect(releaseCommit).toBeDefined();
      if (!releaseCommit) throw new Error('Missing release anchor');
      const tree = execFileSync('git', ['rev-parse', `${releaseCommit.sha}^{tree}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim();
      expect(tree).toBe('31e715fab0226801c5a83e6c76ecfb8f0d6e5fda');
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
  },
);

describe('reconstructLineage — result shape contract', () => {
  let result: ReconstructResult;

  beforeAll(async () => {
    result = await reconstructLineage('T994', fixture);
  });

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
    const empty = await reconstructLineage('T99999999', fixture);
    expect(empty.taskId).toBe('T99999999');
    expect(empty.directCommits).toHaveLength(0);
    expect(empty.releaseTags).toHaveLength(0);
    expect(empty.releaseCommitShas).toHaveLength(0);
    expect(empty.firstSeenAt).toBeNull();
    expect(empty.lastSeenAt).toBeNull();
  });
});

// Explicit opt-in only: a full historical clone is an additional integration prerequisite.
describe.runIf(process.env['CLEO_AUDIT_HISTORICAL_ANCHORS'] === '1')(
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
