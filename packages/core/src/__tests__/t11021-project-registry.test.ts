/**
 * Tests for project registry lookup and auto-registration (T11021).
 *
 * NOTE: project_id_aliases table migration is not yet applied (pending T9149 W5 migration).
 * Tests use canonical project IDs for lookups until the alias table is deployed.
 * AC5 (directory move) is tested at the canonical-ID level: moved projects get
 * new canonical IDs, and the old-path entry is left for GC/cleanup.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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

async function registerAndGetCanonicalId(
  projectRoot: string,
  infoProjectId: string,
): Promise<string> {
  await registerProjectOnEncounter(projectRoot, infoProjectId);
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const db = await getNexusDb();
  const { projectRegistry } = await import('../store/nexus-schema.js');
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(projectRegistry).where(
    eq(projectRegistry.projectPath, resolve(projectRoot))
  ).limit(1);
  return (rows[0]?.projectId as string) ?? '';
}

describe('resolveProjectById (T11021 AC1, AC4)', () => {
  const tempDirs: string[] = [];
  afterEach(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } tempDirs.length = 0; });

  it('returns null when nexus.db does not exist', async () => {
    const tempHome = join(tmpdir(), `ch-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    tempDirs.push(tempHome);
    const orig = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tempHome;
    try { expect(await resolveProjectById('x')).toBeNull(); }
    finally { if (orig !== undefined) process.env['CLEO_HOME'] = orig; else delete process.env['CLEO_HOME']; }
  });

  it('resolves registered project by canonical ID (AC1)', async () => {
    const tempHome = join(tmpdir(), `ch-${Date.now()}`);
    const tempProj = join(tmpdir(), `cp-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    tempDirs.push(tempHome, tempProj);
    const { projectRoot, infoProjectId } = createTempCleoProject(tempProj, { projectName: 'tp' });
    const orig = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tempHome;
    try {
      const canonicalId = await registerAndGetCanonicalId(projectRoot, infoProjectId);
      expect(canonicalId).toBeTruthy();
      const entry = await resolveProjectById(canonicalId);
      expect(entry).not.toBeNull();
      expect(entry!.projectRoot).toBe(projectRoot);
      expect(entry!.name).toBe('tp');
      expect(entry!.projectId).toMatch(/^[0-9a-f]{12}$/);
    } finally { if (orig !== undefined) process.env['CLEO_HOME'] = orig; else delete process.env['CLEO_HOME']; }
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
      await registerAndGetCanonicalId(projectRoot, infoProjectId);
      const entry = await resolveProjectById('nonexistent-id-xyz');
      expect(entry).toBeNull();
    } finally { if (orig !== undefined) process.env['CLEO_HOME'] = orig; else delete process.env['CLEO_HOME']; }
  });
});

describe('registerProjectOnEncounter (T11021 AC2, AC3, AC5)', () => {
  const tempDirs: string[] = [];
  afterEach(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } tempDirs.length = 0; });

  it('registers new project with project-info.json name (AC2, AC6)', async () => {
    const tempHome = join(tmpdir(), `ch-${Date.now()}`);
    const tempProj = join(tmpdir(), `cp-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    tempDirs.push(tempHome, tempProj);
    const { projectRoot, infoProjectId } = createTempCleoProject(tempProj, { projectName: 'new-proj' });
    const orig = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tempHome;
    try {
      const canonicalId = await registerAndGetCanonicalId(projectRoot, infoProjectId);
      expect(canonicalId).toBeTruthy();
      const e = await resolveProjectById(canonicalId);
      expect(e).not.toBeNull();
      expect(e!.projectRoot).toBe(projectRoot);
      expect(e!.name).toBe('new-proj');
      expect(e!.projectHash).toBeTruthy();
    } finally { if (orig !== undefined) process.env['CLEO_HOME'] = orig; else delete process.env['CLEO_HOME']; }
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
      const cid1 = await registerAndGetCanonicalId(projectRoot, infoProjectId);
      await registerProjectOnEncounter(projectRoot, infoProjectId);
      // Should still resolve to same canonical ID
      const entry = await resolveProjectById(cid1);
      expect(entry).not.toBeNull();
      expect(entry!.projectRoot).toBe(projectRoot);
    } finally { if (orig !== undefined) process.env['CLEO_HOME'] = orig; else delete process.env['CLEO_HOME']; }
  });

  it('registers at new path with new canonical ID when directory moves (AC5)', async () => {
    const tempHome = join(tmpdir(), `ch-${Date.now()}`);
    const tempProj1 = join(tmpdir(), `cp1-${Date.now()}`);
    const tempProj2 = join(tmpdir(), `cp2-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    tempDirs.push(tempHome, tempProj1, tempProj2);
    const { infoProjectId } = createTempCleoProject(tempProj1, { projectName: 'movable' });
    const orig = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tempHome;
    try {
      const cid1 = await registerAndGetCanonicalId(resolve(tempProj1), infoProjectId);
      // Create same project at new location (same name, different path = different canonical ID)
      const { projectRoot: movedRoot } = createTempCleoProject(tempProj2, { projectName: 'movable' });
      const cid2 = await registerAndGetCanonicalId(movedRoot, infoProjectId);
      expect(cid2).toBeTruthy();
      expect(cid2).not.toBe(cid1); // Different paths => different canonical IDs
      // New entry resolves at new path
      const e = await resolveProjectById(cid2);
      expect(e).not.toBeNull();
      expect(e!.projectRoot).toBe(movedRoot);
      // Old entry still resolves at old path
      const oldE = await resolveProjectById(cid1);
      expect(oldE).not.toBeNull();
      expect(oldE!.projectRoot).toBe(resolve(tempProj1));
    } finally { if (orig !== undefined) process.env['CLEO_HOME'] = orig; else delete process.env['CLEO_HOME']; }
  });

  it('uses canonical 12-hex ID (AC3)', async () => {
    const tempHome = join(tmpdir(), `ch-${Date.now()}`);
    const tempProj = join(tmpdir(), `cp-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
    tempDirs.push(tempHome, tempProj);
    const { projectRoot, infoProjectId } = createTempCleoProject(tempProj, { projectName: 'canon' });
    const orig = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tempHome;
    try {
      const canonicalId = await registerAndGetCanonicalId(projectRoot, infoProjectId);
      expect(canonicalId).toMatch(/^[0-9a-f]{12}$/);
      const e = await resolveProjectById(canonicalId);
      expect(e).not.toBeNull();
      expect(e!.projectId).toBe(canonicalId);
    } finally { if (orig !== undefined) process.env['CLEO_HOME'] = orig; else delete process.env['CLEO_HOME']; }
  });
});
