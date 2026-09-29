/**
 * `.cleo/project.json` identity consolidation (T12716).
 *
 * The contract under test:
 * - ONE resolver: `.cleo/project.json`, then the legacy `.cleo/project-id`,
 *   then the `project-info.json` cache. The tracked id always wins — in
 *   `readPortableProjectId`, `readDeclaredProjectIdentity`,
 *   `decideProjectIdentity` and `decodeProjectInfo` alike.
 * - Fixture matrix: every combination of the three sources x
 *   missing / agree / conflict (27 cases), through every reader, the
 *   inspection, and `--resolve` (plan, then apply): no tracked id ever changes
 *   and no registry row is lost.
 * - Migration only through `cleo doctor project-identity --resolve`: init,
 *   upgrade and an encounter never write `project.json` for a legacy project.
 * - The root marker, the display-name accessor, rename, name drift, the
 *   portable hash and credential re-wrap after a re-key.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatPortableProjectId,
  formatProjectManifest,
  readDeclaredProjectIdentity,
  readPortableProjectId,
} from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptProjectSecret, encryptProjectSecret } from '../crypto/credentials.js';
import {
  inspectProjectIdentity,
  inspectProjectNameDrift,
  type ProjectIdentityState,
  resolveProjectIdentity,
} from '../doctor/project-identity.js';
import { generateProjectHash } from '../nexus/hash.js';
import { registerProjectOnEncounter } from '../paths.js';
import { getProjectDisplayName, getProjectInfoSync, updateProjectName } from '../project-info.js';
import { renameProject } from '../project-lifecycle.js';
import {
  computePortableProjectHash,
  computeStableProjectHash,
  validateProjectRoot,
} from '../project-scope.js';
import { ensureProjectInfo } from '../scaffold/ensure-config.js';
import { decideProjectIdentity } from '../scaffold/project-identity.js';
import { readProjectCredentialIdentity } from '../store/credential-transfer.js';

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

/** What one source holds in a fixture. */
type Slot = 'missing' | 'agree' | 'conflict';
const SLOTS: readonly Slot[] = ['missing', 'agree', 'conflict'];

/** The shared id "agree" means, and each source's distinct "conflict" id. */
const AGREED = 'aaaaaaaaaaaa';
const CONFLICT = { manifest: 'bbbbbbbbbbbb', legacy: 'cccccccccccc', info: 'dddddddddddd' };

/** The id a source holds for a slot, or `null` when missing. */
function idFor(slot: Slot, source: keyof typeof CONFLICT): string | null {
  return slot === 'missing' ? null : slot === 'agree' ? AGREED : CONFLICT[source];
}

/** A git repo whose `.cleo/` holds exactly the requested sources. */
function fixture(
  name: string,
  ids: { manifest: string | null; legacy: string | null; info: string | null },
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
      JSON.stringify({ projectId: ids.info, name: `${name}-cached`, projectHash: 'a1b2c3d4e5f6' }),
    );
  return root;
}

/** The state {@link inspectProjectIdentity} must report for a combination. */
function expectedState(
  manifest: string | null,
  legacy: string | null,
  info: string | null,
): ProjectIdentityState {
  const tracked = manifest ?? legacy;
  if (manifest && legacy && legacy !== manifest) return 'mirror-conflict';
  if (!info) return tracked ? 'not-adopted' : 'uninitialized';
  if (!tracked) return 'missing';
  if (tracked !== info) return 'conflict';
  if (!manifest) return 'legacy';
  if (!legacy) return 'mirror-missing';
  return 'untracked';
}

/** Byte snapshot of the tracked identity files (absent = null). */
function trackedBytes(root: string): { manifest: string | null; legacy: string | null } {
  const read = (file: string): string | null => {
    const path = join(root, '.cleo', file);
    return existsSync(path) ? readFileSync(path, 'utf-8') : null;
  };
  return { manifest: read('project.json'), legacy: read('project-id') };
}

async function registryRows(): Promise<{ projectId: string; name: string }[]> {
  const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
  const { projectRegistry } = await import('../store/schema/nexus-schema.js');
  const db = await getNexusRegistryDb(home);
  return db
    .select({ projectId: projectRegistry.projectId, name: projectRegistry.name })
    .from(projectRegistry)
    .all();
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cleo-t12716-'));
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

const MATRIX = SLOTS.flatMap((manifest) =>
  SLOTS.flatMap((legacy) => SLOTS.map((info) => ({ manifest, legacy, info }))),
);

describe('fixture matrix: project.json x project-id x project-info.json (missing / agree / conflict)', () => {
  it('covers all 27 combinations', () => {
    expect(MATRIX).toHaveLength(27);
  });

  it.each(MATRIX)('project.json=$manifest project-id=$legacy project-info=$info', async ({
    manifest,
    legacy,
    info,
  }) => {
    const ids = {
      manifest: idFor(manifest, 'manifest'),
      legacy: idFor(legacy, 'legacy'),
      info: idFor(info, 'info'),
    };
    const name = `m-${manifest}-l-${legacy}-i-${info}`;
    const root = fixture(name, ids);
    const tracked = ids.manifest ?? ids.legacy;

    // 1. The one tracked resolver: project.json, then project-id.
    const read = readPortableProjectId(root);
    if (tracked === null) expect(read).toEqual({ status: 'absent' });
    else
      expect(read).toMatchObject({
        status: 'valid',
        projectId: tracked,
        file: ids.manifest ? 'project.json' : 'project-id',
      });

    // 2. The declared identity: the tracked id always wins over the cache.
    const declared = readDeclaredProjectIdentity(root);
    const expectedId = tracked ?? ids.info;
    expect(declared?.projectId ?? null).toBe(expectedId);
    if (declared) expect(declared.source).toBe(tracked ? 'tracked' : 'project-info');

    // 3. decodeProjectInfo (getProjectInfo*) applies the same order.
    if (ids.info) expect(getProjectInfoSync(root)?.projectId).toBe(expectedId);

    // 4. decideProjectIdentity — the ONE conflict rule: tracked wins.
    if (expectedId !== null) {
      const decision = await decideProjectIdentity(root, ids.info ?? undefined);
      expect(decision.projectId).toBe(expectedId);
      expect(decision.source).toBe(tracked ? 'tracked' : 'project-info');
      if (tracked && ids.info && tracked !== ids.info)
        expect(decision.diagnostics.join(' ')).toContain('the tracked id wins');
    }

    // 5. The inspection classifies the combination.
    const state = expectedState(ids.manifest, ids.legacy, ids.info);
    const report = inspectProjectIdentity(root);
    expect(report).toMatchObject({
      state,
      trackedId: tracked,
      manifestId: ids.manifest,
      legacyId: ids.legacy,
      localId: ids.info,
    });

    // 6. --resolve: the plan writes nothing; the apply never changes a
    //    tracked id and never loses a registry row. Seeded the way real
    //    encounters register (review finding 5): a conflict was registered
    //    under the cached id before the tracked file arrived, and every later
    //    encounter registers the declared (tracked) id.
    if (ids.info && tracked && tracked !== ids.info)
      await registerProjectOnEncounter(root, ids.info);
    if (ids.info && expectedId) await registerProjectOnEncounter(root, expectedId);
    const rowsBefore = await registryRows();
    const idsBefore = rowsBefore.map((r) => r.projectId);
    const bytesBefore = trackedBytes(root);
    const infoBefore = existsSync(join(root, '.cleo', 'project-info.json'))
      ? readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8')
      : null;

    const plan = await resolveProjectIdentity(root, { dryRun: true });
    expect(trackedBytes(root)).toEqual(bytesBefore);
    expect(
      existsSync(join(root, '.cleo', 'project-info.json'))
        ? readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8')
        : null,
    ).toBe(infoBefore);
    expect(await registryRows()).toEqual(rowsBefore);

    const applied = await resolveProjectIdentity(root);
    expect(applied.steps.map((s) => s.action)).toEqual(plan.steps.map((s) => s.action));
    // No row lost: a folded row (merge-registry-row) leaves its id resolving
    // through the alias to the live row, and its content in a receipt.
    const merged = applied.steps.filter((s) => s.action === 'merge-registry-row').length;
    expect((await registryRows()).length).toBe(rowsBefore.length - merged);
    const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
    const { projectIdAliases } = await import('../store/schema/nexus-schema.js');
    const aliases = (await getNexusRegistryDb(home)).select().from(projectIdAliases).all();
    const liveIds = (await registryRows()).map((r) => r.projectId);
    for (const id of idsBefore)
      expect(
        liveIds.includes(id) ||
          aliases.some((a) => a.legacyId === id && liveIds.includes(a.canonicalId)),
      ).toBe(true);
    const after = trackedBytes(root);
    // An existing tracked file is never rewritten.
    if (bytesBefore.manifest !== null) expect(after.manifest).toBe(bytesBefore.manifest);
    if (bytesBefore.legacy !== null) expect(after.legacy).toBe(bytesBefore.legacy);
    // No id changes: whatever the runtime used before, it uses after.
    if (tracked !== null)
      expect(readPortableProjectId(root)).toMatchObject({ status: 'valid', projectId: tracked });

    switch (state) {
      case 'legacy':
        expect(applied.steps.map((s) => s.action)).toEqual(['write-project-json']);
        expect(JSON.parse(after.manifest ?? '{}')).toEqual({
          schemaVersion: 1,
          id: ids.legacy,
          name: `${name}-cached`,
        });
        expect(inspectProjectIdentity(root).state).toBe('untracked');
        break;
      case 'missing':
        expect(applied.steps.map((s) => s.action)).toEqual(['write-tracked-id']);
        expect(readPortableProjectId(root)).toMatchObject({
          projectId: ids.info,
          name: `${name}-cached`,
        });
        break;
      case 'mirror-missing':
        expect(applied.steps.map((s) => s.action)).toEqual(['write-legacy-mirror']);
        expect(after.legacy).toBe(formatPortableProjectId(ids.manifest ?? ''));
        break;
      case 'conflict': {
        expect(applied.refused).toBeNull();
        const cache = JSON.parse(
          readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8'),
        ) as { projectId: string; previousProjectIds: string[] };
        expect(cache.projectId).toBe(tracked);
        expect(cache.previousProjectIds).toContain(ids.info);
        expect((await registryRows()).map((r) => r.projectId)).toEqual([tracked]);
        expect(applied.steps.map((s) => s.action)).toContain('merge-registry-row');
        if (!ids.manifest) expect(after.manifest).not.toBeNull();
        break;
      }
      case 'mirror-conflict':
        expect(applied.refused).toContain('git log -p');
        expect(applied.steps).toEqual([]);
        break;
      default:
        // uninitialized / not-adopted / untracked: refused with the remedy.
        expect(applied.refused).not.toBeNull();
    }
  });
});

describe('migration happens only through doctor --resolve', () => {
  it('init, force-upgrade and an encounter leave a legacy project legacy', async () => {
    const root = fixture('legacy-only', { manifest: null, legacy: AGREED, info: AGREED });
    await ensureProjectInfo(root);
    await ensureProjectInfo(root, { force: true });
    await registerProjectOnEncounter(root, AGREED);
    expect(existsSync(join(root, '.cleo', 'project.json'))).toBe(false);
    expect(inspectProjectIdentity(root).state).toBe('legacy');
  });

  it('dry-run prints the plan; apply writes project.json from project-id + the cached name', async () => {
    const root = fixture('migrate', { manifest: null, legacy: AGREED, info: AGREED });
    await registerProjectOnEncounter(root, AGREED);
    const legacyBytes = readFileSync(join(root, '.cleo', 'project-id'), 'utf-8');

    const plan = await resolveProjectIdentity(root, { dryRun: true });
    expect(plan.dryRun).toBe(true);
    expect(plan.steps).toEqual([
      expect.objectContaining({
        action: 'write-project-json',
        detail: expect.stringContaining(`{id: ${AGREED}, name: "migrate-cached"}`),
      }),
    ]);
    expect(existsSync(join(root, '.cleo', 'project.json'))).toBe(false);

    const applied = await resolveProjectIdentity(root);
    expect(applied.refused).toBeNull();
    expect(readFileSync(join(root, '.cleo', 'project.json'), 'utf-8')).toBe(
      formatProjectManifest({ schemaVersion: 1, id: AGREED, name: 'migrate-cached' }),
    );
    expect(readFileSync(join(root, '.cleo', 'project-id'), 'utf-8')).toBe(legacyBytes);
    // Idempotent: nothing left but committing the file.
    git(root, 'add', '.cleo/project.json', '.cleo/project-id');
    git(root, 'commit', '-q', '--no-verify', '-m', 'track');
    expect(inspectProjectIdentity(root).state).toBe('ok');
  });
});

describe('a pre-T12716 .cleo/.gitignore', () => {
  it('--resolve inserts !project.json beside !project-id, once, so the file can be committed', async () => {
    const root = fixture('old-ignore', { manifest: null, legacy: AGREED, info: AGREED });
    const ignorePath = join(root, '.cleo', '.gitignore');
    writeFileSync(ignorePath, '*\n!.gitignore\n!project-id\n');
    git(root, 'add', '.cleo/.gitignore', '.cleo/project-id');
    git(root, 'commit', '-q', '--no-verify', '-m', 'legacy');

    const plan = await resolveProjectIdentity(root, { dryRun: true });
    expect(plan.steps.map((s) => s.action)).toEqual(['write-project-json', 'allow-project-json']);
    expect(readFileSync(ignorePath, 'utf-8')).toBe('*\n!.gitignore\n!project-id\n');

    const applied = await resolveProjectIdentity(root);
    expect(applied.refused).toBeNull();
    expect(readFileSync(ignorePath, 'utf-8')).toBe('*\n!.gitignore\n!project.json\n!project-id\n');
    git(root, 'add', '.cleo/.gitignore', '.cleo/project.json');
    git(root, 'commit', '-q', '--no-verify', '-m', 'migrate');
    expect(inspectProjectIdentity(root).state).toBe('ok');
    expect((await resolveProjectIdentity(root)).steps).toEqual([]);
    expect(readFileSync(ignorePath, 'utf-8')).toBe('*\n!.gitignore\n!project.json\n!project-id\n');
  });
});

describe('root marker (validateProjectRoot) accepts project.json and project-id', () => {
  it('accepts a tracked-only .cleo at a git toplevel, for either file', () => {
    const manifestOnly = fixture('marker-json', { manifest: AGREED, legacy: null, info: null });
    const legacyOnly = fixture('marker-id', { manifest: null, legacy: AGREED, info: null });
    expect(validateProjectRoot(manifestOnly)).toBe(true);
    expect(validateProjectRoot(legacyOnly)).toBe(true);
  });

  it('rejects a tracked-only .cleo in a worktree (gitlink file) or below a toplevel', () => {
    const worktree = join(sandbox, 'wt');
    mkdirSync(join(worktree, '.cleo'), { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    writeFileSync(
      join(worktree, '.cleo', 'project.json'),
      formatProjectManifest({ schemaVersion: 1, id: AGREED, name: 'wt' }),
    );
    expect(validateProjectRoot(worktree)).toBe(false);

    const nested = join(sandbox, 'mono', 'packages', 'x');
    mkdirSync(join(nested, '.cleo'), { recursive: true });
    writeFileSync(
      join(nested, '.cleo', 'project.json'),
      formatProjectManifest({ schemaVersion: 1, id: AGREED, name: 'x' }),
    );
    expect(validateProjectRoot(nested)).toBe(false);
  });

  it('rejects a malformed project.json as a marker', () => {
    const root = fixture('marker-bad', { manifest: null, legacy: null, info: null });
    writeFileSync(join(root, '.cleo', 'project.json'), '{"schemaVersion":2}');
    rmSync(join(root, '.git'), { recursive: true, force: true });
    expect(validateProjectRoot(root)).toBe(false);
  });
});

describe('display name: getProjectDisplayName', () => {
  it('prefers project.json, then the legacy cache, then the basename', () => {
    const declared = fixture('named', { manifest: AGREED, legacy: AGREED, info: AGREED });
    expect(getProjectDisplayName(declared)).toBe('named-declared');
    expect(getProjectInfoSync(declared)?.projectName).toBe('named-declared');

    const legacy = fixture('cached', { manifest: null, legacy: AGREED, info: AGREED });
    expect(getProjectDisplayName(legacy)).toBe('cached-cached');

    const bare = fixture('bare', { manifest: null, legacy: AGREED, info: null });
    expect(getProjectDisplayName(bare)).toBe('bare');
  });
});

describe('rename: project.json, registry label and the Nexus label hook', () => {
  it('rewrites only the name, relabels the registry, and reports relink when linked', async () => {
    const root = fixture('renamable', { manifest: AGREED, legacy: AGREED, info: AGREED });
    await registerProjectOnEncounter(root, AGREED);
    writeFileSync(join(root, '.cleo', 'nexus-link.json'), '{"version":1,"links":{}}');
    const legacyBytes = readFileSync(join(root, '.cleo', 'project-id'), 'utf-8');

    const result = await renameProject('cleo-platform', root);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      projectId: AGREED,
      oldName: 'renamable-declared',
      newName: 'cleo-platform',
      recordedIn: 'project.json',
      registry: 'renamed',
      nexusLabel: 'relink-required',
    });
    expect(readFileSync(join(root, '.cleo', 'project.json'), 'utf-8')).toBe(
      formatProjectManifest({ schemaVersion: 1, id: AGREED, name: 'cleo-platform' }),
    );
    expect(readFileSync(join(root, '.cleo', 'project-id'), 'utf-8')).toBe(legacyBytes);
    expect(await registryRows()).toContainEqual({ projectId: AGREED, name: 'cleo-platform' });
    // The legacy fingerprint input in the cache is never touched by a rename.
    const cache = JSON.parse(readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8')) as {
      name: string;
    };
    expect(cache.name).toBe('renamable-cached');
  });

  it('refuses a path-like name', async () => {
    const root = fixture('pathy', { manifest: AGREED, legacy: AGREED, info: AGREED });
    const result = await renameProject('../etc', root);
    expect(result.success).toBe(false);
  });

  it('updateProjectName (cleo upgrade --name) writes project.json when present', () => {
    const root = fixture('upgrade-name', { manifest: AGREED, legacy: AGREED, info: AGREED });
    updateProjectName(root, 'via-upgrade');
    expect(readPortableProjectId(root)).toMatchObject({ projectId: AGREED, name: 'via-upgrade' });
  });
});

describe('doctor: registry-name vs declared-name drift', () => {
  it('reports drift and --resolve syncs the registry label', async () => {
    const root = fixture('drifty', { manifest: AGREED, legacy: AGREED, info: AGREED });
    git(root, 'add', '.cleo/project.json', '.cleo/project-id');
    git(root, 'commit', '-q', '--no-verify', '-m', 'track');
    await registerProjectOnEncounter(root, AGREED);
    const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
    const { projectRegistry } = await import('../store/schema/nexus-schema.js');
    const db = await getNexusRegistryDb(home);
    db.update(projectRegistry).set({ name: 'stale-label' }).run();

    const drift = await inspectProjectNameDrift(root, home);
    expect(drift).toMatchObject({
      state: 'drift',
      registryName: 'stale-label',
      declaredName: 'drifty-declared',
    });
    expect(drift.remedy).toContain('cleo doctor project-identity --resolve');

    const plan = await resolveProjectIdentity(root, { dryRun: true, cleoHome: home });
    expect(plan.steps.map((s) => s.action)).toEqual(['sync-registry-name']);
    expect((await registryRows())[0]?.name).toBe('stale-label');
    await resolveProjectIdentity(root, { cleoHome: home });
    expect((await inspectProjectNameDrift(root, home)).state).toBe('ok');
  });
});

describe('projectHash (AC8: path-derived)', () => {
  it('a tracked id records the path-derived hash; a stored hash is never re-derived', async () => {
    // A tracked id is a PRIOR identity: its keys were built from the path hash.
    const fresh = fixture('fresh', { manifest: AGREED, legacy: AGREED, info: null });
    await ensureProjectInfo(fresh);
    const info = JSON.parse(readFileSync(join(fresh, '.cleo', 'project-info.json'), 'utf-8')) as {
      projectHash: string;
    };
    expect(info.projectHash).toBe(computeStableProjectHash(fresh));
    expect(computePortableProjectHash(AGREED)).toBe(generateProjectHash(`project-id:${AGREED}`));

    const legacy = fixture('stored', { manifest: AGREED, legacy: AGREED, info: AGREED });
    await ensureProjectInfo(legacy, { force: true });
    expect(getProjectInfoSync(legacy)?.projectHash).toBe('a1b2c3d4e5f6');
  });
});

describe('credentials survive a re-key', () => {
  it('a ciphertext sealed under the old cached id opens and is re-wrapped under the tracked id', async () => {
    const root = fixture('keys', { manifest: AGREED, legacy: AGREED, info: CONFLICT.info });
    const sealed = await encryptProjectSecret('sk-test', CONFLICT.info, { cleoHome: home });
    const identity = await readProjectCredentialIdentity(root, home);
    expect(identity).toEqual({ projectId: AGREED, previousProjectIds: [CONFLICT.info] });

    const opened = await decryptProjectSecret(sealed, {
      projectId: identity.projectId ?? '',
      previousProjectIds: identity.previousProjectIds,
      cleoHome: home,
    });
    expect(opened.plaintext).toBe('sk-test');
    expect(opened.rewrapped).not.toBeNull();
    const reopened = await decryptProjectSecret(opened.rewrapped ?? '', {
      projectId: AGREED,
      cleoHome: home,
    });
    expect(reopened).toMatchObject({ plaintext: 'sk-test', rewrapped: null });
  });
});
