/**
 * `cleo doctor projects` — machine-wide registry integrity (T12471).
 *
 * - Three registered projects move; one is restored with a re-minted id.
 *   The dry run lists two `moved` rows and one `split` row, each with its
 *   remedy. `--apply` rebinds the two by id, leaves the split alone, and
 *   writes a receipt; rolling the receipt back restores the prior rows
 *   exactly, and a second rollback is refused.
 * - A deleted project is `missing`; `--apply` records its location as
 *   missing and keeps the row.
 * - An unreadable checkout (EACCES) is never treated as gone.
 * - `nexus projects clean --orphans` refuses to delete a row whose id is
 *   found at another path, and still deletes a true orphan.
 * - Temp and home/root paths are classified.
 *
 * Every case runs against a temp `CLEO_HOME`.
 *
 * @task T12471
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentDeviceId } from '../../nexus/path-map.js';
import { getCleoHome, recordProjectEncounter } from '../../paths.js';
import { writeProjectTombstone } from '../../project-tombstone.js';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import { resetDbState } from '../../store/sqlite.js';
import {
  applyProjectRegistryRepair,
  inspectProjectRegistry,
  isHomeOrRootPath,
  isTempRegistryPath,
  RegistryRepairError,
  rollbackProjectRegistryRepair,
} from '../projects.js';

let testDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  // Registry writers store resolved paths; macOS /tmp is a symlink.
  testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-doctor-projects-T12471-')));
  saved['CLEO_HOME'] = process.env['CLEO_HOME'];
  process.env['CLEO_HOME'] = join(testDir, 'cleo-home');
  mkdirSync(process.env['CLEO_HOME'], { recursive: true });
});

afterEach(async () => {
  await awaitBackgroundOps();
  resetDbState();
  const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
  resetNexusDbState();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** Create an initialised-looking project and register it by encounter. */
async function registerProject(
  root: string,
  projectId: string,
  opts: { remote?: string } = {},
): Promise<string> {
  mkdirSync(join(root, '.cleo'), { recursive: true });
  if (opts.remote) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', opts.remote], { cwd: root });
  } else mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.cleo', 'project-info.json'), JSON.stringify({ projectId }));
  expect(await recordProjectEncounter(root)).toBe('recorded');
  return root;
}

async function registryDb() {
  const { getNexusRegistryDb } = await import('../../store/nexus-sqlite.js');
  const schema = await import('../../store/schema/nexus-schema.js');
  return { db: await getNexusRegistryDb(getCleoHome()), ...schema };
}

/** Every row of the three registry tables, sorted, for exact before/after comparison. */
async function snapshot() {
  const { db, projectRegistry, projectLocations, projectPaths } = await registryDb();
  const sort = <T extends object>(rows: T[]) => rows.map((r) => JSON.stringify(r)).sort();
  return {
    registry: sort(db.select().from(projectRegistry).all()),
    locations: sort(db.select().from(projectLocations).all()),
    paths: sort(db.select().from(projectPaths).all()),
  };
}

async function registeredPath(projectId: string): Promise<string | undefined> {
  const { db, projectRegistry } = await registryDb();
  return db
    .select({ projectPath: projectRegistry.projectPath })
    .from(projectRegistry)
    .where(eq(projectRegistry.projectId, projectId))
    .get()?.projectPath;
}

/** Move three registered projects; re-mint the id of the third. */
async function moveThreeRestoreOneReminted() {
  const oldRoot = join(testDir, 'old');
  const newRoot = join(testDir, 'new');
  mkdirSync(newRoot, { recursive: true });
  // gamma is a git checkout with a remote, so its recorded evidence can prove
  // a re-minted id is the same repository.
  for (const name of ['alpha', 'beta', 'gamma'])
    await registerProject(join(oldRoot, name), `${name}-T12471`, {
      ...(name === 'gamma' ? { remote: 'https://example.invalid/t12471/gamma.git' } : {}),
    });
  for (const name of ['alpha', 'beta', 'gamma'])
    renameSync(join(oldRoot, name), join(newRoot, name));
  // gamma is restored from scratch: a fresh `cleo init` minted a new id.
  writeFileSync(
    join(newRoot, 'gamma', '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'gamma-reminted-T12471' }),
  );
  return { oldRoot, newRoot };
}

describe('doctor projects: move 3, restore 1 with a re-minted id (T12471)', () => {
  it('dry run lists 2 moved and 1 split, each with the exact remedy, and writes nothing', async () => {
    const { oldRoot, newRoot } = await moveThreeRestoreOneReminted();
    const before = await snapshot();

    const report = await inspectProjectRegistry({ roots: [newRoot] });

    expect(report.dryRun).toBe(true);
    expect(report.counts.moved).toBe(2);
    expect(report.counts.split).toBe(1);
    const byId = new Map(report.findings.map((f) => [f.projectId, f]));
    for (const name of ['alpha', 'beta']) {
      const f = byId.get(`${name}-T12471`);
      expect(f?.kind).toBe('moved');
      expect(f?.projectPath).toBe(join(oldRoot, name));
      expect(f?.foundAt).toEqual([join(newRoot, name)]);
      // The encounter minted a checkout nonce; the move carried it.
      expect(f?.proof).toBe('nonce');
      expect(f?.applicable).toBe(true);
      expect(f?.remedy).toBe(
        `cleo doctor projects --apply   (rebinds the row to ${join(newRoot, name)}; permissions stay with the row)`,
      );
    }
    const gamma = byId.get('gamma-T12471');
    expect(gamma?.kind).toBe('split');
    expect(gamma?.applicable).toBe(false);
    expect(gamma?.splitWith).toEqual([
      {
        projectId: 'gamma-reminted-T12471',
        projectPath: join(newRoot, 'gamma'),
        registered: false,
        matchedBy: 'remote',
      },
    ]);
    expect(gamma?.remedy).toContain('cleo nexus unregister gamma-T12471');
    expect(gamma?.remedy).toContain('cleo doctor project-identity --resolve');
    expect(await snapshot()).toEqual(before);
  });

  it('--apply rebinds 2 by id, flags 1 split, writes a receipt; rollback restores the prior rows', async () => {
    const { oldRoot, newRoot } = await moveThreeRestoreOneReminted();
    const before = await snapshot();

    const result = await applyProjectRegistryRepair({ roots: [newRoot] });

    expect(result.dryRun).toBe(false);
    expect(result.counts.split).toBe(1);
    const receipt = result.receipt;
    expect(receipt).toBeDefined();
    expect(receipt?.actions.map((a) => [a.action, a.projectId, a.to, a.outcome]).sort()).toEqual([
      ['rebind', 'alpha-T12471', join(newRoot, 'alpha'), 'applied'],
      ['rebind', 'beta-T12471', join(newRoot, 'beta'), 'applied'],
    ]);
    expect(receipt?.registryRows.before).toBe(receipt?.registryRows.after);
    expect(receipt?.rollback).toBe(`cleo doctor projects --rollback ${receipt?.receiptId}`);
    expect(await registeredPath('alpha-T12471')).toBe(join(newRoot, 'alpha'));
    expect(await registeredPath('beta-T12471')).toBe(join(newRoot, 'beta'));
    // The split is an owner decision: its row is untouched.
    expect(await registeredPath('gamma-T12471')).toBe(join(oldRoot, 'gamma'));

    const { db, nexusAuditLog } = await registryDb();
    const audit = db
      .select()
      .from(nexusAuditLog)
      .where(eq(nexusAuditLog.id, receipt?.receiptId ?? ''))
      .get();
    expect(audit?.action).toBe('doctor.projects.apply');

    // A re-run finds nothing more to rebind.
    const again = await inspectProjectRegistry({ roots: [newRoot] });
    expect(again.counts.moved).toBe(0);
    expect(again.counts.ok).toBe(2);

    const rolledBack = await rollbackProjectRegistryRepair(receipt?.receiptId ?? '');
    expect(rolledBack.restored.registry).toBeGreaterThanOrEqual(2);
    expect(await snapshot()).toEqual(before);

    await expect(rollbackProjectRegistryRepair(receipt?.receiptId ?? '')).rejects.toMatchObject({
      code: 'E_ROLLBACK_CONFLICT',
    });
  });

  it("a project moved onto another row's old path: both rebind, and rollback restores both exactly", async () => {
    const ws = join(testDir, 'ws');
    // omega is registered FIRST, so a naive in-order apply would rebind it
    // onto ws/shared before delta leaves, displacing delta's row.
    const omega = await registerProject(join(ws, 'omega'), 'omega-T12471');
    // delta lives at ws/shared; a copy of it (same nonce) is seen at ws/delta-copy.
    const shared = await registerProject(join(ws, 'shared'), 'delta-T12471');
    const copy = join(ws, 'delta-copy');
    cpSync(shared, copy, { recursive: true });
    expect(await recordProjectEncounter(copy)).toBe('recorded');
    await awaitBackgroundOps();
    // omega moves INTO ws/shared after delta's checkout there is removed.
    await rm(shared, { recursive: true, force: true });
    renameSync(omega, shared);
    const before = await snapshot();

    const result = await applyProjectRegistryRepair({ roots: [ws] });

    // delta moves out first, so omega's rebind displaces nothing.
    expect(result.receipt?.actions.map((a) => [a.projectId, a.to, a.outcome])).toEqual([
      ['delta-T12471', copy, 'applied'],
      ['omega-T12471', shared, 'applied'],
    ]);
    expect(await registeredPath('delta-T12471')).toBe(copy);
    expect(await registeredPath('omega-T12471')).toBe(shared);

    await rollbackProjectRegistryRepair(result.receipt?.receiptId ?? '');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a rollback when a row in its scope changed after the repair', async () => {
    const { newRoot } = await moveThreeRestoreOneReminted();
    const result = await applyProjectRegistryRepair({ roots: [newRoot] });
    const { db, projectRegistry } = await registryDb();
    db.update(projectRegistry)
      .set({ permissions: 'write' })
      .where(eq(projectRegistry.projectId, 'alpha-T12471'))
      .run();

    const error = await rollbackProjectRegistryRepair(result.receipt?.receiptId ?? '').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RegistryRepairError);
    expect((error as RegistryRepairError).code).toBe('E_ROLLBACK_CONFLICT');
    expect(await registeredPath('alpha-T12471')).toBe(join(newRoot, 'alpha'));
  });

  it('rejects an unknown receipt id', async () => {
    await registerProject(join(testDir, 'solo'), 'solo-T12471');
    await expect(rollbackProjectRegistryRepair('no-such-receipt')).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    });
  });
});

describe('doctor projects: missing and unreadable rows (T12471)', () => {
  it('a deleted project is missing; --apply records the location missing and keeps the row', async () => {
    const root = await registerProject(join(testDir, 'gone', 'delta'), 'delta-T12471');
    await rm(root, { recursive: true, force: true });

    const report = await inspectProjectRegistry();
    const delta = report.findings.find((f) => f.projectId === 'delta-T12471');
    expect(delta?.kind).toBe('missing');
    expect(delta?.applicable).toBe(true);
    expect(delta?.remedy).toContain('cleo doctor projects --roots <dir>');
    expect(delta?.remedy).toContain('cleo nexus unregister delta-T12471');

    const result = await applyProjectRegistryRepair();
    expect(result.receipt?.actions).toEqual([
      { action: 'mark-missing', projectId: 'delta-T12471', from: root, outcome: 'applied' },
    ]);
    expect(await registeredPath('delta-T12471')).toBe(root);
    const { db, projectLocations } = await registryDb();
    const states = db
      .select({ state: projectLocations.state })
      .from(projectLocations)
      .where(eq(projectLocations.projectId, 'delta-T12471'))
      .all();
    expect(states).toEqual([{ state: 'missing' }]);

    // Already recorded missing: nothing left to apply.
    const again = await inspectProjectRegistry();
    expect(again.findings.find((f) => f.projectId === 'delta-T12471')?.applicable).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unreadable checkout (EACCES) is unreadable, never missing, and --apply leaves it alone',
    async () => {
      const root = await registerProject(join(testDir, 'locked', 'epsilon'), 'epsilon-T12471');
      const before = await snapshot();
      chmodSync(join(root, '.cleo'), 0o000);
      try {
        const report = await inspectProjectRegistry();
        const f = report.findings.find((x) => x.projectId === 'epsilon-T12471');
        expect(f?.kind).toBe('unreadable');
        expect(f?.applicable).toBe(false);
        const result = await applyProjectRegistryRepair();
        expect(result.receipt).toBeUndefined();
        expect(await snapshot()).toEqual(before);
      } finally {
        chmodSync(join(root, '.cleo'), 0o755);
      }
    },
  );
});

describe('nexus projects clean --orphans with relocated ids (T12471)', () => {
  it('never deletes a row whose id is found at another path, and still deletes a true orphan', async () => {
    const parent = join(testDir, 'work');
    const zeta = await registerProject(join(parent, 'zeta'), 'zeta-T12471');
    const eta = await registerProject(join(parent, 'eta'), 'eta-T12471');
    const ghost = await registerProject(join(parent, 'ghost'), 'ghost-T12471');
    // zeta is renamed next to where it was (found by scanning its parent).
    renameSync(zeta, join(parent, 'zeta-renamed'));
    // eta moves far away and was seen there once, without its nonce, so the
    // encounter recorded only a candidate location.
    const far = join(testDir, 'far', 'eta');
    mkdirSync(join(testDir, 'far'), { recursive: true });
    renameSync(eta, far);
    const infoPath = join(far, '.cleo', 'project-info.json');
    const info = JSON.parse(readFileSync(infoPath, 'utf-8')) as Record<string, unknown>;
    delete info['checkoutNonce'];
    writeFileSync(infoPath, JSON.stringify(info));
    expect(await recordProjectEncounter(far)).toBe('recorded');
    await awaitBackgroundOps();
    expect(await registeredPath('eta-T12471')).toBe(eta);
    // ghost is deleted outright.
    await rm(ghost, { recursive: true, force: true });

    const { cleanProjects } = await import('../../nexus/projects-clean.js');
    const result = await cleanProjects({ dryRun: false, matchOrphaned: true });

    expect(result.purged).toBe(1);
    expect(result.receipt?.removed.map((r) => r.projectId)).toEqual(['ghost-T12471']);
    expect(await registeredPath('zeta-T12471')).toBe(zeta);
    expect(await registeredPath('eta-T12471')).toBe(eta);
    const relocated = new Map((result.relocated ?? []).map((r) => [r.projectId, r]));
    expect(relocated.get('zeta-T12471')?.foundAt).toEqual([join(parent, 'zeta-renamed')]);
    expect(relocated.get('eta-T12471')?.foundAt).toEqual([far]);
    expect(relocated.get('zeta-T12471')?.remedy).toContain('cleo doctor projects');
  });
});

describe('temp and home/root classification (T12471)', () => {
  // Literal persistent paths: the test runner points HOME at a temp directory.
  const persistentHome = '/home/example-T12471/.local/share/cleo';

  it('a temp path is a temp row only when the registry itself is persistent', () => {
    const fixture = join(tmpdir(), 'some-fixture');
    expect(isTempRegistryPath(fixture, persistentHome)).toBe(true);
    expect(isTempRegistryPath('/tmp/scratch', persistentHome)).toBe(true);
    expect(isTempRegistryPath(fixture, join(tmpdir(), 'sandbox-cleo-home'))).toBe(false);
    expect(isTempRegistryPath('/home/example-T12471/code/app', persistentHome)).toBe(false);
  });

  it('the home directory and a filesystem root are root rows', () => {
    expect(isHomeOrRootPath('/', '/home/example-T12471')).toBe(true);
    expect(isHomeOrRootPath('/home/example-T12471', '/home/example-T12471')).toBe(true);
    expect(isHomeOrRootPath('/home/example-T12471/code', '/home/example-T12471')).toBe(false);
  });
});

describe('doctor projects review fixes (T12471 · PR #1611)', () => {
  /** Register a project, then delete its registered checkout. */
  async function goneProject(root: string, projectId: string): Promise<void> {
    await registerProject(root, projectId);
    await rm(root, { recursive: true, force: true });
  }

  it('H1: a clone with its OWN nonce is id-only — reported, never rebound', async () => {
    const ws = join(testDir, 'ws');
    const original = join(ws, 'orig');
    await registerProject(original, 'clone-T12471');
    const clone = join(ws, 'clone');
    cpSync(original, clone, { recursive: true });
    const info = JSON.parse(readFileSync(join(clone, '.cleo', 'project-info.json'), 'utf-8'));
    writeFileSync(
      join(clone, '.cleo', 'project-info.json'),
      JSON.stringify({ ...info, checkoutNonce: 'f'.repeat(32) }),
    );
    // The original is on an unmounted volume: its path is gone.
    await rm(original, { recursive: true, force: true });
    const before = await snapshot();

    const report = await inspectProjectRegistry({ roots: [ws] });
    const f = report.findings.find((x) => x.projectId === 'clone-T12471');
    expect(f?.kind).toBe('moved');
    expect(f?.proof).toBe('id-only');
    expect(f?.applicable).toBe(false);
    expect(f?.remedy).toContain('cleo doctor project-identity --resolve');
    const result = await applyProjectRegistryRepair({ roots: [ws] });
    expect(result.receipt).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  it('H1: a bare dropped .cleo/project-id (no nonce) is id-only — never rebound', async () => {
    const ws = join(testDir, 'ws');
    await goneProject(join(ws, 'orig'), 'bare-T12471');
    const bare = join(ws, 'bare');
    mkdirSync(join(bare, '.cleo'), { recursive: true });
    writeFileSync(join(bare, '.cleo', 'project-id'), 'bare-T12471\n');
    const before = await snapshot();

    const result = await applyProjectRegistryRepair({ roots: [ws] });
    const f = result.findings.find((x) => x.projectId === 'bare-T12471');
    expect(f?.kind).toBe('moved');
    expect(f?.applicable).toBe(false);
    expect(result.receipt).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  it('H2: a root holding a valid tombstone is never a rebind target, even with the nonce', async () => {
    const ws = join(testDir, 'ws');
    const gone = join(ws, 'gone');
    await registerProject(gone, 'tomb-T12471');
    const mono = join(ws, 'mono');
    const app = join(mono, 'app');
    // mono carries the real .cleo (same nonce) plus a valid reroot tombstone to app.
    cpSync(gone, mono, { recursive: true });
    mkdirSync(join(app, '.cleo'), { recursive: true });
    writeFileSync(
      join(app, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'tomb-T12471', checkoutNonce: 'e'.repeat(32) }),
    );
    writeProjectTombstone(mono, {
      projectId: 'tomb-T12471',
      movedTo: app,
      at: new Date().toISOString(),
    });
    await rm(gone, { recursive: true, force: true });

    const result = await applyProjectRegistryRepair({ roots: [ws] });
    expect(result.receipt).toBeUndefined();
    expect(await registeredPath('tomb-T12471')).toBe(gone);
    const f = result.findings.find((x) => x.projectId === 'tomb-T12471');
    expect(f?.applicable).toBe(false);
  });

  it('H2: a location demoted to missing in reroot geometry is never a rebind target', async () => {
    const ws = join(testDir, 'ws');
    const mono = await registerProject(join(ws, 'mono'), 'reroot-T12471');
    const app = join(mono, 'app');
    // Reroot by hand: .cleo moves into app, the registry follows, mono is demoted.
    mkdirSync(app, { recursive: true });
    renameSync(join(mono, '.cleo'), join(app, '.cleo'));
    const { db } = await registryDb();
    const { confirmProjectLocation, demoteProjectLocation } = await import(
      '../../nexus/path-map.js'
    );
    const now = new Date().toISOString();
    db.transaction((tx) => {
      confirmProjectLocation(tx, { projectId: 'reroot-T12471', projectPath: app, now });
      demoteProjectLocation(tx, { projectId: 'reroot-T12471', projectPath: mono, now }, 'missing');
    });
    // A backup of .cleo (same nonce) is restored at mono, then app is moved off-device.
    cpSync(join(app, '.cleo'), join(mono, '.cleo'), { recursive: true });
    await rm(app, { recursive: true, force: true });

    const result = await applyProjectRegistryRepair({ roots: [ws] });
    expect(await registeredPath('reroot-T12471')).toBe(app);
    expect(result.receipt?.actions.some((a) => a.action === 'rebind')).not.toBe(true);
    expect(result.findings.find((x) => x.projectId === 'reroot-T12471')?.applicable).toBe(false);
  });

  it('H3: clean --orphans keeps a live project hidden by EACCES', async () => {
    const locked = join(testDir, 'locked');
    const root = await registerProject(join(locked, 'p'), 'eacces-T12471');
    chmodSync(locked, 0o000);
    try {
      const { cleanProjects } = await import('../../nexus/projects-clean.js');
      const result = await cleanProjects({ dryRun: false, matchOrphaned: true });
      expect(result.purged).toBe(0);
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(await registeredPath('eacces-T12471')).toBe(root);
  });

  it('M1: a project in the Trash is never a rebind target', async () => {
    const ws = join(testDir, 'ws');
    const orig = await registerProject(join(ws, 'trashed'), 'trash-T12471');
    const trash = join(testDir, '.Trash');
    mkdirSync(trash, { recursive: true });
    renameSync(orig, join(trash, 'trashed'));

    for (const roots of [[testDir], [trash]]) {
      const report = await inspectProjectRegistry({ roots });
      const f = report.findings.find((x) => x.projectId === 'trash-T12471');
      expect(f?.applicable === true && f.kind === 'moved').toBe(false);
    }
    await applyProjectRegistryRepair({ roots: [trash] });
    expect(await registeredPath('trash-T12471')).toBe(orig);
  });

  it('M2: a same-name project without shared evidence is a possible split: inspect only, row marked missing', async () => {
    const ws = join(testDir, 'ws');
    const gone = join(ws, 'a', 'app');
    await goneProject(gone, 'app-one-T12471');
    const stranger = join(ws, 'b', 'app');
    mkdirSync(join(stranger, '.cleo'), { recursive: true });
    writeFileSync(
      join(stranger, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'app-two-T12471' }),
    );

    const report = await inspectProjectRegistry({ roots: [join(ws, 'b')] });
    const f = report.findings.find((x) => x.projectId === 'app-one-T12471');
    expect(f?.kind).toBe('possible-split');
    expect(f?.applicable).toBe(true);
    expect(f?.remedy).not.toContain('unregister');
    expect(f?.remedy).not.toContain('restore .cleo/project-id');
    const result = await applyProjectRegistryRepair({ roots: [join(ws, 'b')] });
    expect(result.receipt?.actions.map((a) => a.action)).toEqual(['mark-missing']);
  });

  it('M3: a CLEO project nested inside another registered project of the same repo is not a split', async () => {
    const repo = join(testDir, 'ws', 'repo');
    await registerProject(repo, 'outer-T12471', {
      remote: 'https://example.invalid/t12471/repo.git',
    });
    const nested = join(repo, 'packages', 'x', 'fixtures');
    mkdirSync(join(nested, '.cleo'), { recursive: true });
    writeFileSync(
      join(nested, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'nested-T12471' }),
    );
    expect(await recordProjectEncounter(nested)).toBe('recorded');
    await awaitBackgroundOps();

    const report = await inspectProjectRegistry();
    expect(report.counts.split).toBe(0);
  });

  it('L1: rollback restores migration-backfilled (local-device) rows it re-keyed', async () => {
    const { newRoot } = await moveThreeRestoreOneReminted();
    const { db, projectLocations } = await registryDb();
    const now = new Date().toISOString();
    db.insert(projectLocations)
      .values({
        projectId: 'backfilled-T12471',
        deviceId: 'local',
        path: join(testDir, 'backfilled'),
        firstSeen: now,
        lastSeen: now,
        state: 'live',
      })
      .run();
    const before = await snapshot();

    const result = await applyProjectRegistryRepair({ roots: [newRoot] });
    expect(currentDeviceId()).not.toBe('local');
    await rollbackProjectRegistryRepair(result.receipt?.receiptId ?? '');
    expect(await snapshot()).toEqual(before);
  });

  it('L4: a registered directory that exists without .cleo/ is not described as gone', async () => {
    const root = await registerProject(join(testDir, 'ws', 'hollow'), 'hollow-T12471');
    await rm(join(root, '.cleo'), { recursive: true, force: true });

    const report = await inspectProjectRegistry();
    const f = report.findings.find((x) => x.projectId === 'hollow-T12471');
    expect(f?.kind).toBe('missing');
    expect(f?.message).not.toContain('no longer exists');
    expect(f?.message).toContain('.cleo');
  });
});
