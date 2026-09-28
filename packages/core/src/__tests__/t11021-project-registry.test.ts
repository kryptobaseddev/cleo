/**
 * Tests for project registry lookup and auto-registration (T11021), updated for
 * the immutable-identity contract (T11281, owner directive 2026-05-29).
 *
 * A project's `projectId` is its IMMUTABLE lifetime identity — assigned once and
 * stored in `.cleo/project-info.json`. `registerProjectOnEncounter` registers
 * THAT stored id (not a path-derived canonical id); the path-derived canonical id
 * is recorded only as an ALIAS so lookups by it still resolve. `projectHash` is
 * the path fingerprint that updates on relocation. On move/rename/export-import
 * the SAME row is updated in place (same projectId, new path + new projectHash) —
 * there is no second entry and no GC of an old-path row.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerProjectOnEncounter, resolveProjectById } from '../paths.js';
import { worktreeScope } from '../project-scope.js';
import {
  awaitBackgroundOps,
  createOperationExecutionContext,
  pendingBackgroundOpCount,
} from '../store/background-ops.js';

function createTempCleoProject(
  dir: string,
  opts?: { projectName?: string; projectId?: string; remote?: string },
) {
  const pid = opts?.projectId ?? `pid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const cleoDir = join(dir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const info: Record<string, string> = { projectId: pid };
  if (opts?.projectName) info.name = opts.projectName;
  writeFileSync(join(cleoDir, 'project-info.json'), JSON.stringify(info));
  writeFileSync(join(cleoDir, 'tasks.db'), '');
  if (opts?.remote) {
    // A real repository, so the checkout carries verifiable evidence (T12470).
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', opts.remote], { cwd: dir, stdio: 'ignore' });
  } else {
    mkdirSync(join(dir, '.git'), { recursive: true });
  }
  return { projectRoot: resolve(dir), infoProjectId: pid };
}

async function registerAndGetRegisteredId(
  projectRoot: string,
  infoProjectId: string,
): Promise<string> {
  await registerProjectOnEncounter(projectRoot, infoProjectId);
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const db = await getNexusDb();
  const { projectRegistry } = await import('../store/schema/nexus-schema.js');
  const { eq } = await import('drizzle-orm');
  const rows = await db
    .select()
    .from(projectRegistry)
    .where(eq(projectRegistry.projectPath, resolve(projectRoot)))
    .limit(1);
  return (rows[0]?.projectId as string) ?? '';
}

describe('resolveProjectById (T11021 AC1, AC4)', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    tempDirs.length = 0;
  });

  it('returns null when nexus.db does not exist', async () => {
    const tempHome = join(tmpdir(), `ch-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    tempDirs.push(tempHome);
    const orig = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tempHome;
    try {
      expect(await resolveProjectById('x')).toBeNull();
    } finally {
      if (orig !== undefined) process.env['CLEO_HOME'] = orig;
      else delete process.env['CLEO_HOME'];
    }
  });

  it('resolves a registered project by its immutable ID (AC1)', async () => {
    const tempHome = join(tmpdir(), `ch-${Date.now()}`);
    const tempProj = join(tmpdir(), `cp-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    tempDirs.push(tempHome, tempProj);
    const { projectRoot, infoProjectId } = createTempCleoProject(tempProj, { projectName: 'tp' });
    const orig = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tempHome;
    try {
      const registeredId = await registerAndGetRegisteredId(projectRoot, infoProjectId);
      // T11281: the registered id is the IMMUTABLE stored project-info id.
      expect(registeredId).toBe(infoProjectId);
      const entry = await resolveProjectById(registeredId);
      expect(entry).not.toBeNull();
      expect(entry!.projectRoot).toBe(projectRoot);
      expect(entry!.name).toBe('tp');
      expect(entry!.projectId).toBe(infoProjectId);
    } finally {
      if (orig !== undefined) process.env['CLEO_HOME'] = orig;
      else delete process.env['CLEO_HOME'];
    }
  });

  it('returns null for unknown projectId', async () => {
    const tempHome = join(tmpdir(), `ch-${Date.now()}`);
    const tempProj = join(tmpdir(), `cp-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    tempDirs.push(tempHome, tempProj);
    const { projectRoot, infoProjectId } = createTempCleoProject(tempProj);
    const orig = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tempHome;
    try {
      await registerAndGetRegisteredId(projectRoot, infoProjectId);
      const entry = await resolveProjectById('nonexistent-id-xyz');
      expect(entry).toBeNull();
    } finally {
      if (orig !== undefined) process.env['CLEO_HOME'] = orig;
      else delete process.env['CLEO_HOME'];
    }
  });
});

describe('registerProjectOnEncounter (T11021 AC2, AC3, AC5)', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    tempDirs.length = 0;
  });

  it('registers new project with project-info.json name (AC2, AC6)', async () => {
    const tempHome = join(tmpdir(), `ch-${Date.now()}`);
    const tempProj = join(tmpdir(), `cp-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    tempDirs.push(tempHome, tempProj);
    const { projectRoot, infoProjectId } = createTempCleoProject(tempProj, {
      projectName: 'new-proj',
    });
    const orig = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tempHome;
    try {
      const canonicalId = await registerAndGetRegisteredId(projectRoot, infoProjectId);
      expect(canonicalId).toBeTruthy();
      const e = await resolveProjectById(canonicalId);
      expect(e).not.toBeNull();
      expect(e!.projectRoot).toBe(projectRoot);
      expect(e!.name).toBe('new-proj');
      expect(e!.projectHash).toBeTruthy();
    } finally {
      if (orig !== undefined) process.env['CLEO_HOME'] = orig;
      else delete process.env['CLEO_HOME'];
    }
  });

  it('is idempotent on re-encounter at same path', async () => {
    const tempHome = join(tmpdir(), `ch-${Date.now()}`);
    const tempProj = join(tmpdir(), `cp-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    tempDirs.push(tempHome, tempProj);
    const { projectRoot, infoProjectId } = createTempCleoProject(tempProj, { projectName: 'idem' });
    const orig = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tempHome;
    try {
      const cid1 = await registerAndGetRegisteredId(projectRoot, infoProjectId);
      await registerProjectOnEncounter(projectRoot, infoProjectId);
      // Should still resolve to same canonical ID
      const entry = await resolveProjectById(cid1);
      expect(entry).not.toBeNull();
      expect(entry!.projectRoot).toBe(projectRoot);
    } finally {
      if (orig !== undefined) process.env['CLEO_HOME'] = orig;
      else delete process.env['CLEO_HOME'];
    }
  });

  it('retains the immutable ID and updates the path in place when the directory moves (AC5)', async () => {
    const tempHome = join(tmpdir(), `ch-${Date.now()}`);
    const tempProj1 = join(tmpdir(), `cp1-${Date.now()}`);
    const tempProj2 = join(tmpdir(), `cp2-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    tempDirs.push(tempHome, tempProj1, tempProj2);
    const { infoProjectId } = createTempCleoProject(tempProj1, {
      projectName: 'movable',
      remote: 'https://example.invalid/movable.git',
    });
    const orig = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tempHome;
    try {
      const id1 = await registerAndGetRegisteredId(resolve(tempProj1), infoProjectId);
      expect(id1).toBe(infoProjectId);
      const hash1 = (await resolveProjectById(id1))!.projectHash;

      // A real move: the directory (and its project-info.json) goes to a new
      // path and the old one is gone. T12470: the encounter follows it only
      // because the move is verifiable — same git remote as recorded.
      renameSync(tempProj1, tempProj2);
      const movedRoot = resolve(tempProj2);
      const id2 = await registerAndGetRegisteredId(movedRoot, infoProjectId);

      // T11281: identity is immutable — the id is RETAINED across the move.
      expect(id2).toBe(id1);
      // The single row is updated in place: path moves, projectHash (the path
      // fingerprint) changes.
      const moved = await resolveProjectById(id1);
      expect(moved).not.toBeNull();
      expect(moved!.projectRoot).toBe(movedRoot);
      expect(moved!.projectHash).not.toBe(hash1);
      // There is NO lingering second row at the old path.
      const { getNexusDb } = await import('../store/nexus-sqlite.js');
      const db = await getNexusDb();
      const { projectRegistry } = await import('../store/schema/nexus-schema.js');
      const { eq } = await import('drizzle-orm');
      const oldRows = await db
        .select()
        .from(projectRegistry)
        .where(eq(projectRegistry.projectPath, resolve(tempProj1)));
      expect(oldRows).toHaveLength(0);
    } finally {
      if (orig !== undefined) process.env['CLEO_HOME'] = orig;
      else delete process.env['CLEO_HOME'];
    }
  });

  it('registers the immutable stored ID and resolves it by its path-derived canonical alias (AC3)', async () => {
    const tempHome = join(tmpdir(), `ch-${Date.now()}`);
    const tempProj = join(tmpdir(), `cp-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    tempDirs.push(tempHome, tempProj);
    const { projectRoot, infoProjectId } = createTempCleoProject(tempProj, {
      projectName: 'canon',
    });
    const orig = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tempHome;
    try {
      const registeredId = await registerAndGetRegisteredId(projectRoot, infoProjectId);
      // The registry stores the IMMUTABLE id verbatim — not a path-derived id.
      expect(registeredId).toBe(infoProjectId);
      const e = await resolveProjectById(registeredId);
      expect(e).not.toBeNull();
      expect(e!.projectId).toBe(infoProjectId);

      // The path-derived canonical id is recorded as an ALIAS, so a lookup by it
      // still resolves to the same immutable-id row.
      const { canonicalProjectId } = await import('../nexus/identity.js');
      const canonical = (await canonicalProjectId(projectRoot)).id;
      expect(canonical).toMatch(/^[0-9a-f]{12}$/);
      const viaAlias = await resolveProjectById(canonical);
      expect(viaAlias).not.toBeNull();
      expect(viaAlias!.projectId).toBe(infoProjectId);
    } finally {
      if (orig !== undefined) process.env['CLEO_HOME'] = orig;
      else delete process.env['CLEO_HOME'];
    }
  });
});

describe('captured encounter registration ownership', () => {
  afterEach(async () => {
    await awaitBackgroundOps();
    const { closeAllDatabases } = await import('../store/sqlite.js');
    await closeAllDatabases();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  for (const changeAmbient of [false, true]) {
    it(`registers globally while a project writer is held (ambient switch ${changeAmbient})`, async () => {
      const fixture = mkdtempSync(join(tmpdir(), 'cleo-encounter-owned-'));
      const project = join(fixture, 'project');
      const other = join(fixture, 'other');
      const home = join(fixture, 'global');
      const otherHome = join(fixture, 'other-global');
      mkdirSync(home, { recursive: true });
      mkdirSync(otherHome, { recursive: true });
      const { infoProjectId } = createTempCleoProject(project, { projectName: 'Captured project' });
      createTempCleoProject(other);
      vi.stubEnv('CLEO_HOME', home);
      vi.stubEnv('CLEO_ROOT', project);
      vi.stubEnv('CLEO_DIR', join(project, '.cleo'));
      const { getDb, getNativeTasksDb } = await import('../store/sqlite.js');
      const { peekProjectDomain } = await import('../store/ports/domain-binding.js');
      await worktreeScope.run({ worktreeRoot: project, projectHash: 'fixture' }, () =>
        getDb(project),
      );
      const native = getNativeTasksDb(project)!;
      native.exec('BEGIN IMMEDIATE');
      const identity = await import('../nexus/identity.js');
      const original = identity.projectPathFingerprint;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      vi.spyOn(identity, 'projectPathFingerprint').mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      });
      const pending = registerProjectOnEncounter(project, infoProjectId);
      try {
        await entered.promise;
        const wasTracked = pendingBackgroundOpCount() > 0;
        if (changeAmbient) {
          vi.stubEnv('CLEO_HOME', otherHome);
          vi.stubEnv('CLEO_ROOT', other);
          vi.stubEnv('CLEO_DIR', join(other, '.cleo'));
        }
        release.resolve();
        await pending;
        expect(native.isTransaction).toBe(true);
        expect(
          worktreeScope.run({ worktreeRoot: project, projectHash: 'fixture' }, () =>
            peekProjectDomain('nexus', project),
          ),
        ).toBeNull();
        const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
        const { projectRegistry } = await import('../store/schema/nexus-schema.js');
        const rows = (await getNexusRegistryDb(home)).select().from(projectRegistry).all();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          projectId: infoProjectId,
          projectPath: project,
          name: 'Captured project',
        });
        expect(existsSync(join(otherHome, 'cleo.db'))).toBe(false);
        expect(wasTracked).toBe(true);
      } finally {
        release.resolve();
        await pending.catch(() => {});
        if (native.isTransaction) native.exec('ROLLBACK');
        await awaitBackgroundOps();
        const { closeAllDatabases } = await import('../store/sqlite.js');
        await closeAllDatabases();
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  }

  it('retains both immutable owners when their lossy legacy path aliases collide', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'cleo-encounter-common-prefix-'));
    const projectA = join(fixture, 'project-a');
    const projectB = join(fixture, 'project-b');
    const idA = createTempCleoProject(projectA).infoProjectId;
    const idB = createTempCleoProject(projectB).infoProjectId;
    const home = join(fixture, 'global');
    mkdirSync(home);
    vi.stubEnv('CLEO_HOME', home);
    const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { legacyProjectId } = await import('../nexus/identity.js');
    expect(legacyProjectId(projectA)).toBe(legacyProjectId(projectB));
    try {
      await registerProjectOnEncounter(projectA, idA);
      await registerProjectOnEncounter(projectB, idB);
      const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
      const { projectRegistry, projectIdAliases } = await import('../store/schema/nexus-schema.js');
      const { eq } = await import('drizzle-orm');
      const db = await getNexusRegistryDb(home);
      expect(
        db
          .select()
          .from(projectRegistry)
          .all()
          .map((row) => row.projectId)
          .sort(),
      ).toEqual([idA, idB].sort());
      expect(
        db
          .select()
          .from(projectIdAliases)
          .where(eq(projectIdAliases.legacyId, legacyProjectId(projectA)))
          .get()?.canonicalId,
      ).toBe(idA);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('omitted colliding legacy alias'),
      );
    } finally {
      await awaitBackgroundOps();
      const { closeAllDatabases } = await import('../store/sqlite.js');
      await closeAllDatabases();
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  // T12469 (ADR-094): the registry is keyed by project_id alone. This test
  // used to pin the path-keyed behaviour — a second id at a registered path, or
  // a path-derived canonical alias owned by another project, was rejected as
  // "another immutable identity". Both now register by design; the rollback
  // guarantees (alias-storage failure, malformed identity) are unchanged.
  it('registers a new id at a taken path, keeps one row per path, and rolls back when alias storage fails', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'cleo-encounter-conflict-'));
    const project = join(fixture, 'project');
    const second = join(fixture, 'second');
    const home = join(fixture, 'global');
    mkdirSync(home);
    const { infoProjectId } = createTempCleoProject(project);
    const secondId = createTempCleoProject(second).infoProjectId;
    vi.stubEnv('CLEO_HOME', home);
    const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
    const { projectRegistry } = await import('../store/schema/nexus-schema.js');
    const { supersededRegistryPath } = await import('../nexus/path-map.js');
    const { eq, sql } = await import('drizzle-orm');
    try {
      await registerProjectOnEncounter(project, infoProjectId);
      const db = await getNexusRegistryDb(home);
      const resolvedProject = db.select().from(projectRegistry).get()?.projectPath;

      // A different id encountered at the same path registers; the previous
      // holder (no other live checkout) is parked on its non-path sentinel so
      // exactly one registry row names the path.
      await registerProjectOnEncounter(project, secondId);
      const atPath = db
        .select({ projectId: projectRegistry.projectId })
        .from(projectRegistry)
        .where(eq(projectRegistry.projectPath, resolvedProject ?? project))
        .all();
      expect(atPath).toEqual([{ projectId: secondId }]);
      expect(
        db
          .select({ projectPath: projectRegistry.projectPath })
          .from(projectRegistry)
          .where(eq(projectRegistry.projectId, infoProjectId))
          .get()?.projectPath,
      ).toBe(supersededRegistryPath(infoProjectId));

      // T12470: secondId is registered at `project` (which still exists), so
      // encountering it at `second` only records a candidate — it binds
      // nothing. The binding cases below therefore use a fresh id at `second`.
      await registerProjectOnEncounter(second, secondId);
      expect(
        db
          .select({ projectPath: projectRegistry.projectPath })
          .from(projectRegistry)
          .where(eq(projectRegistry.projectId, secondId))
          .get()?.projectPath,
      ).toBe(resolvedProject ?? project);
      const freshId = `fresh-${secondId}`;
      writeFileSync(
        join(second, '.cleo', 'project-info.json'),
        JSON.stringify({ projectId: freshId }),
      );

      const before = db.select().from(projectRegistry).all();
      db.run(
        sql`CREATE TRIGGER reject_fixture_alias BEFORE INSERT ON nexus_project_id_aliases BEGIN SELECT RAISE(ABORT, 'fixture alias failure'); END`,
      );
      await expect(registerProjectOnEncounter(second, freshId)).rejects.toThrow();
      expect(db.select().from(projectRegistry).all()).toEqual(before);
      db.run(sql`DROP TRIGGER reject_fixture_alias`);

      // A path-derived canonical alias owned by another project keeps its
      // owner; registration still succeeds and never rewrites that owner.
      const { canonicalProjectId } = await import('../nexus/identity.js');
      const canonical = await canonicalProjectId(second);
      db.insert(projectRegistry)
        .values({
          projectId: canonical.id,
          projectHash: 'independent-owner',
          projectPath: join(fixture, 'independent-owner'),
          name: 'Existing canonical alias owner',
        })
        .run();
      const independent = db
        .select()
        .from(projectRegistry)
        .where(eq(projectRegistry.projectId, canonical.id))
        .get();
      await registerProjectOnEncounter(second, freshId);
      expect(
        db.select().from(projectRegistry).where(eq(projectRegistry.projectId, canonical.id)).get(),
      ).toEqual(independent);

      const beforeMalformed = db.select().from(projectRegistry).all();
      writeFileSync(join(second, '.cleo', 'project-info.json'), '{malformed');
      await expect(registerProjectOnEncounter(second, freshId)).rejects.toThrow();
      expect(db.select().from(projectRegistry).all()).toEqual(beforeMalformed);
    } finally {
      await awaitBackgroundOps();
      const { closeAllDatabases } = await import('../store/sqlite.js');
      await closeAllDatabases();
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  for (const cancellation of ['caller', 'teardown'] as const) {
    it(`retains ${cancellation} cancellation and does not publish a late registry row`, async () => {
      const fixture = mkdtempSync(join(tmpdir(), 'cleo-encounter-cancel-'));
      const project = join(fixture, 'project');
      const home = join(fixture, 'global');
      mkdirSync(home);
      const { infoProjectId } = createTempCleoProject(project);
      writeFileSync(
        join(project, '.cleo', 'project-info.json'),
        JSON.stringify({ projectId: infoProjectId, projectHash: 'fixture' }),
      );
      vi.stubEnv('CLEO_HOME', home);
      const controller = new AbortController();
      const execution = createOperationExecutionContext(
        {
          projectRoot: project,
          projectId: infoProjectId,
          actor: 'test',
          operation: 'encounter',
          idempotencyKey: 'cancel',
        },
        { signal: controller.signal },
      );
      const identity = await import('../nexus/identity.js');
      const original = identity.projectPathFingerprint;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      vi.spyOn(identity, 'projectPathFingerprint').mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      });
      const pending = worktreeScope.run(
        { worktreeRoot: project, projectHash: 'fixture', execution },
        () => registerProjectOnEncounter(project, infoProjectId),
      );
      const rejection = expect(pending).rejects.toMatchObject({ code: 'E_OPERATION_CANCELLED' });
      try {
        await entered.promise;
        if (cancellation === 'caller') controller.abort(new Error('caller cancelled'));
        else (await import('../teardown-signal.js')).markShuttingDown();
        release.resolve();
        await rejection;
        expect(existsSync(join(home, 'cleo.db'))).toBe(false);
        expect(pendingBackgroundOpCount()).toBe(0);
      } finally {
        release.resolve();
        execution.close();
        (await import('../teardown-signal.js'))._resetTeardownSignalForTests();
        await pending.catch(() => {});
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  }
});
