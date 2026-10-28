/**
 * `cleo release cut` / `release write-changelog` (T14102): the newest green
 * commit is picked, the notes come from the changesets since the previous tag,
 * task status is reported (not gated), and the tag is created only for real.
 *
 * @task T14102
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store/data-accessor.js', () => ({
  getTaskAccessor: async () => ({
    loadSingleTask: async (id: string) => (id === 'T1' ? { id, status: 'done' } : null),
    close: async () => {},
  }),
}));

import { type ReleaseCutRunner, releaseChangelog, releaseCut } from '../cut.js';

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

  write(work, '.github/workflows/release.yml', 'run: |\n  publish_pkg core\n');
  write(work, 'packages/core/package.json', '{"name":"@cleocode/core","version":"0.0.0"}\n');
  write(work, '.changeset/old-fix.md', changeset('old-fix', 'T0', 'shipped last time'));
  write(work, 'CHANGELOG.md', '# Changelog\n\n## [2026.10.1] (2026-10-01)\n\n- old\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'one');
  git(work, 'tag', 'v2026.10.1');
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

function fakeRunner(
  ci: Record<string, string>,
  merged = true,
): { runner: ReleaseCutRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ReleaseCutRunner = {
    runGit: (args, cwd) => git(cwd, ...args),
    runGh: (args) => {
      calls.push([...args]);
      const path = args.find((a) => a.startsWith('repos/')) ?? '';
      const checks = /commits\/(\w+)\/check-runs/.exec(path);
      if (checks) {
        const state = ci[checks[1] ?? ''] ?? 'none';
        if (state === 'none') return '{"check_runs":[]}';
        const done = state === 'success' || state === 'failure';
        return JSON.stringify({
          check_runs: [
            { id: 1, status: done ? 'completed' : state, conclusion: done ? state : null },
          ],
        });
      }
      if (path.endsWith('/pulls')) return merged ? '[{"merged_at":"2026-10-28T00:00:00Z"}]' : '[]';
      if (path.endsWith('git/tags')) return '{"sha":"tagobject"}';
      return '{}';
    },
  };
  return { runner, calls };
}

describe('releaseCut (T14102)', () => {
  it('dry run picks the newest green commit and reports notes, packages, migrations and tasks', async () => {
    const { runner, calls } = fakeRunner({ [shas.head]: 'in_progress', [shas.fix]: 'success' });
    const lead = join(work, 'lead.md');
    writeFileSync(lead, '> **Update now.**\n');
    const result = await releaseCut({
      version: '2026.10.2',
      projectRoot: work,
      dryRun: true,
      leadFile: lead,
      runner,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data;
    expect(data.sha).toBe(shas.fix);
    expect(data.candidates.map((c) => c.ci)).toEqual(['in_progress', 'success']);
    expect(data.previousTag).toBe('v2026.10.1');
    expect(data.changesets).toEqual(['.changeset/new-fix.md']);
    expect(data.notes.startsWith('> **Update now.**')).toBe(true);
    expect(data.notes).toContain('the new fix');
    expect(data.notes).not.toContain('shipped last time');
    expect(data.packages).toEqual([{ dir: 'core', name: '@cleocode/core', version: '2026.10.2' }]);
    expect(data.migrations).toEqual(['packages/core/migrations/drizzle-tasks/m1/migration.sql']);
    expect(data.tasks).toEqual([{ id: 'T1', status: 'done' }]);
    expect(data.tagCreated).toBe(false);
    expect(calls.some((c) => c.includes('POST'))).toBe(false);
  });

  it('refuses when no recent commit has green CI', async () => {
    const { runner } = fakeRunner({ [shas.head]: 'failure' });
    const result = await releaseCut({
      version: '2026.10.2',
      projectRoot: work,
      dryRun: true,
      runner,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_RELEASE_NO_GREEN_COMMIT');
  });

  it('refuses a changeset no merged pull request brought in', async () => {
    const { runner } = fakeRunner({ [shas.head]: 'success' }, false);
    const result = await releaseCut({
      version: '2026.10.2',
      projectRoot: work,
      dryRun: true,
      runner,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_RELEASE_UNMERGED_CHANGESET');
  });

  it('creates the annotated tag on the green sha for a real run', async () => {
    const { runner, calls } = fakeRunner({ [shas.head]: 'success' });
    const result = await releaseCut({ version: 'v2026.10.2', projectRoot: work, runner });
    expect(result.success && result.data.tagCreated).toBe(true);
    const posts = calls.filter((c) => c.includes('POST'));
    expect(posts[0]).toContain(`object=${shas.head}`);
    expect(posts[1]).toContain('ref=refs/tags/v2026.10.2');
    expect(posts[1]).toContain('sha=tagobject');
  });
});

describe('releaseChangelog (T14102)', () => {
  it('writes the section from the changesets since the previous tag, led by the tag annotation, once', async () => {
    git(work, 'tag', '-a', 'v2026.10.2', '-m', '> **Update now.**', shas.head);
    const { runner } = fakeRunner({});
    const first = await releaseChangelog({ version: '2026.10.2', projectRoot: work, runner });
    expect(first.success && first.data.written).toBe(true);
    const text = readFileSync(join(work, 'CHANGELOG.md'), 'utf-8');
    const section = text.slice(text.indexOf('## [2026.10.2]'), text.indexOf('## [2026.10.1]'));
    expect(section).toContain('> **Update now.**');
    expect(section).toContain('the new fix');
    expect(section).not.toContain('shipped last time');
    const second = await releaseChangelog({ version: '2026.10.2', projectRoot: work, runner });
    expect(second.success && second.data.written).toBe(false);
  });
});
