/**
 * Identity doctor + conflict resolution (T12353 · ADR-094 · T12716).
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
import { fileURLToPath } from 'node:url';
import {
  formatPortableProjectId,
  formatProjectManifest,
  readPortableProjectId,
} from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectProjectIdentity, resolveProjectIdentity } from '../doctor/project-identity.js';
import { checkSchema } from '../json-schema-validator.js';
import { registerProjectOnEncounter } from '../paths.js';
import { ensureGitignore, ensureProjectInfo } from '../scaffold/ensure-config.js';
import { checkProjectIdentity } from '../validation/doctor/checks.js';

/** The shipped `project-info.json` schema, as `checkSchemaIntegrity` loads it. */
function projectInfoSchema(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../schemas/project-info.schema.json', import.meta.url)),
      'utf-8',
    ),
  ) as Record<string, unknown>;
}

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

/**
 * A git repo with `.cleo/project-info.json` (and optionally a tracked id: the
 * legacy `.cleo/project-id`, plus `.cleo/project.json` when `manifest`).
 */
function project(
  name: string,
  localId: string | null,
  trackedId?: string,
  manifest = false,
): string {
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
  if (trackedId && manifest)
    writeFileSync(
      join(root, '.cleo', 'project.json'),
      formatProjectManifest({ schemaVersion: 1, id: trackedId, name }),
    );
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
    expect(check.fix).toContain('git add .cleo/project.json .cleo/project-id');
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
    const root = project('untracked', 'same-id', 'same-id', true);
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
      // T12716: only the legacy file was tracked, so project.json is written too.
      'write-project-json',
    ]);
    expect(existsSync(join(root, '.cleo', 'project.json'))).toBe(false);
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
    expect(readPortableProjectId(root)).toEqual({
      status: 'valid',
      projectId: 'tracked-b',
      file: 'project.json',
      name: 'rekey',
    });
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

  it('missing -> --resolve writes the tracked files from the local id', async () => {
    const root = project('adopt', 'local-a');
    const result = await resolveProjectIdentity(root);
    expect(result.steps.map((s) => s.action)).toEqual(['write-tracked-id']);
    expect(readPortableProjectId(root)).toEqual({
      status: 'valid',
      projectId: 'local-a',
      file: 'project.json',
      name: 'adopt',
    });
    expect(existsSync(join(root, '.cleo', 'project-id'))).toBe(true);
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

describe('T12557: persisted projectRoot is stripped by --resolve; projectHash is never touched', () => {
  it('reports a legacy /mnt projectRoot; dry-run plans, apply strips with a receipt, hash byte-identical', async () => {
    const root = project('legacy', 'same-id', 'same-id', true);
    await ensureGitignore(root);
    const infoPath = join(root, '.cleo', 'project-info.json');
    const contextPath = join(root, '.cleo', 'project-context.json');
    writeFileSync(
      contextPath,
      JSON.stringify({ schemaVersion: '1.0.0', projectRoot: '/mnt/projects/legacy' }),
    );
    git(root, 'add', '.cleo');
    git(root, 'add', '-f', '.cleo/project-context.json');
    git(root, 'commit', '-q', '--no-verify', '-m', 'track id');
    writeFileSync(
      infoPath,
      JSON.stringify({
        projectId: 'same-id',
        name: 'legacy',
        projectRoot: '/mnt/projects/legacy',
        projectHash: 'a1b2c3d4e5f6',
      }),
    );
    const hashBytes = (): string =>
      /"projectHash":\s*("[^"]*")/.exec(readFileSync(infoPath, 'utf-8'))?.[1] ?? '';
    expect(hashBytes()).toBe('"a1b2c3d4e5f6"');

    const report = inspectProjectIdentity(root);
    expect(report.state).toBe('ok');
    expect(report.derivedFields).toEqual([
      { file: 'project-info.json', field: 'projectRoot', value: '/mnt/projects/legacy' },
      { file: 'project-context.json', field: 'projectRoot', value: '/mnt/projects/legacy' },
    ]);

    const infoBefore = readFileSync(infoPath, 'utf-8');
    const plan = await resolveProjectIdentity(root, { dryRun: true });
    expect(plan.refused).toBeNull();
    expect(plan.steps.map((s) => s.action)).toEqual(['strip-derived-fields']);
    expect(plan.steps[0]?.detail).toContain('project-info.json:projectRoot="/mnt/projects/legacy"');
    expect(plan.steps[0]?.detail).toContain('project-context.json is git-tracked');
    expect(plan.steps[0]?.detail).not.toContain('projectHash');
    expect(readFileSync(infoPath, 'utf-8')).toBe(infoBefore);

    const applied = await resolveProjectIdentity(root);
    expect(applied.refused).toBeNull();
    expect(applied.steps.map((s) => s.action)).toEqual(['strip-derived-fields']);
    const info = JSON.parse(readFileSync(infoPath, 'utf-8')) as Record<string, unknown>;
    expect(info).not.toHaveProperty('projectRoot');
    expect(hashBytes()).toBe('"a1b2c3d4e5f6"');
    expect(info).toMatchObject({ projectId: 'same-id', name: 'legacy' });
    expect(info['strippedFields']).toEqual([
      expect.objectContaining({
        file: 'project-info.json',
        field: 'projectRoot',
        value: '/mnt/projects/legacy',
      }),
      expect.objectContaining({
        file: 'project-context.json',
        field: 'projectRoot',
        value: '/mnt/projects/legacy',
      }),
    ]);
    expect(JSON.parse(readFileSync(contextPath, 'utf-8'))).toEqual({ schemaVersion: '1.0.0' });
    expect(inspectProjectIdentity(root)).toMatchObject({ state: 'ok', derivedFields: [] });
    expect((await resolveProjectIdentity(root)).refused).toBe('Nothing to resolve.');
    expect(hashBytes()).toBe('"a1b2c3d4e5f6"');
  });

  it('receipts survive the force-regenerate `cleo upgrade` runs, and the file stays schema-valid', async () => {
    const root = project('upgrade', null, 'same-id');
    await ensureGitignore(root);
    git(root, 'add', '.cleo');
    git(root, 'commit', '-q', '--no-verify', '-m', 'track id');
    await ensureProjectInfo(root);
    const infoPath = join(root, '.cleo', 'project-info.json');
    const read = (): Record<string, unknown> =>
      JSON.parse(readFileSync(infoPath, 'utf-8')) as Record<string, unknown>;
    const hash = read()['projectHash'];
    expect(typeof hash).toBe('string');
    writeFileSync(
      infoPath,
      JSON.stringify({
        ...read(),
        projectRoot: '/mnt/projects/upgrade',
        previousProjectIds: ['old-id'],
      }),
    );

    expect((await resolveProjectIdentity(root)).refused).toBeNull();
    expect(checkSchema(read(), projectInfoSchema())).toEqual([]);

    // upgrade.ts, system/health.ts and resolve's info-invalid branch all call this.
    await ensureProjectInfo(root, { force: true });
    const after = read();
    expect(after['previousProjectIds']).toEqual(['old-id']);
    expect(after['strippedFields']).toEqual([
      expect.objectContaining({ field: 'projectRoot', value: '/mnt/projects/upgrade' }),
    ]);
    expect(after['projectHash']).toBe(hash);
    expect(after).not.toHaveProperty('projectRoot');
    expect(checkSchema(after, projectInfoSchema())).toEqual([]);
  });

  it('a non-git CLEO root gets a remedy with no git commands', () => {
    const root = join(sandbox, 'plain');
    mkdirSync(join(root, '.cleo'), { recursive: true });
    writeFileSync(
      join(root, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'local-a', name: 'plain' }),
    );
    const report = inspectProjectIdentity(root);
    expect(report.state).toBe('missing');
    expect(report.remedy).toContain('cleo doctor project-identity --resolve');
    expect(report.remedy).not.toContain('git add');
  });
});
