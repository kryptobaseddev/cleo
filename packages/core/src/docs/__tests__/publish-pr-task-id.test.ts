/**
 * T12549 — `cleo docs publish --target pr` stamps the owning task id into the
 * commit subject so repos with a T-ID commit-msg hook accept the commit.
 *
 * `publishDocsAsPr` runs end-to-end against a real attachment store seeded in
 * a tmp project root. `git`/`gh` go through the injected runner overrides and
 * `@cleocode/worktree` is mocked so no real worktree is provisioned.
 *
 * @task T12549
 * @epic T12515
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentRef } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const worktreeMocks = vi.hoisted(() => ({
  add: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
}));

vi.mock('@cleocode/worktree', () => ({
  addTransientWorktree: worktreeMocks.add,
  removeTransientWorktree: worktreeMocks.remove,
}));

import { createAttachmentStore } from '../../store/attachment-store.js';
import {
  buildPublishCommitMessage,
  buildPublishCommitSubject,
  type PublishPrRunners,
  publishDocsAsPr,
  resolvePublishTaskId,
} from '../publish-pr.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T12549-'));
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });
  worktreeMocks.add.mockClear();
  worktreeMocks.remove.mockClear();
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
});

/** Seed one slug-addressed doc, bound to every listed owner. */
async function seedDoc(
  slug: string,
  owners: ReadonlyArray<[AttachmentRef['ownerType'], string]>,
): Promise<void> {
  const store = createAttachmentStore();
  const bytes = Buffer.from(`# ${slug}\n\nbody.\n`, 'utf-8');
  const [first, ...rest] = owners;
  if (!first) throw new Error('seedDoc needs at least one owner');
  const meta = await store.put(
    bytes,
    { kind: 'blob', mime: 'text/markdown', size: bytes.length, description: slug },
    first[0],
    first[1],
    'test',
    projectRoot,
    { slug, type: 'spec' },
  );
  for (const [ownerType, ownerId] of rest) {
    await store.ref(meta.id, ownerType, ownerId, 'test', projectRoot);
  }
}

/** Stub runners recording every call; `commitFail` makes `git commit` throw. */
function makeRunners(opts?: { commitFail?: string }): {
  runners: PublishPrRunners;
  calls: { git: string[][]; gh: string[][] };
} {
  const calls = { git: [] as string[][], gh: [] as string[][] };
  const fail = (msg: string): never => {
    const err = new Error(msg) as Error & { stderr: string };
    err.stderr = msg;
    throw err;
  };
  return {
    calls,
    runners: {
      git: async (args) => {
        calls.git.push([...args]);
        if (args[0] === 'rev-parse' && args[1] === '--verify')
          fail('fatal: Needed a single revision');
        if (args[0] === 'diff' && args.includes('--quiet')) fail('');
        if (args[0] === 'commit' && opts?.commitFail) fail(opts.commitFail);
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
      gh: async (args) => {
        calls.gh.push([...args]);
        if (args[0] === 'pr' && args[1] === 'create') {
          return { stdout: 'https://github.com/test/test/pull/7\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    },
  };
}

/** The `-m` payload of the recorded `git commit`, if any. */
function commitMessageOf(calls: { git: string[][] }): string | undefined {
  const commit = calls.git.find((a) => a[0] === 'commit');
  if (!commit) return undefined;
  return commit[commit.indexOf('-m') + 1];
}

/** The `--title` payload of the recorded `gh pr create`, if any. */
function prTitleOf(calls: { gh: string[][] }): string | undefined {
  const create = calls.gh.find((a) => a[0] === 'pr' && a[1] === 'create');
  if (!create) return undefined;
  return create[create.indexOf('--title') + 1];
}

describe('T12549 — commit subject format', () => {
  it('uses docs(T####) with a Task trailer and keeps the slug/type/blobSha lines', () => {
    const msg = buildPublishCommitMessage({
      slug: 'my-doc',
      type: 'spec',
      blobSha: 'abc',
      taskId: 'T1234',
    });
    expect(msg).toBe(
      'docs(T1234): publish my-doc\n\nslug: my-doc\ntype: spec\nblobSha: abc\n\nTask: T1234',
    );
  });

  it('falls back to docs(<type>) with no trailer when no task resolved', () => {
    const msg = buildPublishCommitMessage({ slug: 'd', type: 'adr', blobSha: 'x', taskId: null });
    expect(msg).toBe('docs(adr): publish d\n\nslug: d\ntype: adr\nblobSha: x');
    expect(buildPublishCommitSubject({ slug: 'd', type: 'adr', taskId: null })).toBe(
      'docs(adr): publish d',
    );
  });
});

describe('T12549 — resolvePublishTaskId', () => {
  it('ignores non-task owners and non-T#### ids', () => {
    const r = resolvePublishTaskId({
      owners: [
        { ownerType: 'session', ownerId: 'ses_1' },
        { ownerType: 'task', ownerId: 'not-a-task' },
        { ownerType: 'task', ownerId: 'T42' },
        { ownerType: 'task', ownerId: 'T42' },
      ],
    });
    expect(r).toEqual({ ok: true, taskId: 'T42' });
  });

  it('rejects a malformed --task value', () => {
    const r = resolvePublishTaskId({ taskId: 'task-1', owners: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.codeName).toBe('E_INVALID_TASK_ID');
  });
});

describe('T12549 — publishDocsAsPr task id resolution', () => {
  it('derives the task id from the single task owner ref', async () => {
    await seedDoc('owned-doc', [['task', 'T9001']]);
    const { runners, calls } = makeRunners();

    const result = await publishDocsAsPr({ slugOrId: 'owned-doc', projectRoot, runners });

    expect(result.success, JSON.stringify(result)).toBe(true);
    if (!result.success) return;
    expect(result.data.taskId).toBe('T9001');
    const msg = commitMessageOf(calls);
    expect(msg?.split('\n')[0]).toBe('docs(T9001): publish owned-doc');
    expect(msg).toMatch(/^slug: owned-doc$/m);
    expect(msg).toMatch(/^type: spec$/m);
    expect(msg).toMatch(/^blobSha: [0-9a-f]{64}$/m);
    expect(msg?.trimEnd().endsWith('Task: T9001')).toBe(true);
    expect(prTitleOf(calls)).toBe('docs(T9001): publish owned-doc');
    // Hooks are never bypassed.
    expect(calls.git.flat()).not.toContain('--no-verify');
  });

  it('lets --task override the derived owner', async () => {
    await seedDoc('override-doc', [['task', 'T9001']]);
    const { runners, calls } = makeRunners();

    const result = await publishDocsAsPr({
      slugOrId: 'override-doc',
      projectRoot,
      runners,
      taskId: 'T777',
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(commitMessageOf(calls)?.split('\n')[0]).toBe('docs(T777): publish override-doc');
    expect(commitMessageOf(calls)).toMatch(/^Task: T777$/m);
    expect(prTitleOf(calls)).toBe('docs(T777): publish override-doc');
  });

  it('keeps an explicit --title for the PR while the commit carries the task id', async () => {
    await seedDoc('titled-doc', [['task', 'T9001']]);
    const { runners, calls } = makeRunners();

    const result = await publishDocsAsPr({
      slugOrId: 'titled-doc',
      projectRoot,
      runners,
      title: 'Custom title',
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(prTitleOf(calls)).toBe('Custom title');
    expect(commitMessageOf(calls)?.split('\n')[0]).toBe('docs(T9001): publish titled-doc');
  });

  it('refuses ambiguous task owners before any side effect', async () => {
    await seedDoc('shared-doc', [
      ['task', 'T100'],
      ['task', 'T200'],
    ]);
    const { runners, calls } = makeRunners();

    const result = await publishDocsAsPr({ slugOrId: 'shared-doc', projectRoot, runners });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.codeName).toBe('E_PUBLISH_TASK_AMBIGUOUS');
    expect(result.error.fix).toContain('--task');
    expect(result.error.details).toEqual({ candidates: ['T100', 'T200'] });
    expect(calls.git).toEqual([]);
    expect(calls.gh).toEqual([]);
    expect(worktreeMocks.add).not.toHaveBeenCalled();
  });

  it('resolves ambiguous owners when --task is given', async () => {
    await seedDoc('shared-doc-2', [
      ['task', 'T100'],
      ['task', 'T200'],
    ]);
    const { runners, calls } = makeRunners();

    const result = await publishDocsAsPr({
      slugOrId: 'shared-doc-2',
      projectRoot,
      runners,
      taskId: 'T200',
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(commitMessageOf(calls)?.split('\n')[0]).toBe('docs(T200): publish shared-doc-2');
  });

  it('attempts an untagged commit when no task owns the doc', async () => {
    await seedDoc('session-doc', [['session', 'ses_abc']]);
    const { runners, calls } = makeRunners();

    const result = await publishDocsAsPr({ slugOrId: 'session-doc', projectRoot, runners });

    expect(result.success, JSON.stringify(result)).toBe(true);
    if (!result.success) return;
    expect(result.data.taskId).toBeNull();
    expect(commitMessageOf(calls)?.split('\n')[0]).toBe('docs(spec): publish session-doc');
    expect(commitMessageOf(calls)).not.toMatch(/^Task:/m);
  });

  it('maps a commit-msg hook rejection to E_PUBLISH_COMMIT_REJECTED and tears down', async () => {
    await seedDoc('hooked-doc', [['session', 'ses_abc']]);
    const hookStderr = 'commit-msg: subject must reference a task id (T####)';
    const { runners, calls } = makeRunners({ commitFail: hookStderr });

    const result = await publishDocsAsPr({ slugOrId: 'hooked-doc', projectRoot, runners });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.codeName).toBe('E_PUBLISH_COMMIT_REJECTED');
    expect(result.error.message).toContain(hookStderr);
    expect(result.error.fix).toContain('--task T####');
    expect(result.error.details).toMatchObject({
      stderr: hookStderr,
      subject: 'docs(spec): publish hooked-doc',
      taskId: null,
    });
    // No push, no PR, and the temp worktree was torn down.
    expect(calls.git.some((a) => a[0] === 'push')).toBe(false);
    expect(calls.gh.some((a) => a[0] === 'pr' && a[1] === 'create')).toBe(false);
    expect(worktreeMocks.remove).toHaveBeenCalledTimes(1);
    expect(calls.git.flat()).not.toContain('--no-verify');
  });
});
