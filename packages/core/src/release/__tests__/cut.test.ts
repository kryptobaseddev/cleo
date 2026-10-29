/**
 * `cleo release cut` / `write-changelog` / `verify-tag` (T14102): the newest
 * first-parent commit whose required checks are all green on its push run is
 * picked, the version is CalVer and above every release, the notes come from
 * the changesets since the previous tag, task status is reported (not gated),
 * and the tag is created only for real, after CI is judged again.
 *
 * @task T14102
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reconciled: string[] = [];
let releaseStatus: string | undefined;
vi.mock('../../store/sqlite.js', () => ({
  getDb: async () => ({
    select: () => ({
      from: () => ({
        where: () => ({ get: async () => (releaseStatus ? { status: releaseStatus } : undefined) }),
      }),
    }),
  }),
}));
vi.mock('../reconcile.js', () => ({
  releaseReconcileV2: async (version: string) => {
    reconciled.push(version);
    return { success: true, data: {} };
  },
}));
const emptySweep = {
  swept: false,
  dryRun: false,
  prs: [],
  closed: [] as string[],
  bound: [],
  refused: [],
  waiting: 0,
  reran: 0,
};
vi.mock('../../tasks/merge-close.js', () => ({
  sweepMergedClosures: async () => ({ ...emptySweep, skippedReason: 'test' }),
}));
let rotOrphans: Array<{ doc: string; reason: string }> = [];
vi.mock('../../docs/rot.js', () => ({
  scanDocsRot: () => ({
    scanned: 0,
    covering: 0,
    stale: [],
    duplicates: [],
    orphans: rotOrphans,
    flagged: [],
    durationMs: 0,
    summary: `${rotOrphans.length} orphan(s)`,
  }),
}));
vi.mock('../../store/data-accessor.js', () => ({
  getTaskAccessor: async () => ({
    loadSingleTask: async (id: string) => (id === 'T1' ? { id, status: 'done' } : null),
    close: async () => {},
  }),
}));

import {
  RELEASE_CUT_AUDIT_FILE,
  type ReleaseCutRunner,
  releaseChangelog,
  releaseCut,
  releaseVerifyTag,
} from '../cut.js';
import { reconcileLatestRelease } from '../reconcile-latest.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function changeset(id: string, task: string, summary: string): string {
  return `---\nid: ${id}\ntasks: [${task}]\nkind: fix\nsummary: "${summary}"\n---\n\nBody.\n`;
}

// Versions follow release.yml's CalVer window, so the tests hold in any month.
const now = new Date();
const YM = `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}`;
const PREV = `${YM}.1`;
const NEXT = `${YM}.2`;

let dirs: string[] = [];
let work = '';
const shas: { tagged: string; fix: string; head: string } = { tagged: '', fix: '', head: '' };

beforeEach(() => {
  const origin = mkdtempSync(join(tmpdir(), 'cut-origin-'));
  work = mkdtempSync(join(tmpdir(), 'cut-work-'));
  dirs = [origin, work];
  git(origin, 'init', '--quiet', '--bare', '-b', 'main');
  git(work, 'init', '--quiet', '-b', 'main');
  git(work, 'config', 'user.email', 't@example.com');
  git(work, 'config', 'user.name', 'T');
  git(work, 'remote', 'add', 'origin', origin);

  write(
    work,
    '.cleo/project-context.json',
    JSON.stringify({
      release: {
        prRequiredWorkflows: [
          { name: 'CI', app: 'github-actions', workflow: '.github/workflows/ci.yml' },
          {
            name: 'Contracts Dep Lint',
            app: 'github-actions',
            workflow: '.github/workflows/ci.yml',
          },
        ],
      },
    }),
  );
  write(work, '.github/workflows/release.yml', 'run: |\n  publish_pkg core\n');
  write(work, 'package.json', `{"name":"root","version":"${PREV}"}\n`);
  write(work, 'packages/core/package.json', '{"name":"@cleocode/core","version":"0.0.0"}\n');
  write(work, '.changeset/old-fix.md', changeset('old-fix', 'T0', 'shipped last time'));
  write(work, 'CHANGELOG.md', `# Changelog\n\n## [${PREV}] (2026-01-01)\n\n- old\n`);
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'one');
  git(work, 'tag', `v${PREV}`);
  shas.tagged = git(work, 'rev-parse', 'HEAD');

  write(work, '.changeset/new-fix.md', changeset('new-fix', 'T1', 'the new fix'));
  write(work, 'packages/core/migrations/drizzle-tasks/m1/migration.sql', 'SELECT 1;\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'two');
  shas.fix = git(work, 'rev-parse', 'HEAD');

  write(work, 'README.md', 'x\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'three');
  shas.head = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '--quiet', 'origin', 'main', '--tags');
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Per sha: one state for both required jobs, or a state per job name. */
type CiFixture = Record<string, string | Record<string, string>>;

function fakeRunner(
  ci: CiFixture,
  opts: { merged?: boolean; failRef?: boolean } = {},
): { runner: ReleaseCutRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runIds: string[] = [];
  const jobState = (sha: string, name: string): string => {
    const entry = ci[sha] ?? 'none';
    return typeof entry === 'string' ? entry : (entry[name] ?? 'missing');
  };
  const runner: ReleaseCutRunner = {
    runGit: (args, cwd) => git(cwd, ...args),
    runGh: (args) => {
      calls.push([...args]);
      const path = args.find((a) => a.startsWith('repos/')) ?? '';
      const runs = /actions\/workflows\/ci\.yml\/runs\?head_sha=(\w+)&event=push/.exec(path);
      if (runs) {
        const sha = runs[1] ?? '';
        if (ci[sha] === undefined) return '{"workflow_runs":[]}';
        const pending = ['CI', 'Contracts Dep Lint'].some(
          (n) => jobState(sha, n) === 'in_progress',
        );
        runIds.push(sha);
        return JSON.stringify({
          workflow_runs: [
            {
              id: runIds.length,
              run_attempt: 1,
              status: pending ? 'in_progress' : 'completed',
              conclusion: null,
            },
          ],
        });
      }
      const jobs = /actions\/runs\/(\d+)\/attempts\/1\/jobs/.exec(path);
      if (jobs) {
        const sha = runIds[Number(jobs[1]) - 1] ?? '';
        return JSON.stringify({
          jobs: ['CI', 'Contracts Dep Lint'].map((name) => ({
            name,
            status: 'completed',
            conclusion: jobState(sha, name),
          })),
        });
      }
      if (path.endsWith('/pulls'))
        return opts.merged === false ? '[]' : '[{"merged_at":"2026-10-28T00:00:00Z"}]';
      if (path.endsWith('git/tags')) return '{"sha":"tagobject"}';
      if (path.endsWith('git/refs') && opts.failRef)
        throw new Error('HTTP 422: Reference update failed');
      return '{}';
    },
  };
  return { runner, calls };
}

function errorOf(result: { success: boolean; error?: { code: string; message: string } }) {
  expect(result.success).toBe(false);
  return result.error ?? { code: '', message: '' };
}

describe('releaseCut (T14102)', () => {
  it('dry run picks the newest green commit and reports notes, packages, migrations and tasks', async () => {
    const { runner, calls } = fakeRunner({ [shas.head]: 'in_progress', [shas.fix]: 'success' });
    const lead = join(work, 'lead.md');
    writeFileSync(lead, '> **Update now.**\n');
    const sweeps: Array<{ dryRun?: boolean; force?: boolean }> = [];
    const result = await releaseCut({
      version: NEXT,
      projectRoot: work,
      dryRun: true,
      leadFile: lead,
      runner,
      sweep: async (_root, opts) => {
        sweeps.push(opts);
        return { ...emptySweep, swept: true, dryRun: opts.dryRun === true, closed: ['T1'] };
      },
    });
    expect(sweeps).toEqual([{ dryRun: true, force: true }]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data;
    expect(data.sha).toBe(shas.fix);
    expect(data.candidates.map((c) => c.ci)).toEqual(['CI: in_progress', 'success']);
    expect(data.previousTag).toBe(`v${PREV}`);
    expect(data.changesets).toEqual(['.changeset/new-fix.md']);
    expect(data.notes.startsWith('> **Update now.**')).toBe(true);
    expect(data.notes).toContain('the new fix');
    expect(data.notes).not.toContain('shipped last time');
    expect(data.packages).toEqual([{ dir: 'core', name: '@cleocode/core', version: NEXT }]);
    expect(data.migrations).toEqual(['packages/core/migrations/drizzle-tasks/m1/migration.sql']);
    expect(data.tasks).toEqual([{ id: 'T1', status: 'done' }]);
    expect(data.sweep.closed).toEqual(['T1']);
    expect(data.checkoutAtMain).toBe(true);
    expect(data.tagCreated).toBe(false);
    expect(calls.some((c) => c.includes('POST'))).toBe(false);
  });

  it('refuses when no recent commit has green CI', async () => {
    const { runner } = fakeRunner({ [shas.head]: 'failure' });
    const result = await releaseCut({ version: NEXT, projectRoot: work, dryRun: true, runner });
    expect(errorOf(result).code).toBe('E_RELEASE_NO_GREEN_COMMIT');
  });

  it('requires every required check: a red Contracts Dep Lint is not green', async () => {
    const { runner } = fakeRunner({
      [shas.head]: { CI: 'success', 'Contracts Dep Lint': 'failure' },
    });
    const result = await releaseCut({
      version: NEXT,
      projectRoot: work,
      dryRun: true,
      sha: shas.head,
      runner,
    });
    const error = errorOf(result);
    expect(error.code).toBe('E_RELEASE_NO_GREEN_COMMIT');
    expect(error.message).toContain('Contracts Dep Lint: failure');
  });

  it('refuses a --sha that is off main, not green, or not first-parent', async () => {
    git(work, 'switch', '--quiet', '-c', 'side');
    write(work, 'side.txt', 'side\n');
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'side');
    const side = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '--quiet', 'origin', 'side');
    const { runner } = fakeRunner({ [side]: 'success', [shas.head]: 'failure' });

    const offMain = await releaseCut({
      version: NEXT,
      projectRoot: work,
      dryRun: true,
      sha: side,
      runner,
    });
    expect(errorOf(offMain).message).toContain('not a first-parent commit');

    const notGreen = await releaseCut({
      version: NEXT,
      projectRoot: work,
      dryRun: true,
      sha: shas.head,
      runner,
    });
    expect(errorOf(notGreen).code).toBe('E_RELEASE_NO_GREEN_COMMIT');

    // Merged with --no-ff: on main, but only as a second parent.
    git(work, 'switch', '--quiet', 'main');
    git(work, 'merge', '--quiet', '--no-ff', '-m', 'merge side', 'side');
    git(work, 'push', '--quiet', 'origin', 'main');
    const secondParent = await releaseCut({
      version: NEXT,
      projectRoot: work,
      dryRun: true,
      sha: side,
      runner,
    });
    expect(errorOf(secondParent).message).toContain('not a first-parent commit');
  });

  it('refuses an existing tag, a non-CalVer version and one not above the newest release', async () => {
    const { runner } = fakeRunner({ [shas.head]: 'success' });
    const existing = await releaseCut({ version: PREV, projectRoot: work, dryRun: true, runner });
    expect(errorOf(existing).message).toContain('already exists');

    const notCalVer = await releaseCut({
      version: '1.2.3',
      projectRoot: work,
      dryRun: true,
      runner,
    });
    expect(errorOf(notCalVer).message).toMatch(/not CalVer|CalVer window/);

    const lower = await releaseCut({ version: `${YM}.0`, projectRoot: work, dryRun: true, runner });
    expect(errorOf(lower).message).toContain('not above the newest release tag');
  });

  it('refuses a real cut with docs rot, before creating the tag; a dry run reports it', async () => {
    rotOrphans = [{ doc: 'docs/x.md', reason: 'no inbound link' }];
    try {
      const { runner, calls } = fakeRunner({ [shas.head]: 'success' });
      const preview = await releaseCut({ version: NEXT, projectRoot: work, dryRun: true, runner });
      expect(preview.success && preview.data.docsRot.orphans.length).toBe(1);
      const real = await releaseCut({ version: NEXT, projectRoot: work, runner });
      expect(errorOf(real).code).toBe('E_DOCS_ROT');
      expect(calls.some((c) => c.includes('POST'))).toBe(false);
    } finally {
      rotOrphans = [];
    }
  });

  it('creates the annotated tag on the green sha for a real run, and audits it', async () => {
    const { runner, calls } = fakeRunner({ [shas.head]: 'success' });
    const result = await releaseCut({ version: `v${NEXT}`, projectRoot: work, runner });
    expect(result.success && result.data.tagCreated).toBe(true);
    const posts = calls.filter((c) => c.includes('POST'));
    expect(posts[0]).toContain(`object=${shas.head}`);
    expect(posts[1]).toContain(`ref=refs/tags/v${NEXT}`);
    expect(posts[1]).toContain('sha=tagobject');
    // CI is read for selection and again right before the tag.
    expect(calls.filter((c) => c.some((a) => a.includes('/runs?head_sha='))).length).toBe(2);
    const audit = readFileSync(join(work, RELEASE_CUT_AUDIT_FILE), 'utf-8').trim().split('\n');
    expect(JSON.parse(audit.at(-1) ?? '{}')).toMatchObject({ outcome: 'tagged', sha: shas.head });
  });

  it('reports a ref POST that fails after the tag object was created', async () => {
    const { runner } = fakeRunner({ [shas.head]: 'success' }, { failRef: true });
    const result = await releaseCut({ version: NEXT, projectRoot: work, runner });
    const error = errorOf(result);
    expect(error.code).toBe('E_RELEASE_TAG_FAILED');
    expect(error.message).toContain('Reference update failed');
    const audit = readFileSync(join(work, RELEASE_CUT_AUDIT_FILE), 'utf-8').trim().split('\n');
    expect(JSON.parse(audit.at(-1) ?? '{}')).toMatchObject({
      outcome: 'failed',
      tagObject: 'tagobject',
    });
  });
});

describe('releaseVerifyTag (T14102)', () => {
  it('accepts a tag on a green first-parent commit and refuses one off main or not green', async () => {
    git(work, 'tag', `v${NEXT}`, shas.head);
    const green = await releaseVerifyTag({
      version: NEXT,
      projectRoot: work,
      runner: fakeRunner({ [shas.head]: 'success' }).runner,
    });
    expect(green.success && green.data.sha).toBe(shas.head);

    const red = await releaseVerifyTag({
      version: NEXT,
      projectRoot: work,
      runner: fakeRunner({ [shas.head]: { CI: 'success', 'Contracts Dep Lint': 'failure' } })
        .runner,
    });
    expect(errorOf(red).code).toBe('E_RELEASE_NO_GREEN_COMMIT');

    git(work, 'switch', '--quiet', '-c', 'side');
    write(work, 'side.txt', 'side\n');
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'side');
    git(work, 'tag', `v${YM}.3`);
    const offMain = await releaseVerifyTag({
      version: `${YM}.3`,
      projectRoot: work,
      runner: fakeRunner({ [git(work, 'rev-parse', 'HEAD')]: 'success' }).runner,
    });
    expect(errorOf(offMain).message).toContain('not a first-parent commit');
  });
});

describe('releaseChangelog (T14102)', () => {
  it('writes the section from the changesets since the previous tag, led by the tag annotation, once', async () => {
    git(work, 'tag', '-a', `v${NEXT}`, '-m', '> **Update now.**', shas.head);
    const { runner } = fakeRunner({});
    const first = await releaseChangelog({ version: NEXT, projectRoot: work, runner });
    expect(first.success && first.data.written).toBe(true);
    const text = readFileSync(join(work, 'CHANGELOG.md'), 'utf-8');
    const section = text.slice(text.indexOf(`## [${NEXT}]`), text.indexOf(`## [${PREV}]`));
    expect(section).toContain('> **Update now.**');
    expect(section).toContain('the new fix');
    expect(section).not.toContain('shipped last time');
    const second = await releaseChangelog({ version: NEXT, projectRoot: work, runner });
    expect(second.success && second.data.written).toBe(false);
  });
});

describe('reconcileLatestRelease (T14102)', () => {
  it('reconciles the newest published tag once, and skips one already reconciled', async () => {
    const { runner } = fakeRunner({});
    releaseStatus = undefined;
    const first = await reconcileLatestRelease(work, runner);
    expect(first).toEqual({ version: `v${PREV}`, action: 'reconciled' });
    expect(reconciled).toEqual([`v${PREV}`]);
    releaseStatus = 'reconciled';
    const second = await reconcileLatestRelease(work, runner);
    expect(second.action).toBe('already');
    expect(reconciled).toEqual([`v${PREV}`]);
  });
});
