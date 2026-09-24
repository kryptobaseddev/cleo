/**
 * Identity doctor + conflict resolution (T12353 · ADR-094).
 *
 * The central case: two devices each ran `cleo init` before `.cleo/project-id`
 * existed, one committed its id, and the other pulled it. Local state is keyed
 * by the local id. `--resolve` must re-key it to the tracked id through the
 * alias table: same registry row count, same path, old id still resolvable.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPortableProjectId, readPortableProjectId } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectProjectIdentity, resolveProjectIdentity } from '../doctor/project-identity.js';
import { registerProjectOnEncounter } from '../paths.js';
import { ensureGitignore } from '../scaffold/ensure-config.js';
import { checkProjectIdentity } from '../validation/doctor/checks.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

let sandbox: string;
let home: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' });
}

/** A git repo with `.cleo/project-info.json` (and optionally a tracked id). */
function project(name: string, localId: string | null, trackedId?: string): string {
  const root = join(sandbox, name);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  if (localId !== null)
    writeFileSync(
      join(root, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: localId, name }),
    );
  if (trackedId)
    writeFileSync(join(root, '.cleo', 'project-id'), formatPortableProjectId(trackedId));
  return root;
}

async function registry(): Promise<{
  rows: { projectId: string; projectPath: string }[];
  aliases: { legacyId: string; canonicalId: string }[];
}> {
  const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
  const { projectIdAliases, projectRegistry } = await import('../store/schema/nexus-schema.js');
  const db = await getNexusRegistryDb(home);
  return {
    rows: db
      .select({ projectId: projectRegistry.projectId, projectPath: projectRegistry.projectPath })
      .from(projectRegistry)
      .all(),
    aliases: db
      .select({ legacyId: projectIdAliases.legacyId, canonicalId: projectIdAliases.canonicalId })
      .from(projectIdAliases)
      .all(),
  };
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cleo-t12353-'));
  home = join(sandbox, 'cleo-home');
  mkdirSync(home);
  vi.stubEnv('CLEO_HOME', home);
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('AC1: doctor reports each state with the exact remedy', () => {
  it('missing -> warning, remedy runs --resolve and commits the file', () => {
    const root = project('missing', 'local-a');
    const check = checkProjectIdentity(root);
    expect(check).toMatchObject({ id: 'project_identity', status: 'warning' });
    expect(check.fix).toContain('cleo doctor project-identity --resolve');
    expect(check.fix).toContain('git add .cleo/project-id');
  });

  it('conflict -> failed, remedy is dry-run first then resolve', () => {
    const root = project('conflict', 'local-a', 'tracked-b');
    const check = checkProjectIdentity(root);
    expect(check.status).toBe('failed');
    expect(check.details).toMatchObject({
      state: 'conflict',
      trackedId: 'tracked-b',
      localId: 'local-a',
    });
    expect(check.fix).toMatch(
      /^cleo doctor project-identity --resolve --dry-run\s+then\s+cleo doctor project-identity --resolve/,
    );
  });

  it('invalid -> failed, remedy restores from git and never regenerates', () => {
    const root = project('invalid', 'local-a');
    writeFileSync(join(root, '.cleo', 'project-id'), 'one\ntwo\n');
    const check = checkProjectIdentity(root);
    expect(check.status).toBe('failed');
    expect(check.fix).toContain('git checkout -- .cleo/project-id');
  });

  it('agreeing but uncommitted -> untracked; ignored by an old .cleo/.gitignore -> ignored', async () => {
    const root = project('untracked', 'same-id', 'same-id');
    expect(inspectProjectIdentity(root).state).toBe('untracked');
    writeFileSync(join(root, '.cleo', '.gitignore'), '*\n!.gitignore\n');
    expect(inspectProjectIdentity(root)).toMatchObject({ state: 'ignored' });
    expect(inspectProjectIdentity(root).remedy).toContain('cleo upgrade');

    await ensureGitignore(root);
    git(root, 'add', '.cleo');
    git(root, 'commit', '-q', '--no-verify', '-m', 'track id');
    expect(checkProjectIdentity(root)).toMatchObject({ status: 'passed', fix: null });
  });
});

describe('AC2: --resolve re-keys a conflict to the tracked id without losing rows', () => {
  it('dry-run plans and writes nothing; apply re-keys row, aliases and project-info', async () => {
    const root = project('rekey', 'local-a', 'tracked-b');
    await registerProjectOnEncounter(root, 'local-a');
    const other = project('bystander', 'other-c');
    await registerProjectOnEncounter(other, 'other-c');
    const before = await registry();
    const localAliases = before.aliases.filter((a) => a.canonicalId === 'local-a');
    expect(localAliases.length).toBeGreaterThan(0);

    const plan = await resolveProjectIdentity(root, { dryRun: true });
    expect(plan.refused).toBeNull();
    expect(plan.steps.map((s) => s.action)).toEqual([
      'rekey-registry-row',
      'repoint-aliases',
      'alias-old-id',
      'rewrite-project-info',
    ]);
    expect(await registry()).toEqual(before);
    expect(inspectProjectIdentity(root).state).toBe('conflict');

    const applied = await resolveProjectIdentity(root);
    expect(applied.refused).toBeNull();
    expect(applied.registryRows).toEqual({ before: 2, after: 2 });

    const after = await registry();
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.rows).toContainEqual({ projectId: 'tracked-b', projectPath: root });
    expect(after.rows).toContainEqual({ projectId: 'other-c', projectPath: other });
    expect(after.aliases.filter((a) => a.canonicalId === 'local-a')).toEqual([]);
    for (const alias of localAliases)
      expect(after.aliases).toContainEqual({ legacyId: alias.legacyId, canonicalId: 'tracked-b' });
    expect(after.aliases).toContainEqual({ legacyId: 'local-a', canonicalId: 'tracked-b' });

    // The old id keeps resolving, through the alias, to the same row. (Read the
    // registry directly: resolveProjectById opens the cwd project's store.)
    const oldAlias = after.aliases.find((a) => a.legacyId === 'local-a');
    expect(after.rows.find((r) => r.projectId === oldAlias?.canonicalId)?.projectPath).toBe(root);

    const info = JSON.parse(readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8')) as {
      projectId: string;
      previousProjectIds: string[];
      name: string;
    };
    expect(info).toMatchObject({
      projectId: 'tracked-b',
      previousProjectIds: ['local-a'],
      name: 'rekey',
    });
    expect(readPortableProjectId(root)).toEqual({ status: 'valid', projectId: 'tracked-b' });
    expect(inspectProjectIdentity(root).state).toBe('untracked');

    // A later encounter under the new id succeeds and does not add a row.
    await registerProjectOnEncounter(root, 'tracked-b');
    expect((await registry()).rows).toHaveLength(2);
  });

  it('refuses when both ids already own registry rows, and changes nothing', async () => {
    const root = project('split', 'local-a', 'tracked-b');
    await registerProjectOnEncounter(root, 'local-a');
    const elsewhere = project('elsewhere', 'tracked-b');
    await registerProjectOnEncounter(elsewhere, 'tracked-b');
    const before = await registry();

    const result = await resolveProjectIdentity(root);
    expect(result.refused).toContain('cleo nexus unregister tracked-b');
    expect(result.steps).toEqual([]);
    expect(await registry()).toEqual(before);
    expect(inspectProjectIdentity(root).state).toBe('conflict');
  });

  it('missing -> --resolve writes the tracked file from the local id', async () => {
    const root = project('adopt', 'local-a');
    const result = await resolveProjectIdentity(root);
    expect(result.steps.map((s) => s.action)).toEqual(['write-tracked-id']);
    expect(readPortableProjectId(root)).toEqual({ status: 'valid', projectId: 'local-a' });
  });

  it('invalid -> --resolve refuses and leaves the file untouched', async () => {
    const root = project('bad', 'local-a');
    writeFileSync(join(root, '.cleo', 'project-id'), 'x y\n');
    const result = await resolveProjectIdentity(root);
    expect(result.refused).toContain('git checkout -- .cleo/project-id');
    expect(readFileSync(join(root, '.cleo', 'project-id'), 'utf-8')).toBe('x y\n');
    expect(existsSync(join(root, '.cleo', 'project-info.json'))).toBe(true);
  });
});
