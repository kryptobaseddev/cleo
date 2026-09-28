/**
 * Briefing surfaces project identity problems (T12559).
 *
 * A missing or conflicting `.cleo/project-id` used to be visible only through
 * `cleo doctor project-identity`, so an agent orienting with `cleo briefing`
 * never learned that a clone would mint its own id.
 *
 * @task T12559
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPortableProjectId } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  getTaskAccessor: vi.fn(),
  createDataAccessor: vi.fn(),
}));

vi.mock('../handoff.js', () => ({
  getLastHandoff: vi.fn().mockResolvedValue(null),
}));

import { getTaskAccessor } from '../../store/data-accessor.js';
import { computeBriefing } from '../briefing.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

let sandbox: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' });
}

/** A CLEO root whose project-info and tracked id agree; optionally a committed git repo. */
function project(name: string, withGit: boolean): string {
  const root = join(sandbox, name);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  writeFileSync(
    join(root, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'same-id', name }),
  );
  writeFileSync(join(root, '.cleo', 'project-id'), formatPortableProjectId('same-id'));
  if (withGit) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.cleo/project-id');
    git(root, 'commit', '-q', '--no-verify', '-m', 'track id');
  }
  return root;
}

function identityWarnings(warnings: string[] | undefined): string[] {
  return (warnings ?? []).filter((warning) => warning.startsWith('Project identity'));
}

beforeEach(() => {
  vi.clearAllMocks();
  sandbox = mkdtempSync(join(tmpdir(), 'cleo-t12559-'));
  vi.stubEnv('CLEO_HOME', join(sandbox, 'cleo-home'));
  const accessor = {
    loadSessions: vi.fn().mockResolvedValue([]),
    getActiveSession: vi.fn().mockResolvedValue(null),
    resolveCurrentSession: vi.fn().mockResolvedValue(null),
    queryTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0 }),
    getMetaValue: vi.fn().mockResolvedValue(null),
    setMetaValue: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    engine: 'sqlite' as const,
  };
  (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(accessor);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('briefing project identity warning (T12559)', () => {
  it('stays silent while the identity is tracked and consistent', async () => {
    const root = project('ok', true);
    const briefing = await computeBriefing(root, { scope: 'global' });
    expect(identityWarnings(briefing.warnings)).toEqual([]);
  });

  it('warns with the remedy once .cleo/project-id has been removed', async () => {
    const root = project('removed', true);
    rmSync(join(root, '.cleo', 'project-id'));
    const briefing = await computeBriefing(root, { scope: 'global' });
    const [warning, ...rest] = identityWarnings(briefing.warnings);
    expect(rest).toEqual([]);
    expect(warning).toContain('Project identity missing');
    expect(warning).toContain('Remedy: cleo doctor project-identity --resolve');
    expect(warning).toContain('git add .cleo/project-id');
  });

  it('warns without git commands for a non-git CLEO root', async () => {
    const consistent = project('plain-ok', false);
    expect(
      identityWarnings((await computeBriefing(consistent, { scope: 'global' })).warnings),
    ).toEqual([]);

    const root = project('plain-removed', false);
    rmSync(join(root, '.cleo', 'project-id'));
    const [warning] = identityWarnings((await computeBriefing(root, { scope: 'global' })).warnings);
    expect(warning).toContain('Remedy: cleo doctor project-identity --resolve');
    expect(warning).not.toContain('git add');
  });
});
