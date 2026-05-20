/**
 * T9644 — `cleo docs publish-pr` test matrix.
 *
 * Subtask coverage (one `describe` per subtask):
 *   - T9716 — branch naming + temp worktree handling
 *   - T9718 — new-doc flow with frontmatter
 *   - T9717 — existing-PR atomic body update
 *   - T9719 — structured error envelopes
 *
 * Tests run `publishDocsAsPr` directly with stub `git` + `gh` runners so we
 * never touch the network or real subprocesses. The blob store is seeded
 * via `createAttachmentStore().put()` against an isolated tmp project root.
 *
 * @task T9644 / T9716 / T9717 / T9718 / T9719
 * @epic T9630
 * @saga T9625
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  branchForSlug,
  createAttachmentStore,
  publishDirForType,
  publishDocsAsPr,
  stripExistingFrontmatter,
  tempWorktreeDirForSlug,
  validatePublishSlug,
} from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docsCommand } from '../commands/docs.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cleo-T9644-'));
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

/** Seed the docs store with a slug-addressed blob. */
async function seedSlug(opts: {
  ownerId: string;
  slug: string;
  type?: string;
  content: string;
}): Promise<{ sha256: string }> {
  const store = createAttachmentStore();
  const bytes = Buffer.from(opts.content, 'utf-8');
  const meta = await store.put(
    bytes,
    {
      kind: 'blob',
      mime: 'text/markdown',
      size: bytes.length,
      description: `seed for ${opts.slug}`,
    },
    'task',
    opts.ownerId,
    'test',
    projectRoot,
    { slug: opts.slug, ...(opts.type ? { type: opts.type } : {}) },
  );
  return { sha256: meta.sha256 };
}

/**
 * Build a stub runner pair that records every invocation for later
 * inspection. The `gh` runner returns canned responses per command.
 */
function makeRunners(opts?: {
  ghPrListJson?: string;
  ghPrCreateUrl?: string;
  ghAuthFail?: string;
  gitPushFail?: string;
  ghPrCreateFail?: string;
  ghPrEditFail?: string;
  remoteHasBranch?: boolean;
}): {
  runners: Parameters<typeof publishDocsAsPr>[0]['runners'];
  calls: { git: string[][]; gh: string[][] };
} {
  const calls = { git: [] as string[][], gh: [] as string[][] };

  const gitRunner = async (args: readonly string[], _cwd: string) => {
    calls.git.push([...args]);

    // ls-remote --heads origin <branch> — returns SHA when remote has the branch.
    if (args[0] === 'ls-remote' && args[1] === '--heads') {
      if (opts?.remoteHasBranch) {
        return {
          stdout: 'cafebabecafebabecafebabecafebabecafebabe\trefs/heads/some\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    }

    // rev-parse --verify refs/heads/<branch> — fail when local branch doesn't exist.
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const err = new Error('not a known ref') as Error & { stderr: string };
      err.stderr = 'fatal: Needed a single revision';
      throw err;
    }

    // diff --cached --quiet — exit 0 means no diff, exit 1 means diff. We
    // throw to indicate "tree is dirty" so the commit branch is taken.
    if (args[0] === 'diff' && args.includes('--quiet')) {
      const err = new Error('exit 1') as Error & { stderr: string };
      err.stderr = '';
      throw err;
    }

    // rev-parse HEAD — return a deterministic sha so the test can assert.
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
    }

    // push — optionally fail.
    if (args[0] === 'push' && opts?.gitPushFail) {
      const err = new Error(opts.gitPushFail) as Error & { stderr: string };
      err.stderr = opts.gitPushFail;
      throw err;
    }

    return { stdout: '', stderr: '' };
  };

  const ghRunner = async (args: readonly string[], _cwd: string) => {
    calls.gh.push([...args]);

    // auth status — optionally fail.
    if (args[0] === 'auth' && args[1] === 'status') {
      if (opts?.ghAuthFail) {
        const err = new Error(opts.ghAuthFail) as Error & { stderr: string };
        err.stderr = opts.ghAuthFail;
        throw err;
      }
      return { stdout: 'Logged in to github.com as test\n', stderr: '' };
    }

    // pr list — return the canned JSON.
    if (args[0] === 'pr' && args[1] === 'list') {
      return { stdout: opts?.ghPrListJson ?? '[]', stderr: '' };
    }

    // pr create — optionally fail, else return canned PR URL on stdout.
    if (args[0] === 'pr' && args[1] === 'create') {
      if (opts?.ghPrCreateFail) {
        const err = new Error(opts.ghPrCreateFail) as Error & { stderr: string };
        err.stderr = opts.ghPrCreateFail;
        throw err;
      }
      return {
        stdout: (opts?.ghPrCreateUrl ?? 'https://github.com/test/test/pull/42') + '\n',
        stderr: '',
      };
    }

    // pr edit — optionally fail.
    if (args[0] === 'pr' && args[1] === 'edit') {
      if (opts?.ghPrEditFail) {
        const err = new Error(opts.ghPrEditFail) as Error & { stderr: string };
        err.stderr = opts.ghPrEditFail;
        throw err;
      }
      return { stdout: '', stderr: '' };
    }

    return { stdout: '', stderr: '' };
  };

  return { runners: { git: gitRunner, gh: ghRunner }, calls };
}

// ─── T9716 — branch naming + temp worktree handling ─────────────────────────

describe('T9716 — branch naming docs/<slug> + temp worktree handling', () => {
  it('validatePublishSlug accepts kebab-case slugs', () => {
    expect(validatePublishSlug('session-handoff').ok).toBe(true);
    expect(validatePublishSlug('a').ok).toBe(true);
    expect(validatePublishSlug('foo-bar-baz-123').ok).toBe(true);
  });

  it('validatePublishSlug rejects empty / overlong / non-kebab values', () => {
    const empty = validatePublishSlug('');
    expect(empty.ok).toBe(false);

    const dashed = validatePublishSlug('-leading');
    expect(dashed.ok).toBe(false);

    const upper = validatePublishSlug('CamelCase');
    expect(upper.ok).toBe(false);

    const overlong = validatePublishSlug('a'.repeat(81));
    expect(overlong.ok).toBe(false);
  });

  it('branchForSlug yields docs/<slug>', () => {
    expect(branchForSlug('session-handoff')).toBe('docs/session-handoff');
    expect(branchForSlug('a')).toBe('docs/a');
  });

  it('publishDirForType maps known types via the canonical registry and falls back to note', () => {
    // T9788 — publishDirs now flow from `BUILTIN_DOC_KINDS` in
    // @cleocode/contracts so the legacy fixed `docs/<type>` convention holds
    // for kinds whose metadata declares it (spec, adr), but kinds with
    // bespoke directories (llm-readme → '.', changeset → '.changeset')
    // return what the registry says rather than the legacy synthesised path.
    expect(publishDirForType('spec')).toBe('docs/spec');
    expect(publishDirForType('adr')).toBe('docs/adr');
    expect(publishDirForType('llm-readme')).toBe('.');
    expect(publishDirForType('changeset')).toBe('.changeset');
    expect(publishDirForType('release-note')).toBe('docs/release');
    expect(publishDirForType('rcasd')).toBe('.cleo/rcasd');
    expect(publishDirForType(undefined)).toBe('docs/note');
    expect(publishDirForType('weird-unknown')).toBe('docs/note');
    expect(publishDirForType(null)).toBe('docs/note');
  });

  it('tempWorktreeDirForSlug returns a unique path under os.tmpdir() prefixed with cleo-publish-pr', () => {
    const a = tempWorktreeDirForSlug('foo');
    const b = tempWorktreeDirForSlug('foo');
    expect(a).not.toBe(b);
    expect(a).toContain(tmpdir());
    expect(a).toMatch(/cleo-publish-pr-foo-[0-9a-f]{8}/);
  });
});

// ─── T9718 — new-doc publish flow with frontmatter ──────────────────────────

describe('T9718 — publish-pr new-doc flow with frontmatter', () => {
  it('opens a new PR on docs/<slug> when the remote branch does not exist', async () => {
    await seedSlug({
      ownerId: 'T-T9718-a',
      slug: 't9718-a',
      type: 'spec',
      content: '# T9718-a\n\nbody.\n',
    });

    const { runners, calls } = makeRunners({ remoteHasBranch: false });
    const result = await publishDocsAsPr({
      slugOrId: 't9718-a',
      projectRoot,
      runners,
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    if (!result.success) return;
    expect(result.data.action).toBe('new');
    expect(result.data.branch).toBe('docs/t9718-a');
    expect(result.data.prUrl).toBe('https://github.com/test/test/pull/42');
    expect(result.data.filePath).toBe('docs/spec/t9718-a.md');
    expect(result.data.type).toBe('spec');
    expect(result.data.slug).toBe('t9718-a');
    expect(result.data.priorSha).toBeUndefined();

    // Verify gh pr create was invoked (not pr edit).
    const ghCommands = calls.gh.map((args) => args[0] + ' ' + args[1]);
    expect(ghCommands).toContain('pr create');
    expect(ghCommands).not.toContain('pr edit');

    // Verify the branch checked out matches docs/<slug>.
    const worktreeAdd = calls.git.find((args) => args[0] === 'worktree' && args[1] === 'add');
    expect(worktreeAdd).toBeDefined();
    expect(worktreeAdd?.slice(2, 4)).toEqual(['-B', 'docs/t9718-a']);
  });

  it('writes YAML frontmatter (slug, type, blobSha, createdAt) on top of the body', async () => {
    const content = '# Plain body\n\nNo frontmatter here.\n';
    await seedSlug({
      ownerId: 'T-T9718-b',
      slug: 't9718-b',
      type: 'adr',
      content,
    });

    // Hook git's `add` to capture the file the worktree-side actually wrote.
    // The Buffer that publishDocsAsPr writes is sourced from
    // resolved.bytes — we re-derive the expected blobSha here.
    const { createHash } = await import('node:crypto');
    const expectedBlobSha = createHash('sha256').update(content).digest('hex');

    // Capture the file content via the writeFile path — easiest way is to
    // grep the worktree after publish, but the worktree is torn down in
    // `finally`. Instead, inject a git runner that snapshots the file
    // content from disk on `git add`.
    let writtenContent: string | null = null;
    const { readFile } = await import('node:fs/promises');
    const { runners, calls } = makeRunners({ remoteHasBranch: false });
    const baseGit = runners?.git as NonNullable<typeof runners>['git'];
    const wrappedRunners = {
      ...runners,
      git: async (args: readonly string[], cwd: string) => {
        if (args[0] === 'add') {
          // The file path is the last positional arg.
          const filePath = args[args.length - 1];
          try {
            writtenContent = await readFile(join(cwd, filePath), 'utf-8');
          } catch {
            /* ignore — the assertions below catch the failure */
          }
        }
        return baseGit?.(args, cwd) ?? { stdout: '', stderr: '' };
      },
    };

    const result = await publishDocsAsPr({
      slugOrId: 't9718-b',
      projectRoot,
      runners: wrappedRunners as typeof runners,
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(writtenContent, 'frontmatter file should have been staged via git add').toBeTypeOf(
      'string',
    );
    expect(writtenContent).toMatch(/^---\n/);
    expect(writtenContent).toMatch(/^slug: t9718-b$/m);
    expect(writtenContent).toMatch(/^type: adr$/m);
    expect(writtenContent).toMatch(new RegExp(`^blobSha: ${expectedBlobSha}$`, 'm'));
    expect(writtenContent).toMatch(/^createdAt: \d{4}-\d{2}-\d{2}T/m);
    expect(writtenContent).toContain('No frontmatter here.');

    // Quiet unused-var warning when test diagnostics aren't needed.
    void calls;
  });

  it('falls back to docs/note/<slug>.md when the stored type is unknown', async () => {
    await seedSlug({
      ownerId: 'T-T9718-c',
      slug: 't9718-c',
      content: 'untyped doc',
    });

    const { runners } = makeRunners({ remoteHasBranch: false });
    const result = await publishDocsAsPr({
      slugOrId: 't9718-c',
      projectRoot,
      runners,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.type).toBe('note');
    expect(result.data.filePath).toBe('docs/note/t9718-c.md');
  });

  it('stripExistingFrontmatter removes a leading --- block so frontmatter never double-stacks', () => {
    const withFm = `---\nfoo: bar\n---\nbody\n`;
    expect(stripExistingFrontmatter(withFm)).toBe('body\n');

    const withoutFm = `# heading\nbody\n`;
    expect(stripExistingFrontmatter(withoutFm)).toBe(withoutFm);
  });
});

// ─── T9717 — existing-PR atomic body update ─────────────────────────────────

describe('T9717 — publish-pr existing-PR atomic body update', () => {
  it('updates an existing open PR via gh pr edit instead of opening a new one', async () => {
    await seedSlug({
      ownerId: 'T-T9717-a',
      slug: 't9717-a',
      type: 'spec',
      content: 'updated content',
    });

    const priorSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const priorPrUrl = 'https://github.com/test/test/pull/77';
    const { runners, calls } = makeRunners({
      remoteHasBranch: true,
      ghPrListJson: JSON.stringify([{ number: 77, url: priorPrUrl, headRefOid: priorSha }]),
    });

    const result = await publishDocsAsPr({
      slugOrId: 't9717-a',
      projectRoot,
      runners,
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    if (!result.success) return;
    expect(result.data.action).toBe('updated');
    expect(result.data.prUrl).toBe(priorPrUrl);
    expect(result.data.priorSha).toBe(priorSha);

    // gh pr edit must have been called, not pr create.
    const ghCommands = calls.gh.map((args) => args[0] + ' ' + args[1]);
    expect(ghCommands).toContain('pr edit');
    expect(ghCommands).not.toContain('pr create');

    // Push must use --force-with-lease anchored to the priorSha (T9717).
    const pushArgs = calls.git.find((args) => args[0] === 'push');
    expect(pushArgs).toBeDefined();
    expect(pushArgs?.some((a) => a.startsWith('--force-with-lease='))).toBe(true);
    expect(pushArgs?.find((a) => a.startsWith('--force-with-lease='))).toContain(priorSha);
  });

  it('opens a new PR when the remote branch exists but no open PR is found', async () => {
    await seedSlug({
      ownerId: 'T-T9717-b',
      slug: 't9717-b',
      type: 'spec',
      content: 'stale branch, no PR',
    });

    const { runners, calls } = makeRunners({
      remoteHasBranch: true,
      ghPrListJson: '[]',
    });

    const result = await publishDocsAsPr({
      slugOrId: 't9717-b',
      projectRoot,
      runners,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.action).toBe('new');

    const ghCommands = calls.gh.map((args) => args[0] + ' ' + args[1]);
    expect(ghCommands).toContain('pr create');

    // Plain push, no lease (since priorSha was never captured).
    const pushArgs = calls.git.find((args) => args[0] === 'push');
    expect(pushArgs?.some((a) => a.startsWith('--force-with-lease='))).toBe(false);
  });
});

// ─── T9719 — structured error envelopes ─────────────────────────────────────

describe('T9719 — publish-pr structured error envelopes', () => {
  it('returns E_DOC_NOT_FOUND when the slug-or-id resolves to nothing', async () => {
    const { runners } = makeRunners();
    const result = await publishDocsAsPr({
      slugOrId: 'no-such-doc',
      projectRoot,
      runners,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.codeName).toBe('E_DOC_NOT_FOUND');
    expect(result.error.fix).toMatch(/cleo docs list --project/);
  });

  it('returns E_NO_GH_AUTH when gh auth status exits non-zero', async () => {
    await seedSlug({
      ownerId: 'T-T9719-a',
      slug: 't9719-a',
      content: 'irrelevant',
    });

    const { runners } = makeRunners({
      ghAuthFail: 'You are not logged into any GitHub hosts.',
    });
    const result = await publishDocsAsPr({
      slugOrId: 't9719-a',
      projectRoot,
      runners,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.codeName).toBe('E_NO_GH_AUTH');
    expect(result.error.fix).toMatch(/gh auth login/);
  });

  it('returns E_INVALID_SLUG when the stored attachment has no slug and slugOrId is not kebab-case', async () => {
    // Seed an attachment by sha (no slug, no slug override).
    const store = createAttachmentStore();
    const content = 'no slug attached';
    const meta = await store.put(
      Buffer.from(content, 'utf-8'),
      {
        kind: 'blob',
        mime: 'text/markdown',
        size: content.length,
        description: 'seed without slug',
      },
      'task',
      'T-T9719-b',
      'test',
      projectRoot,
    );

    const { runners } = makeRunners();
    const result = await publishDocsAsPr({
      slugOrId: meta.sha256,
      projectRoot,
      runners,
      // Force the slug override into an invalid value to exercise the
      // dedicated validator branch.
      slug: 'Not Kebab',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.codeName).toBe('E_INVALID_SLUG');
    expect(result.error.fix).toMatch(/--slug/);
  });

  it('returns E_PR_CREATE_FAILED when gh pr create exits non-zero', async () => {
    await seedSlug({
      ownerId: 'T-T9719-c',
      slug: 't9719-c',
      content: 'will fail',
    });

    const { runners } = makeRunners({
      remoteHasBranch: false,
      ghPrCreateFail: 'pull request create failed: validation failed',
    });
    const result = await publishDocsAsPr({
      slugOrId: 't9719-c',
      projectRoot,
      runners,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.codeName).toBe('E_PR_CREATE_FAILED');
    expect(result.error.message).toMatch(/gh pr create failed/);
  });

  it('returns E_NETWORK when git push fails', async () => {
    await seedSlug({
      ownerId: 'T-T9719-d',
      slug: 't9719-d',
      content: 'push fail',
    });

    const { runners } = makeRunners({
      remoteHasBranch: false,
      gitPushFail: 'fatal: unable to access',
    });
    const result = await publishDocsAsPr({
      slugOrId: 't9719-d',
      projectRoot,
      runners,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.codeName).toBe('E_NETWORK');
    expect(result.error.fix).toMatch(/network connectivity/);
  });

  it('returns E_PR_UPDATE_FAILED when gh pr edit fails on the update path', async () => {
    await seedSlug({
      ownerId: 'T-T9719-e',
      slug: 't9719-e',
      content: 'update fail',
    });

    const { runners } = makeRunners({
      remoteHasBranch: true,
      ghPrListJson: JSON.stringify([
        {
          number: 99,
          url: 'https://github.com/test/test/pull/99',
          headRefOid: 'feedfacefeedfacefeedfacefeedfacefeedface',
        },
      ]),
      ghPrEditFail: 'GraphQL error: Could not resolve to a Repository',
    });
    const result = await publishDocsAsPr({
      slugOrId: 't9719-e',
      projectRoot,
      runners,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.codeName).toBe('E_PR_UPDATE_FAILED');
    expect(result.error.message).toMatch(/gh pr edit failed/);
  });
});

// ─── CLI registration smoke ─────────────────────────────────────────────────

describe('T9644 — docsCommand exposes publish-pr subcommand', () => {
  it('registers publish-pr under docsCommand.subCommands', () => {
    const subs = docsCommand.subCommands as Record<string, unknown> | undefined;
    expect(subs?.['publish-pr']).toBeDefined();
  });
});
