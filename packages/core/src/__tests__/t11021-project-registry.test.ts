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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerProjectOnEncounter, resolveProjectById } from '../paths.js';

function createTempCleoProject(dir: string, opts?: { projectName?: string; projectId?: string }) {
  const pid = opts?.projectId ?? `pid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const cleoDir = join(dir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const info: Record<string, string> = { projectId: pid };
  if (opts?.projectName) info.name = opts.projectName;
  writeFileSync(join(cleoDir, 'project-info.json'), JSON.stringify(info));
  writeFileSync(join(cleoDir, 'tasks.db'), '');
  mkdirSync(join(dir, '.git'), { recursive: true });
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
    const { infoProjectId } = createTempCleoProject(tempProj1, { projectName: 'movable' });
    const orig = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tempHome;
    try {
      const id1 = await registerAndGetRegisteredId(resolve(tempProj1), infoProjectId);
      expect(id1).toBe(infoProjectId);
      const hash1 = (await resolveProjectById(id1))!.projectHash;

      // Simulate a move: the SAME project (same stored immutable id, the
      // project-info.json travels with the directory) now lives at a new path.
      const { projectRoot: movedRoot } = createTempCleoProject(tempProj2, {
        projectName: 'movable',
        projectId: infoProjectId,
      });
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
