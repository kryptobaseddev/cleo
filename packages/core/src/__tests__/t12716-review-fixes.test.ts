/**
 * Review findings on #1702 (T12716), one `describe` per finding.
 *
 * Each case was written red against the reviewed code, then made green by
 * its fix commit.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computePathFingerprintId,
  formatPortableProjectId,
  formatProjectManifest,
} from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectDisplayName, updateProjectName } from '../project-info.js';
import { renameProject } from '../project-lifecycle.js';
import { findRelinkCandidates } from '../scaffold/project-identity.js';

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

const ID = 'aaaaaaaaaaaa';

/** A git repo whose `.cleo/` holds the requested identity sources. */
function fixture(
  name: string,
  ids: { manifest?: string; legacy?: string; info?: string; infoName?: string },
): string {
  const root = join(sandbox, name);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  if (ids.manifest)
    writeFileSync(
      join(root, '.cleo', 'project.json'),
      formatProjectManifest({ schemaVersion: 1, id: ids.manifest, name: `${name}-declared` }),
    );
  if (ids.legacy)
    writeFileSync(join(root, '.cleo', 'project-id'), formatPortableProjectId(ids.legacy));
  if (ids.info)
    writeFileSync(
      join(root, '.cleo', 'project-info.json'),
      JSON.stringify({
        projectId: ids.info,
        name: ids.infoName ?? `${name}-cached`,
        projectHash: 'a1b2c3d4e5f6',
      }),
    );
  return root;
}

async function registryDb() {
  const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
  const schema = await import('../store/schema/nexus-schema.js');
  return { db: await getNexusRegistryDb(home), ...schema };
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cleo-t12716-review-'));
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

describe('finding 3: a legacy rename never changes the path-fingerprint alias key', () => {
  it('cleo project rename and upgrade --name keep the fingerprint, and the alias still re-links', async () => {
    const root = fixture('legacy-rename', { legacy: ID, info: ID, infoName: 'original' });
    const fingerprint = computePathFingerprintId(root);
    const { db, projectIdAliases } = await registryDb();
    db.insert(projectIdAliases)
      .values({ legacyId: fingerprint, canonicalId: ID, createdAt: new Date().toISOString() })
      .run();

    const renamed = await renameProject('renamed-via-project', root);
    expect(renamed.success).toBe(true);
    expect(computePathFingerprintId(root)).toBe(fingerprint);
    expect(getProjectDisplayName(root)).toBe('renamed-via-project');

    updateProjectName(root, 'renamed-via-upgrade');
    expect(computePathFingerprintId(root)).toBe(fingerprint);
    expect(getProjectDisplayName(root)).toBe('renamed-via-upgrade');

    const info = JSON.parse(readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8')) as {
      name: string;
    };
    expect(info.name).toBe('original');

    const { candidates } = await findRelinkCandidates(root, home);
    expect(candidates).toContainEqual(
      expect.objectContaining({ projectId: ID, via: 'registry-alias' }),
    );

    // The migration carries the renamed display name into project.json.
    const { resolveProjectIdentity } = await import('../doctor/project-identity.js');
    const plan = await resolveProjectIdentity(root, { dryRun: true, cleoHome: home });
    expect(plan.steps[0]?.detail).toContain('name: "renamed-via-upgrade"');
  });
});

describe('finding 1 + hash rules 2-3: projectHash never changes and is id-derived only for --new-identity', () => {
  it('an existing project that loses project-info.json keeps its path-derived hash', async () => {
    const { computePortableProjectHash, computeStableProjectHash } = await import(
      '../project-scope.js'
    );
    const { ensureProjectInfo } = await import('../scaffold/ensure-config.js');
    const { regenerateProjectInfoJson } = await import('../store/regenerators.js');
    const { getProjectHashKey } = await import('../project-info.js');
    const root = fixture('lost-info', { manifest: ID, legacy: ID });
    const stable = computeStableProjectHash(root);

    // No readable stored hash: every derivation agrees on the pre-T12716 value.
    expect(getProjectHashKey(root)).toBe(stable);
    expect(regenerateProjectInfoJson(root).content['projectHash']).toBe(stable);
    await ensureProjectInfo(root);
    const info = JSON.parse(readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8')) as {
      projectHash: string;
    };
    expect(info.projectHash).toBe(stable);
    expect(info.projectHash).not.toBe(computePortableProjectHash(ID));
    await ensureProjectInfo(root, { force: true });
    expect(getProjectHashKey(root)).toBe(stable);
  });

  it('rule 2: a freshly initialised project keeps its hash after losing project-info.json', async () => {
    // Option A (ADR-096, AC8): a fresh init records the path-derived hash, the
    // one value every reader can re-derive from disk.
    const { computeStableProjectHash } = await import('../project-scope.js');
    const { ensureProjectInfo } = await import('../scaffold/ensure-config.js');
    const { regenerateProjectInfoJson } = await import('../store/regenerators.js');
    const { getProjectHashKey } = await import('../project-info.js');
    const root = fixture('minted-then-lost', {});
    const created = await ensureProjectInfo(root);
    expect(created.details).toContain('(minted)');
    const infoPath = join(root, '.cleo', 'project-info.json');
    const original = (JSON.parse(readFileSync(infoPath, 'utf-8')) as { projectHash: string })
      .projectHash;
    expect(original).toBe(computeStableProjectHash(root));

    rmSync(infoPath);
    expect(getProjectHashKey(root)).toBe(original);
    expect(regenerateProjectInfoJson(root).content['projectHash']).toBe(original);
    await ensureProjectInfo(root);
    expect(getProjectHashKey(root)).toBe(original);
    rmSync(infoPath);
    await ensureProjectInfo(root, { force: true });
    expect(getProjectHashKey(root)).toBe(original);
  });

  it('rule 3: only an explicit --new-identity mint gets the id-derived hash (T12558)', async () => {
    const { computePortableProjectHash } = await import('../project-scope.js');
    const { ensureProjectInfo } = await import('../scaffold/ensure-config.js');
    const root = fixture('new-identity', {});
    const result = await ensureProjectInfo(root, { mintNewIdentity: true });
    expect(result.details).toContain('(minted)');
    const info = JSON.parse(readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8')) as {
      projectId: string;
      projectHash: string;
    };
    expect(info.projectHash).toBe(computePortableProjectHash(info.projectId));
  });

  it('rule 3: a prior identity found only in the registry (same path) gets the path hash', async () => {
    const { computeStableProjectHash } = await import('../project-scope.js');
    const { ensureProjectInfo } = await import('../scaffold/ensure-config.js');
    const { registerProjectOnEncounter } = await import('../paths.js');
    const root = fixture('registry-only', { manifest: ID, legacy: ID, info: ID });
    await registerProjectOnEncounter(root, ID);
    for (const file of ['project.json', 'project-id', 'project-info.json'])
      rmSync(join(root, '.cleo', file));

    const result = await ensureProjectInfo(root);
    expect(result.details).toContain('(registry-path)');
    const info = JSON.parse(readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8')) as {
      projectId: string;
      projectHash: string;
    };
    expect(info.projectId).toBe(ID);
    expect(info.projectHash).toBe(computeStableProjectHash(root));
  });

  it('rule 3: a prior identity found only through an alias gets the path hash', async () => {
    const { computeStableProjectHash } = await import('../project-scope.js');
    const { ensureProjectInfo } = await import('../scaffold/ensure-config.js');
    const root = fixture('alias-only', {});
    const { db, projectIdAliases } = await registryDb();
    db.insert(projectIdAliases)
      .values({
        legacyId: computePathFingerprintId(root),
        canonicalId: ID,
        createdAt: new Date().toISOString(),
      })
      .run();

    const result = await ensureProjectInfo(root);
    expect(result.details).toContain('(registry-alias)');
    const info = JSON.parse(readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8')) as {
      projectId: string;
      projectHash: string;
    };
    expect(info.projectId).toBe(ID);
    expect(info.projectHash).toBe(computeStableProjectHash(root));
  });
});

describe('finding 2: a conflict with label drift plans exactly what it applies', () => {
  it('dry-run and apply both re-key and then sync the label', async () => {
    const { resolveProjectIdentity } = await import('../doctor/project-identity.js');
    const { registerProjectOnEncounter } = await import('../paths.js');
    const OLD = 'dddddddddddd';
    // The label differs from both the declared and the cached name.
    const root = fixture('drift-conflict', { manifest: ID, legacy: ID, info: OLD });
    await registerProjectOnEncounter(root, OLD);
    const { db, projectRegistry } = await registryDb();
    db.update(projectRegistry).set({ name: 'third-label' }).run();

    const plan = await resolveProjectIdentity(root, { dryRun: true, cleoHome: home });
    const applied = await resolveProjectIdentity(root, { cleoHome: home });
    expect(plan.steps.map((s) => s.action)).toContain('sync-registry-name');
    expect(applied.steps.map((s) => s.action)).toEqual(plan.steps.map((s) => s.action));
    expect(db.select().from(projectRegistry).all()).toEqual([
      expect.objectContaining({ projectId: ID, name: 'drift-conflict-declared' }),
    ]);
  });
});

describe('finding 5: both ids registered (the real encounter order) resolves without losing a row', () => {
  it('folds the cached-id row into the tracked row through the alias, with a receipt', async () => {
    const { resolveProjectIdentity, inspectProjectIdentity } = await import(
      '../doctor/project-identity.js'
    );
    const { registerProjectOnEncounter } = await import('../paths.js');
    const OLD = 'dddddddddddd';
    const root = fixture('both-rows', { manifest: ID, legacy: ID, info: OLD });
    // Registered under the cached id before the tracked file arrived, then a
    // later encounter registered the tracked id — what paths.ts does.
    await registerProjectOnEncounter(root, OLD);
    await registerProjectOnEncounter(root, ID);
    const { db, projectRegistry, projectIdAliases, nexusAuditLog, projectLocations } =
      await registryDb();
    const rowsBefore = db.select().from(projectRegistry).all();
    expect(rowsBefore.map((r) => r.projectId).sort()).toEqual([ID, OLD].sort());
    const oldRow = rowsBefore.find((r) => r.projectId === OLD);

    const plan = await resolveProjectIdentity(root, { dryRun: true, cleoHome: home });
    expect(plan.refused).toBeNull();
    expect(plan.steps.map((s) => s.action)).toContain('merge-registry-row');
    expect(db.select().from(projectRegistry).all()).toEqual(rowsBefore);

    const applied = await resolveProjectIdentity(root, { cleoHome: home });
    expect(applied.refused).toBeNull();
    expect(applied.steps.map((s) => s.action)).toEqual(plan.steps.map((s) => s.action));

    // The tracked row is live; the cached id resolves to it through the alias.
    expect(
      db
        .select()
        .from(projectRegistry)
        .all()
        .map((r) => r.projectId),
    ).toEqual([ID]);
    expect(db.select().from(projectIdAliases).all()).toContainEqual(
      expect.objectContaining({ legacyId: OLD, canonicalId: ID }),
    );
    // Nothing is lost: the folded row is kept whole in the audit receipt, and
    // its locations now belong to the tracked id.
    const receipt = db
      .select()
      .from(nexusAuditLog)
      .all()
      .find((r) => r.action === 'merge-identity');
    expect(JSON.parse(receipt?.detailsJson ?? '{}')).toMatchObject({
      foldedRow: { projectId: OLD, projectPath: oldRow?.projectPath },
      into: ID,
    });
    expect(
      db
        .select()
        .from(projectLocations)
        .all()
        .filter((l) => l.projectId === OLD),
    ).toEqual([]);
    expect(inspectProjectIdentity(root).state).not.toBe('conflict');
  });
});

describe('finding 4: credentials follow every id the project was keyed by', () => {
  it('previous ids include the alias table, not only project-info receipts', async () => {
    const { readProjectCredentialIdentity } = await import('../store/credential-transfer.js');
    const OLD = 'dddddddddddd';
    const root = fixture('alias-keys', { manifest: ID, legacy: ID, info: ID });
    const { db, projectIdAliases } = await registryDb();
    db.insert(projectIdAliases)
      .values({ legacyId: OLD, canonicalId: ID, createdAt: new Date().toISOString() })
      .run();
    expect(await readProjectCredentialIdentity(root, home)).toEqual({
      projectId: ID,
      previousProjectIds: [OLD],
    });
  });

  it('--resolve re-wraps credentials sealed under the old id, with a receipt step', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { encryptProjectSecret, decryptProjectSecret } = await import('../crypto/credentials.js');
    const { resolveProjectIdentity } = await import('../doctor/project-identity.js');
    const { registerProjectOnEncounter } = await import('../paths.js');
    const OLD = 'dddddddddddd';
    const root = fixture('rewrap', { manifest: ID, legacy: ID, info: OLD });
    await registerProjectOnEncounter(root, OLD);
    const dbPath = join(root, '.cleo', 'cleo.db');
    const sealed = await encryptProjectSecret('sk-live', OLD, { cleoHome: home });
    const raw = new DatabaseSync(dbPath);
    raw.exec(
      `CREATE TABLE tasks_agent_credentials (agent_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
       api_key_encrypted TEXT NOT NULL, api_base_url TEXT NOT NULL DEFAULT '')`,
    );
    raw
      .prepare(
        'INSERT INTO tasks_agent_credentials (agent_id, display_name, api_key_encrypted) VALUES (?, ?, ?)',
      )
      .run('agent-a', 'Agent A', sealed);
    raw.close();
    const cell = (): string => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db
        .prepare('SELECT api_key_encrypted AS c FROM tasks_agent_credentials')
        .get() as {
        c: string;
      };
      db.close();
      return row.c;
    };

    const plan = await resolveProjectIdentity(root, { dryRun: true, cleoHome: home });
    expect(plan.steps.find((s) => s.action === 'rewrap-credentials')?.detail).toContain('agent-a');
    expect(cell()).toBe(sealed);

    await resolveProjectIdentity(root, { cleoHome: home });
    const opened = await decryptProjectSecret(cell(), { projectId: ID, cleoHome: home });
    expect(opened).toMatchObject({ plaintext: 'sk-live', rewrapped: null });
  });
});

describe('finding 8: a tracked-only .cleo in a linked worktree is not a root, in either check', () => {
  it('resolveProjectByCwd agrees with validateProjectRoot on a gitlink .git file', async () => {
    const { resolveProjectByCwd } = await import('@cleocode/paths');
    const { validateProjectRoot } = await import('../project-scope.js');
    const wt = join(sandbox, 'linked-wt');
    mkdirSync(join(wt, '.cleo'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere/.git/worktrees/linked-wt\n');
    writeFileSync(
      join(wt, '.cleo', 'project.json'),
      formatProjectManifest({ schemaVersion: 1, id: ID, name: 'wt' }),
    );
    expect(validateProjectRoot(wt)).toBe(false);
    expect(resolveProjectByCwd(wt)?.projectRoot).not.toBe(wt);

    // At a real toplevel both accept it.
    const top = fixture('toplevel', { manifest: ID });
    expect(validateProjectRoot(top)).toBe(true);
    expect(resolveProjectByCwd(top)?.projectId).toBe(ID);
  });
});

describe('finding 9: renaming project.json keeps unknown keys and never shares a tmp file', () => {
  it('preserves extra keys and survives a stale pid-named tmp path', async () => {
    const { renameProjectManifest } = await import('../scaffold/project-identity.js');
    const root = fixture('extras', { legacy: ID });
    const path = join(root, '.cleo', 'project.json');
    writeFileSync(
      path,
      `${JSON.stringify({ schemaVersion: 1, id: ID, name: 'before', future: { keep: true } }, null, 2)}\n`,
    );
    // A concurrent writer's leftover at the old shared tmp name.
    mkdirSync(`${path}.tmp-${process.pid}`);

    await renameProjectManifest(root, 'after-async');
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
      schemaVersion: 1,
      id: ID,
      name: 'after-async',
      future: { keep: true },
    });
    updateProjectName(root, 'after-sync');
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
      schemaVersion: 1,
      id: ID,
      name: 'after-sync',
      future: { keep: true },
    });
  });
});
