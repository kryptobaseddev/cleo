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
